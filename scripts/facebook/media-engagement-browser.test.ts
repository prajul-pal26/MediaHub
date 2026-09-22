import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readMediaEngagement } from "../../src/server/services/facebook/media-engagement";

const executable = process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRunBrowser = existsSync(executable);
const browserTest = { skip: !canRunBrowser, timeout: 20_000 };
let browser: Browser;
before(async () => {
  if (canRunBrowser) browser = await chromium.launch({ executablePath: executable, headless: true,
    // An unreachable local proxy prevents accidental external traffic even if
    // a future production routing change bypasses the fixture interceptor.
    args: ["--no-sandbox", "--proxy-server=http://127.0.0.1:9"] });
});
after(async () => { await browser?.close(); });

type FixtureResponse = string | { redirect: string };
async function fixture(respond: (url: string) => FixtureResponse | undefined, run: (context: BrowserContext) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, serviceWorkers: "block" });
  try {
    await context.addInitScript("globalThis.__name = (value) => value");
    await context.route("**/*", (route) => route.abort());
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      const goto = page.goto.bind(page);
      page.goto = async (url, options) => {
        // Chromium can bypass route interception on a fulfilled HTTP redirect.
        // Resolve only the fixture's declared redirect chain before navigation,
        // so production observes the true landing URL without external traffic.
        let destination = url;
        for (let redirects = 0; redirects < 5; redirects++) {
          const response = respond(destination);
          if (!response || typeof response === "string") break;
          destination = response.redirect;
        }
        // Install after the production Watch route. Everything is fulfilled
        // locally, including redirects; route.continue never reaches Facebook.
        await page.route("**/*", async (route) => {
          const response = respond(route.request().url());
          try {
            if (response === undefined) await route.abort();
            else if (typeof response === "string") await route.fulfill({ contentType: "text/html", body: response });
            else await route.fulfill({ status: 302, headers: { location: response.redirect } });
          } catch { /* Cancellation can close the fallback during fulfillment. */ }
        });
        return goto(destination, options);
      };
      return page;
    };
    await run(context);
  } finally { await context.close(); }
}

const photo = { postId: "1516804617131938", url: "https://www.facebook.com/photo.php?fbid=1516804617131938", contentType: "posts" as const };
const reel = { postId: "2076849902969631", url: "https://www.facebook.com/reel/2076849902969631/", contentType: "reels" as const };
const watchUrl = `https://www.facebook.com/watch/?v=${reel.postId}`;
const documentHtml = (body: string, payloads: unknown[] = []) => `<!doctype html><html><body>${body}
  ${payloads.map((payload) => `<script type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`).join("")}
  <script>document.body.dataset.actionClicks='0';for(const el of document.querySelectorAll('[data-action]'))el.addEventListener('click',()=>document.body.dataset.actionClicks=String(+document.body.dataset.actionClicks+1));</script>
  </body></html>`;
const reelHtml = documentHtml('<button aria-label="Like" data-action>147</button><button aria-label="Share" data-action>6</button><textarea id="comment-draft">Unsent draft</textarea>');
const watchPayload = [
  { post_id: "1516438623835204", video: { id: reel.postId }, feedback: { id: "owner-feedback" } },
  { id: "owner-feedback", reaction_count: { count: 147 }, reshares: { count: 6 }, top_reactions: { edges: [
    { node: { localized_name: "Like" }, reaction_count: 142 }, { node: { localized_name: "Love" }, reaction_count: 5 },
  ] } },
];
const assertOriginal = async (context: BrowserContext, original: Page) => {
  assert.equal(original.isClosed(), false);
  assert.equal(original.url(), reel.url);
  assert.equal(await original.locator("#comment-draft").inputValue(), "Unsent draft");
  assert.equal(await original.locator("body").getAttribute("data-action-clicks"), "0");
  assert.deepEqual(context.pages(), [original]);
};

test("embedded owner Photo feedback exposes exact zero shares without clicking action buttons", browserTest, async () => {
  const html = documentHtml('<button aria-label="Like" data-action>13</button><button aria-label="Share" data-action>Share</button>', [
    { __typename: "Photo", id: photo.postId, feedback: { id: "photo-feedback" } },
    { id: "photo-feedback", reaction_count: { count: 13 }, share_count: { count: 0 }, top_reactions: { edges: [{ node: { localized_name: "Like" }, reaction_count: 13 }] } },
  ]);
  await fixture((url) => url === photo.url ? html : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(photo.url);
    const result = await readMediaEngagement(page, photo);
    assert.equal(result.status, "complete");
    assert.equal(result.totalReactions, 13);
    assert.equal(result.shares, 0);
    assert.equal(result.reactions.like, 13);
    assert.equal(result.reactions.love, 0);
    assert.equal(await page.locator("body").getAttribute("data-action-clicks"), "0");
    assert.deepEqual(context.pages(), [page]);
  });
});

test("Reel Watch fallback reads owner counters and preserves the original comment page", browserTest, async () => {
  await fixture((url) => url === reel.url ? reelHtml : url === watchUrl ? documentHtml('<button aria-label="Like" data-action>147</button>', watchPayload) : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(reel.url);
    const result = await readMediaEngagement(page, reel);
    assert.equal(result.status, "complete");
    assert.equal(result.totalReactions, 147);
    assert.equal(result.shares, 6);
    assert.deepEqual(result.reactions, { like: 142, love: 5, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 });
    await assertOriginal(context, page);
  });
});

test("Watch redirects to another media ID are rejected without contaminating original counts", browserTest, async () => {
  const other = "https://www.facebook.com/watch/?v=999";
  await fixture((url) => url === reel.url ? reelHtml : url === watchUrl ? { redirect: other } : url === other ? documentHtml('<button aria-label="Like">999</button><button aria-label="Share">999</button>') : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(reel.url);
    const result = await readMediaEngagement(page, reel);
    assert.equal(result.status, "partial");
    assert.equal(result.totalReactions, 147);
    assert.equal(result.shares, 6);
    assert.deepEqual(result.reactions, {});
    await assertOriginal(context, page);
  });
});

test("Watch redirects to the same native Videos or live Watch media retain their owner counts", browserTest, async () => {
  for (const nativeUrl of [`https://www.facebook.com/arunkumarmlabjp/videos/${reel.postId}/`, `https://www.facebook.com/watch/live/?v=${reel.postId}`]) {
    await fixture((url) => url === reel.url ? reelHtml : url === watchUrl ? { redirect: nativeUrl } : url === nativeUrl ? documentHtml('<button aria-label="Like" data-action>147</button>', watchPayload) : undefined, async (context) => {
      const page = await context.newPage(); await page.goto(reel.url);
      const result = await readMediaEngagement(page, reel);
      assert.equal(result.status, "complete", nativeUrl);
      assert.equal(result.totalReactions, 147);
      assert.equal(result.shares, 6);
      assert.equal(result.reactions.like, 142);
      assert.equal(result.reactions.love, 5);
      await assertOriginal(context, page);
    });
  }
});

test("Watch redirects to a different native Videos media are rejected", browserTest, async () => {
  const other = "https://www.facebook.com/arunkumarmlabjp/videos/999/";
  await fixture((url) => url === reel.url ? reelHtml : url === watchUrl ? { redirect: other } : url === other ? documentHtml('<button aria-label="Like">999</button><button aria-label="Share">999</button>') : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(reel.url);
    const result = await readMediaEngagement(page, reel);
    assert.equal(result.status, "partial");
    assert.equal(result.totalReactions, 147);
    assert.equal(result.shares, 6);
    assert.deepEqual(result.reactions, {});
    await assertOriginal(context, page);
  });
});

test("aborting Watch extraction closes only its temporary page", browserTest, async () => {
  let watchRequested!: () => void;
  const requested = new Promise<void>((resolve) => { watchRequested = resolve; });
  await fixture((url) => {
    if (url === reel.url) return reelHtml;
    if (url === watchUrl) { watchRequested(); return documentHtml("<p>The media is still loading.</p>"); }
    return undefined;
  }, async (context) => {
    const page = await context.newPage(); await page.goto(reel.url);
    const controller = new AbortController();
    const rejected = assert.rejects(readMediaEngagement(page, reel, controller.signal));
    await requested;
    controller.abort(new Error("Fixture cancelled"));
    await rejected;
    await assertOriginal(context, page);
  });
});

test("a freshly opened reaction dialog replaces its older aggregate snapshot", browserTest, async () => {
  const html = documentHtml(`<button aria-label="Like" data-action>12</button><button aria-label="Share" data-action>0</button>
    <button aria-label="See who reacted" id="inspector">See who reacted</button>
    <script>document.querySelector('#inspector').onclick=()=>{const panel=document.createElement('div');panel.id='counts';panel.setAttribute('role','dialog');panel.innerHTML='<div role="tab" aria-label="All">13</div><div role="tab" aria-label="Show 13 people who reacted with Like">13</div>';document.body.append(panel)};document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#counts')?.remove()});</script>`);
  await fixture((url) => url === photo.url ? html : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(photo.url);
    const result = await readMediaEngagement(page, photo);
    assert.equal(result.status, "complete");
    assert.equal(result.totalReactions, 13);
    assert.equal(result.reactions.like, 13);
    assert.equal(await page.locator("#counts").count(), 0);
    assert.equal(await page.locator("body").getAttribute("data-action-clicks"), "0");
  });
});

test("reaction dialog polling waits for a delayed nonzero category before inferring missing types", browserTest, async () => {
  const html = documentHtml(`<button aria-label="Like" data-action>13</button><button aria-label="Share" data-action>0</button>
    <button aria-label="See who reacted" id="inspector">See who reacted</button>
    <script>document.querySelector('#inspector').onclick=()=>{const panel=document.createElement('div');panel.id='counts';panel.setAttribute('role','dialog');panel.innerHTML='<div role="tab" aria-label="Show 13 people who reacted with All">All</div><div role="tab" aria-label="Show 10 people who reacted with Like">10</div>';document.body.append(panel);setTimeout(()=>{const love=document.createElement('div');love.setAttribute('role','tab');love.setAttribute('aria-label','Show 3 people who reacted with Love');love.innerText='3';panel.append(love)},300)};document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#counts')?.remove()});</script>`);
  await fixture((url) => url === photo.url ? html : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(photo.url);
    const start = Date.now();
    const result = await readMediaEngagement(page, photo);
    assert.ok(Date.now() - start >= 250, "wait for Love rather than returning an incomplete first-tab snapshot");
    assert.equal(result.status, "complete");
    assert.equal(result.totalReactions, 13);
    assert.equal(result.reactions.like, 10);
    assert.equal(result.reactions.love, 3);
    assert.equal(result.reactions.care, 0);
    assert.equal(await page.locator("#counts").count(), 0);
    assert.equal(await page.locator("body").getAttribute("data-action-clicks"), "0");
  });
});

test("a contradictory zero aria label cannot replace visible rounded reactions in Watch fallback", browserTest, async () => {
  const initial = documentHtml('<button aria-label="Like" data-action>1,807</button><button aria-label="Share" data-action>60</button><textarea id="comment-draft">Unsent draft</textarea>');
  const watch = documentHtml(`<button aria-label="Like" data-action>1,807</button><button aria-label="Share" data-action>60</button>
    <button aria-label="Like: 1.7K people" id="inspector">1.7K</button>
    <script>document.querySelector('#inspector').onclick=()=>{const panel=document.createElement('div');panel.id='counts';panel.setAttribute('role','dialog');panel.innerHTML='<div role="tab" aria-label="Show 1,807 people who reacted with All">All</div><div role="tab" aria-label="Show 0 people who reacted with Like">1.7K</div><div role="tab" aria-label="Show 55 people who reacted with Love">55</div><div role="tab" aria-label="Show 3 people who reacted with Care">3</div>';document.body.append(panel)};document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#counts')?.remove()});</script>`);
  await fixture((url) => url === reel.url ? initial : url === watchUrl ? watch : undefined, async (context) => {
    const page = await context.newPage(); await page.goto(reel.url);
    const result = await readMediaEngagement(page, reel);
    assert.equal(result.status, "partial");
    assert.equal(result.totalReactions, 1807);
    assert.equal(result.shares, 60);
    assert.equal(result.reactions.like, 1700);
    assert.equal(result.reactions.love, 55);
    assert.equal(result.reactions.care, 3);
    assert.equal(result.reactions.haha, undefined);
    assert.equal(result.approximate, true);
    await assertOriginal(context, page);
  });
});
