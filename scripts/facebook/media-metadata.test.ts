import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { readMediaMetadata, observedPublishedTime } from "../../src/server/services/facebook/media-metadata";
import { FbBrowserAuthError } from "../../src/server/services/facebook/browser-fetcher";

const executable = process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRunBrowser = existsSync(executable);
let browser: Browser;
before(async () => { if (canRunBrowser) browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  try {
    // tsx preserves local function names with an identity helper. The production
    // compiler does not add it, but serialized fixture callbacks need it here.
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent(html);
    await run(page);
  } finally { await page.close(); }
}

test("only observed absolute dates are accepted; timezone-free tooltip labels stay unchanged", () => {
  const date = "Sunday, September 6, 2026 at 9:30 AM";
  assert.equal(observedPublishedTime(date), date);
  assert.equal(observedPublishedTime("2026-09-06T09:30:00+05:30"), "2026-09-06T09:30:00+05:30");
  for (const invalid of ["2h", "Yesterday", "September 6", "p\u034forso2d", "2026-99-99", "", null]) assert.equal(observedPublishedTime(invalid), null);
});

test("native publication dates do not depend on captions or timestamp hover controls", { skip: !canRunBrowser }, async () => {
  await fixture('<script type="application/json">{"__typename":"Photo","id":"123","created_time":1788695600}</script><span dir="auto">Short</span>', async (page) => {
    assert.deepEqual(await readMediaMetadata(page, { postId: "123", contentType: "posts" }), { publishedTime: new Date(1788695600000).toISOString() });
  });
});

test("caption expansion below y1000 uses the actual viewport and awaits asynchronous text", { skip: !canRunBrowser }, async () => {
  const full = "The opening caption sentence continues with the complete second paragraph and all original hashtags.";
  await fixture('<span id="caption" dir="auto" style="position:absolute;top:1110px;left:30px;width:900px">The opening caption sentence… <div id="more" role="button" tabindex="0">See more</div></span>', async (page) => {
    await page.evaluate((full) => {
      document.querySelector("#more")!.addEventListener("click", () => setTimeout(() => { document.querySelector("#caption")!.textContent = full; }, 250));
    }, full);
    const started = Date.now();
    const metadata = await readMediaMetadata(page);
    assert.equal(metadata.text, full);
    assert.ok(Date.now() - started >= 200, "the old truncated DOM must not be returned synchronously");
  });
});

test("only an expansion-owned caption dialog is closed; the original viewer stays open", { skip: !canRunBrowser }, async () => {
  const full = "The initial caption includes its complete details, extra lines and original hashtags in the expanded panel.";
  await fixture('<main role="dialog" id="viewer"><span dir="auto">The initial caption… <div role="button" id="more" tabindex="0">See more</div></span></main>', async (page) => {
    await page.evaluate((full) => {
      document.querySelector("#more")!.addEventListener("click", () => {
        setTimeout(() => {
          const panel = document.createElement("div"); panel.id = "caption-panel"; panel.setAttribute("role", "dialog");
          panel.style.cssText = "position:fixed;inset:0;background:white;z-index:100";
          const caption = document.createElement("div"); caption.setAttribute("data-ad-preview", "message"); caption.textContent = full;
          const close = document.createElement("button"); close.setAttribute("aria-label", "Close"); close.textContent = "Close"; close.addEventListener("click", () => panel.remove());
          panel.append(caption, close); document.body.append(panel);
        }, 180);
      });
    }, full);
    assert.equal((await readMediaMetadata(page)).text, full);
    assert.equal(await page.locator("#caption-panel").count(), 0);
    assert.equal(await page.locator("#viewer").isVisible(), true);
  });
});

test("login prompts are reported without clicking or dismissing them", { skip: !canRunBrowser }, async () => {
  await fixture('<span dir="auto">Actual caption still visible behind login… <div role="button">See more</div></span><div role="dialog"><input type="password"><button aria-label="Close">Close</button></div>', async (page) => {
    await assert.rejects(() => readMediaMetadata(page), FbBrowserAuthError);
    assert.equal(await page.locator('input[type="password"]').isVisible(), true);
  });
});

test("comment cards, warnings, image alt and off-screen reels do not become the caption", { skip: !canRunBrowser }, async () => {
  await fixture('<h1>Profile Name Is Not The Caption</h1><span dir="auto">The active photo caption.</span><span dir="auto">"Most relevant" is selected, so some comments may have been filtered out.</span><div role="article" aria-label="Comment by Example"><span dir="auto">An unrelated comment is longer than the active photo caption and must be excluded.</span></div><img alt="A long generated image description that must not be used as the caption"><span dir="auto" style="position:absolute;top:1400px">The next reel has a much longer caption that is outside the current viewport and must be excluded.</span>', async (page) => {
    assert.deepEqual(await readMediaMetadata(page), { text: "The active photo caption." });
  });
});

test("an absolute date comes from the current caption's timestamp tooltip without timezone guessing", { skip: !canRunBrowser }, async () => {
  const observed = "Sunday, September 6, 2026 at 9:30 AM";
  await fixture('<section><span dir="auto">The active photo has an observable published date.</span><a id="time" href="https://www.facebook.com/example/posts/123" aria-label="2h">2h</a></section>', async (page) => {
    await page.evaluate((observed) => {
      document.querySelector("#time")!.addEventListener("mouseenter", () => {
        const tip = document.createElement("div"); tip.setAttribute("role", "tooltip"); tip.textContent = observed; document.body.append(tip);
      });
    }, observed);
    assert.equal((await readMediaMetadata(page)).publishedTime, observed);
  });
});

test("failed caption-panel restoration preserves the extracted caption and blocks further clicks", { skip: !canRunBrowser }, async () => {
  const full = "The initial caption includes all of the successfully retrieved details in this expansion.";
  await fixture('<main role="dialog" id="viewer"><span dir="auto">The initial caption… <div role="button" id="more" tabindex="0">See more</div></span></main>', async (page) => {
    await page.evaluate((full) => {
      document.querySelector("#more")!.addEventListener("click", () => {
        const panel = document.createElement("div"); panel.setAttribute("role", "dialog"); panel.style.cssText = "position:fixed;inset:0;background:white";
        const caption = document.createElement("div"); caption.setAttribute("data-ad-preview", "message"); caption.textContent = full;
        panel.append(caption); document.body.append(panel);
      });
    }, full);
    await assert.rejects(() => readMediaMetadata(page), (error: unknown) => error instanceof Error && "partialMetadata" in error && "mediaBlocked" in error &&
      (error.partialMetadata as { text?: string }).text === full && error.mediaBlocked === true);
    assert.equal(await page.locator("#viewer").count(), 1);
  });
});
