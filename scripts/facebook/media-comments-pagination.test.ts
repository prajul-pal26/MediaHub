import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { advanceCommentSection, selectCommentView, threadControlPattern } from "../../src/server/services/facebook/media-comments";

const executable = process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRunBrowser = existsSync(executable);
let browser: Browser;

before(async () => {
  if (canRunBrowser) browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

test("pagination recognizes a virtualized replacement with an unchanged visible row count", { skip: !canRunBrowser }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent([
      '<article role="article" aria-label="Comment by Example" id="comment"><a href="https://www.facebook.com/photo.php?fbid=100&comment_id=1">1h</a><span dir="auto">First comment</span></article>',
      '<button role="button" id="more">View more comments</button>',
    ].join(""));
    await page.evaluate(() => {
      document.querySelector("#more")!.addEventListener("click", () => {
        const comment = document.querySelector("#comment")!;
        comment.innerHTML = '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=2">1h</a><span dir="auto">Next comment</span>';
      });
    });
    const result = await advanceCommentSection(page, { withReplies: true, expandThreads: true, waitMs: 800 });
    assert.deepEqual(result, { pending: true, clicked: true, changed: true, kind: "thread" });
  } finally {
    await page.close();
  }
});

test("the native ordering button switches a Reel from Most relevant to Newest only", { skip: !canRunBrowser }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent('<button id="order">Most relevant</button>');
    await page.evaluate(() => {
      document.querySelector("#order")!.addEventListener("click", () => {
        if (document.querySelector("#all")) return;
        const newest = document.createElement("button");
        newest.id = "newest";
        newest.textContent = "Newest Show all comments with the newest comment first.";
        newest.addEventListener("click", () => {
          document.querySelector("#order")!.textContent = "Newest";
          newest.remove();
        });
        document.body.append(newest);
      });
    });
    assert.deepEqual(await selectCommentView(page), { view: "newest", changed: true });
  } finally {
    await page.close();
  }
});

test("the collector switches an already-open All comments view to Newest", { skip: !canRunBrowser }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent('<button id="order">All comments</button>');
    await page.evaluate(() => {
      document.querySelector("#order")!.addEventListener("click", () => {
        if (document.querySelector("#newest")) return;
        const newest = document.createElement("button");
        newest.id = "newest";
        newest.textContent = "Newest Show all comments with the newest comment first.";
        newest.addEventListener("click", () => {
          document.querySelector("#order")!.textContent = "Newest";
          newest.remove();
        });
        document.body.append(newest);
      });
    });
    assert.deepEqual(await selectCommentView(page), { view: "newest", changed: true });
  } finally {
    await page.close();
  }
});

test("expanding a hidden-comment control reports the hidden provenance", { skip: !canRunBrowser }, async () => {
  const page = await browser.newPage();
  try {
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent([
      '<article role="article" aria-label="Comment by Example" id="comment"><a href="https://www.facebook.com/photo.php?fbid=100&comment_id=1">1h</a><span dir="auto">First comment</span></article>',
      '<button role="button" id="hidden">View 1 hidden comment</button>',
    ].join(""));
    await page.evaluate(() => {
      document.querySelector("#hidden")!.addEventListener("click", () => {
        const comment = document.querySelector("#comment")!;
        comment.innerHTML = '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=2">1h</a><span dir="auto">Hidden comment</span>';
      });
    });
    assert.deepEqual(await advanceCommentSection(page, { withReplies: true, expandThreads: true, waitMs: 800 }), {
      pending: true, clicked: true, changed: true, kind: "thread", revealedHidden: true,
    });
  } finally {
    await page.close();
  }
});

test("pagination recognizes next-page and counted-more-comment controls without clicking a bare count", () => {
  const roots = threadControlPattern(false);
  assert.equal(roots.test("View next comments"), true);
  assert.equal(roots.test("1 more comments"), true);
  assert.equal(roots.test("987 comments"), false);
});
