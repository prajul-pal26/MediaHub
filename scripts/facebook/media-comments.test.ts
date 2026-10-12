import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { advanceCommentSection, classifyCommentContent, commentCollectionBudgetMs, expandCommentSectionBatch, commentCompletionReason, commentHasText, commentIdentity, commentImages, countCommentRows, mergeComment, normalizeComment, readNewestPanelReportedCount, scanCommentPage, settleCommentSection, threadComments, trimCommentText, type RawComment } from "../../src/server/services/facebook/media-comments";
import { summarizeFbComments, type FbBrowserComment } from "../../src/server/services/facebook/browser-fetcher";

test("reply IDs never collapse into a root comment, regardless of parameter order", () => {
  for (const query of ["comment_id=11&reply_comment_id=22", "reply_comment_id=22&comment_id=11"]) {
    assert.deepEqual(commentIdentity(`https://www.facebook.com/reel/123/?${query}`), { id: "22", parentId: "11" });
  }
  assert.deepEqual(commentIdentity("https://www.facebook.com/photo.php?fbid=123&comment_id=11"), { id: "11", parentId: null });
  assert.equal(commentIdentity("https://www.facebook.com/example?comment_id=Y29tbWVudDoxMTEx"), null);
  assert.equal(commentIdentity("https://example.test/photo.php?comment_id=11"), null);
  assert.equal(commentIdentity("http://www.facebook.com/photo.php?comment_id=11"), null);
});

const c = (id: string, parentId: string | null = null): FbBrowserComment => ({ id, parentId, authorName: "Example", text: "हिंदी reply", depth: parentId ? 1 : 0, likeCount: 0, replyCount: 0 });
test("reaction SVGs and duplicate GIF proxy links are not comment attachments", () => {
  const original = "https://media3.giphy.com/media/example/giphy.gif";
  assert.deepEqual(commentImages(["data:image/svg+xml,icon", original + "?fbclid=tracking", "https://external.fbcdn.net/image?url=" + encodeURIComponent(original), "javascript:alert(1)"]), [original]);
});
test("reordered virtualized rows thread by actual IDs, preserving nested and orphan replies", () => {
  const result = threadComments([c("3", "2"), c("2", "1"), c("5", "missing"), c("1"), c("4"), c("2", "1")]);
  assert.deepEqual(result.map((x) => x.id), ["5", "1", "4"]);
  const root = result.find((x) => x.id === "1")!;
  assert.equal(root.replies![0].id, "2");
  assert.equal(root.replies![0].replies![0].id, "3");
  assert.equal(root.depth, 0);
  assert.equal(root.replies![0].depth, 1);
  assert.equal(root.replies![0].replies![0].depth, 2);
  assert.equal(root.replyCount, 1);
  assert.equal(result[0].parentId, "missing");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("requested comment limit counts roots and replies together, and corrupt parents cannot form cycles", () => {
  const limited = threadComments([c("1"), c("2", "1"), c("3", "1")], 2);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].replies!.length, 1);
  assert.equal(limited[0].replyCount, 1, "replyCount describes returned children after the total-row limit");
  assert.doesNotThrow(() => JSON.stringify(threadComments([c("1", "2"), c("2", "1")])));
});

test("reported/requested counts do not imply completion while an expansion is unresolved", () => {
  const state = { found: 5, limit: 0, reported: 5, pendingExpansion: true, unfiltered: true, idle: 3 };
  assert.equal(commentCompletionReason(state), null);
  assert.equal(commentCompletionReason({ ...state, limit: 5 }), null);
  assert.equal(commentCompletionReason({ ...state, pendingExpansion: false }), "reported-count-reached");
  assert.equal(commentCompletionReason({ ...state, limit: 5, pendingExpansion: false }), "requested-limit");
  assert.equal(commentCompletionReason({ ...state, pendingExpansion: false, reported: null }), "visible-comments-exhausted");
  assert.equal(commentCompletionReason({ ...state, pendingExpansion: false, reported: null, unfiltered: false }), null);
});

test("a Newest tray count gives a large thread its proportional collection budget when the raw badge is absent", () => {
  assert.equal(commentCollectionBudgetMs(null, 1469), 600_000);
  assert.equal(commentCollectionBudgetMs(null, null), 180_000);
  assert.equal(commentCollectionBudgetMs(50, 10), 180_000, "the Newest tray count is the collection target");
});

const raw = (over: Partial<RawComment> = {}): RawComment => ({
  url: "https://www.facebook.com/photo.php?fbid=100&comment_id=7", parentUrl: null, label: "Comment by Example",
  author: "Example", authorUrl: null, avatar: null, badge: null,
  text: "", emoji: [], images: [], stickers: [], gifs: [], video: null, time: "1h", reaction: null,
  fallbackKey: "Example||Comment by Example", ...over,
});

test("wordless comments keep their identity as emoji, GIF, sticker or video instead of exporting blank", () => {
  const emoji = classifyCommentContent({ text: "", emoji: ["😂", "🔥"] });
  assert.equal(emoji.contentKind, "emoji");
  assert.equal(emoji.text, "😂🔥", "an image-rendered emoji comment still has to say what was posted");
  assert.equal(emoji.hasText, false);

  assert.equal(classifyCommentContent({ text: "", gifs: ["https://media.giphy.com/x.gif"] }).contentKind, "gif");
  assert.equal(classifyCommentContent({ text: "", stickers: ["https://scontent.test/stickers/1.png"] }).contentKind, "sticker");
  assert.equal(classifyCommentContent({ text: "", video: "https://video.test/v.mp4" }).contentKind, "video");
  assert.equal(classifyCommentContent({ text: "", images: ["https://scontent.test/p.jpg"] }).contentKind, "photo");
  assert.deepEqual(classifyCommentContent({ text: "" }), { text: "", hasText: false, contentKind: "empty", contentKinds: ["empty"] });

  // Text wins the primary kind, but the attachment must stay visible alongside it.
  const mixed = classifyCommentContent({ text: "Congrats! 🎉", gifs: ["https://media.giphy.com/y.gif"] });
  assert.equal(mixed.contentKind, "text");
  assert.deepEqual(mixed.contentKinds, ["text", "emoji", "gif"]);
});

test("emoji, spacing and Facebook's own affordances are trimmed without deleting real words", () => {
  assert.equal(trimCommentText("  Nice   post  See more "), "Nice post");
  assert.equal(trimCommentText("Great work · Edited"), "Great work");
  assert.equal(commentHasText("😂😂😂"), false, "an emoji-only body is not text");
  assert.equal(commentHasText("👍 thanks"), true);
  assert.equal(commentHasText("   "), false);
  assert.equal(commentHasText("..."), true, "punctuation is still something the author typed");
});

test("a comment permalinked on /videos/ or /watch is counted, not silently dropped", () => {
  for (const url of [
    "https://www.facebook.com/pagename/videos/123/?comment_id=55",
    "https://www.facebook.com/watch/?v=123&comment_id=55",
  ]) {
    assert.equal(normalizeComment(raw({ url }))?.id, "55", `${url} must resolve a comment ID`);
  }
});

test("a card Facebook renders without a permalink stays countable under a marked derived ID", () => {
  const derived = normalizeComment(raw({ url: null, text: "🔥", fallbackKey: "Example|🔥|Comment by Example" }))!;
  assert.equal(derived.idSource, "derived");
  assert.match(derived.id, /^d[0-9a-z]+$/);
  assert.equal(derived.contentKind, "emoji");
  // Stable across passes so a re-save merges instead of duplicating the row.
  assert.equal(derived.id, normalizeComment(raw({ url: null, text: "🔥", fallbackKey: "Example|🔥|Comment by Example" }))!.id);
  assert.notEqual(derived.id, normalizeComment(raw({ url: null, text: "🔥", fallbackKey: "Other|🔥|Comment by Other" }))!.id);
  assert.equal(normalizeComment(raw({ url: null, author: "", text: "", fallbackKey: "||" })), null, "an empty card is not a comment");
});

test("re-reading a comment never loses text or attachments an earlier pass established", () => {
  const first = normalizeComment(raw({ text: "A long comment with its full ending", images: ["https://scontent.test/a.jpg"] }))!;
  const collapsed = normalizeComment(raw({ text: "A long comment", gifs: ["https://media.giphy.com/z.gif"] }))!;
  const merged = mergeComment(first, collapsed);
  assert.equal(merged.text, "A long comment with its full ending", "a collapsed re-read must not truncate stored text");
  assert.equal(merged.images!.length, 2);
  assert.deepEqual(merged.contentKinds, ["text", "photo", "gif"]);
  assert.equal(merged.idSource, "permalink");
});

test("an exhausted unfiltered list is complete even when Facebook reports more than it served", () => {
  const state = { found: 3, limit: 0, reported: 5, pendingExpansion: false, unfiltered: true, idle: 3 };
  assert.equal(commentCompletionReason(state), "visible-comments-exhausted");
  assert.equal(commentCompletionReason({ ...state, unfiltered: false }), null, "a known filtered list is still incomplete");
  assert.equal(commentCompletionReason({ ...state, idle: 2 }), null, "one quiet pass is not exhaustion");
  assert.equal(commentCompletionReason({ ...state, pendingExpansion: true }), null);
});

test("the retained row count includes every nested reply", () => {
  assert.equal(countCommentRows(threadComments([c("1"), c("2", "1"), c("3", "2"), c("4")])), 4);
});

test("comment summaries keep visible roots, hidden roots and replies distinct", () => {
  const comments = threadComments([
    { ...c("visible"), isHidden: false },
    { ...c("hidden"), isHidden: true, hiddenSource: "revealed_by_hidden_control" },
    { ...c("reply", "visible") },
  ]);
  assert.deepEqual(summarizeFbComments(comments), {
    totalCount: 3,
    topLevelCount: 2,
    visibleTopLevelCount: 1,
    hiddenTopLevelCount: 1,
    replyCount: 1,
    hiddenReplyCount: 0,
    hiddenCount: 1,
  });
});

const executable = process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRunBrowser = existsSync(executable);
let browser: Browser;
before(async () => { if (canRunBrowser) browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });
async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    // Identity helper for callbacks serialized by the tsx test compiler.
    await page.evaluate("globalThis.__name = (value) => value");
    await page.setContent(html);
    await run(page);
  } finally { await page.close(); }
}
const rootHtml = '<article role="article" aria-label="Comment by Example"><a href="https://www.facebook.com/profile.php?id=1">Example</a><a href="https://www.facebook.com/photo.php?fbid=100&comment_id=1">1h</a><span dir="auto">Original comment text</span></article>';

test("the panel total is read only from the active Newest tray", { skip: !canRunBrowser }, async () => {
  const html = '<main><button>Newest</button><span>191 comments</span></main>'
    + '<div role="dialog"><button>Newest</button><span>4 of 37 comments</span></div>';
  await fixture(html, async (page) => {
    assert.equal(await readNewestPanelReportedCount(page), 37);
    await page.locator('[role="dialog"] span').evaluate((node) => { node.textContent = '4 of 37 comments 2 of 9 comments'; });
    assert.equal(await readNewestPanelReportedCount(page), null, "competing tray totals stay retryable");
    await page.locator('[role="dialog"] span').evaluate((node) => { node.textContent = '4 of 37 comments'; });
    await page.locator('main span').evaluate((node) => { node.textContent = '6 of 191 comments'; });
    assert.equal(await readNewestPanelReportedCount(page), null, "a stale second panel total is never selected by position");
  });
});

test("the panel reader waits for Facebook's delayed Newest total", { skip: !canRunBrowser }, async () => {
  await fixture('<main><button>Newest</button><span id="count"></span></main>', async (page) => {
    await page.evaluate(() => { setTimeout(() => { document.querySelector('#count')!.textContent = '6 of 843 comments'; }, 650); });
    assert.equal(await readNewestPanelReportedCount(page), 843);
  });
});

test("reply pagination waits for a new reply ID and does not confuse a tracking URL change with progress", { skip: !canRunBrowser }, async () => {
  await fixture(rootHtml + '<button role="button" id="more">View 1 reply</button>', async (page) => {
    await page.evaluate(() => {
      document.querySelector("#more")!.addEventListener("click", () => {
        const old = document.querySelector<HTMLAnchorElement>('a[href*="comment_id"]')!;
        old.href += "&tracking=changed";
        setTimeout(() => {
          const reply = document.createElement("div"); reply.setAttribute("role", "article"); reply.setAttribute("aria-label", "Reply by Example");
          reply.innerHTML = '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=1&reply_comment_id=2">1h</a><span dir="auto">The complete reply</span>';
          document.body.append(reply); document.querySelector("#more")!.remove();
        }, 200);
      });
    });
    const started = Date.now();
    assert.deepEqual(await advanceCommentSection(page, { withReplies: true, expandThreads: true, waitMs: 1000 }), { pending: true, clicked: true, changed: true, kind: "thread" });
    assert.ok(Date.now() - started >= 150);
  });
});

test("a successful pagination click with no new data remains an unresolved partial expansion", { skip: !canRunBrowser }, async () => {
  await fixture(rootHtml + '<button role="button">View more comments</button>', async (page) => {
    const expansion = await advanceCommentSection(page, { withReplies: true, expandThreads: true, waitMs: 100 });
    assert.deepEqual(expansion, { pending: true, clicked: true, changed: false, kind: "thread" });
    assert.equal(commentCompletionReason({ found: 1, reported: 1, limit: 0, pendingExpansion: expansion.pending, unfiltered: true, idle: 3 }), null);
  });
});

test("an intercepted reply control cannot turn a partial response into a complete count", { skip: !canRunBrowser }, async () => {
  await fixture(rootHtml + '<button role="button">View 1 reply</button><div style="position:fixed;inset:0;z-index:100;background:white">Blocking panel</div>', async (page) => {
    const expansion = await advanceCommentSection(page, { withReplies: true, expandThreads: true, waitMs: 100 });
    assert.deepEqual(expansion, { pending: true, clicked: false, changed: false, kind: "thread" });
    assert.equal(commentCompletionReason({ found: 1, reported: 1, limit: 0, pendingExpansion: expansion.pending, unfiltered: true, idle: 3 }), null);
  });
});

test("long comment bodies expand before satisfying the requested row count", { skip: !canRunBrowser }, async () => {
  await fixture('<article role="article" aria-label="Comment by Example"><a href="https://www.facebook.com/photo.php?fbid=100&comment_id=1">1h</a><span dir="auto" id="body">A long comment begins…</span><button id="more" role="button">See more</button></article>', async (page) => {
    await page.evaluate(() => {
      document.querySelector("#more")!.addEventListener("click", () => {
        document.querySelector("#more")!.textContent = "See less";
        setTimeout(() => { document.querySelector("#body")!.textContent = "A long comment begins and now contains its full original ending."; }, 180);
      });
    });
    const started = Date.now();
    assert.deepEqual(await advanceCommentSection(page, { withReplies: true, expandThreads: false, commentIds: ["1"], waitMs: 1000 }), { pending: true, clicked: true, changed: true, kind: "text" });
    assert.ok(Date.now() - started >= 140, "changing only See more to See less must not finish expansion");
    assert.match(await page.locator("#body").innerText(), /full original ending/);
  });
});

const card = (label: string, body: string, id = "1") =>
  `<div role="article" aria-label="${label}"><a href="https://www.facebook.com/profile.php?id=9">Author</a>` +
  `<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=${id}">2h</a>${body}</div>`;

test("wordless cards are scraped and labelled so the scraped count can reach the reported count", { skip: !canRunBrowser }, async () => {
  const html = [
    card("Comment by Author", '<span dir="auto">A written reply</span>', "1"),
    card("Comment by Author", '<img alt="😂" src="https://static.xx.fbcdn.net/images/emoji.php/v9/t1/1/16/1f602.png">', "2"),
    card("Comment by Author", '<img alt="" src="https://media3.giphy.com/media/abc/giphy.gif">', "3"),
    card("Comment by Author", '<img alt="" src="https://scontent.test/stickers/pack/9.png">', "4"),
    card("Comment by Author", "<video src=\"https://video.test/clip.mp4\"></video>", "5"),
  ].join("");
  await fixture(html, async (page) => {
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(scan.comments.length, 5, "every rendered card is a comment Facebook counted");
    const byId = new Map(scan.comments.map((row) => [normalizeComment(row)!.id, normalizeComment(row)!]));
    assert.equal(byId.get("1")!.contentKind, "text");
    assert.equal(byId.get("2")!.contentKind, "emoji");
    assert.equal(byId.get("2")!.text, "😂", "the emoji itself is the content of an emoji-only comment");
    assert.equal(byId.get("3")!.contentKind, "gif");
    assert.equal(byId.get("4")!.contentKind, "sticker");
    assert.equal(byId.get("5")!.contentKind, "video");
    assert.equal(scan.signature.articles, 5);
    assert.equal(scan.signature.links, 5);
  });
});

test("a comment permalinked through /videos/ survives the DOM scan", { skip: !canRunBrowser }, async () => {
  const html = '<div role="article" aria-label="Comment by Author"><a href="https://www.facebook.com/page/videos/321/?comment_id=88">3h</a><span dir="auto">Counted anyway</span></div>';
  await fixture(html, async (page) => {
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(normalizeComment(scan.comments[0])!.id, "88");
    assert.equal(normalizeComment(scan.comments[0])!.idSource, "permalink");
  });
});

test("a link pasted in the comment body does not steal the card's identity", { skip: !canRunBrowser }, async () => {
  const html = '<div role="article" aria-label="Comment by Author">' +
    '<span dir="auto">See <a href="https://www.facebook.com/photo.php?fbid=1&comment_id=999">this other thread</a></span>' +
    '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=42">4h</a></div>';
  await fixture(html, async (page) => {
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(normalizeComment(scan.comments[0])!.id, "42", "the footer timestamp permalink identifies the comment");
  });
});

test("one pass counts every expandable control the page is showing", { skip: !canRunBrowser }, async () => {
  const html = card("Comment by Author", '<span dir="auto">Long body</span><div role="button">See more</div>', "1") +
    card("Comment by Author", '<span dir="auto">Another</span><div role="button">See more</div>', "2") +
    '<div role="button">View 4 more comments</div>';
  await fixture(html, async (page) => {
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(scan.expanders.text, 2);
    assert.equal(scan.expanders.thread, 1);
    assert.equal(scan.signature.expanders, 2, "the settle signature tracks in-card text expanders");
    const limited = await scanCommentPage(page, { withReplies: true, expandableIds: ["1"] });
    assert.equal(limited.expanders.text, 1, "text expansion stays scoped to the requested comments");
  });
});

test("a clicked control relabelling itself is not proof that its comments arrived", { skip: !canRunBrowser }, async () => {
  const html = card("Comment by Author", '<span dir="auto">Body</span><div role="button" id="more">See more</div>', "1");
  await fixture(html, async (page) => {
    const before = (await scanCommentPage(page, { withReplies: true })).signature;
    // Exactly what Facebook does on click: relabel now, render content later.
    await page.evaluate(() => { document.querySelector("#more")!.textContent = "See less"; });
    assert.equal(await settleCommentSection(page, before, 400, "content"), false,
      "pagination must wait for rows, not for the button it just pressed");
    assert.equal(await settleCommentSection(page, before, 400, "any"), true,
      "a text expansion may settle on its own control changing");

    await page.evaluate(() => {
      const card = document.createElement("div");
      card.setAttribute("role", "article");
      card.setAttribute("aria-label", "Comment by Author");
      card.innerHTML = '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=2">1h</a>';
      document.body.append(card);
    });
    assert.equal(await settleCommentSection(page, before, 400, "content"), true, "an arrived row settles content mode");
  });
});

test("a permalink-less card keeps one stable ID as its body expands, and wordless cards stay distinct", () => {
  // "See more" only appends, so a truncated body and its expansion are one comment.
  const truncated = normalizeComment(raw({ url: null, text: "A long comment begins…", fallbackKey: "A||||a long comment begins" }))!;
  const expanded = normalizeComment(raw({ url: null, text: "A long comment begins and then finishes.", fallbackKey: "A||||a long comment begins" }))!;
  assert.equal(truncated.id, expanded.id, "an expanded body must not become a second row");

  // Three wordless comments by one author are three comments, not one.
  const ids = [
    raw({ url: null, author: "A", emoji: ["😂"], fallbackKey: "A|😂|||" }),
    raw({ url: null, author: "A", gifs: ["https://media.giphy.com/a/fun.gif"], fallbackKey: "A||fun.gif||" }),
    raw({ url: null, author: "A", stickers: ["https://scontent.test/stickers/s/9.png"], fallbackKey: "A||9.png||" }),
  ].map((row) => normalizeComment(row)!.id);
  assert.equal(new Set(ids).size, 3, "emoji, GIF and sticker cards must not collapse into one row");
});

test("pagination is still expanded after text expansion has been abandoned", { skip: !canRunBrowser }, async () => {
  const html = card("Comment by Author", '<span dir="auto">Body</span><div role="button">See more</div>', "1") +
    '<div role="button">View 3 more comments</div>';
  await fixture(html, async (page) => {
    const batch = await expandCommentSectionBatch(page, { withReplies: true, expandThreads: true, expandText: false });
    assert.equal(batch.text, 0, "text expansion is the only thing given up");
    assert.equal(batch.thread, 1, "abandoning stuck text must never stop loading more comments");
  });
});

test("a photo attachment wrapped in its own permalink is kept, while the avatar is not", { skip: !canRunBrowser }, async () => {
  const html = '<div role="article" aria-label="Comment by Author">' +
    '<a href="https://www.facebook.com/profile.php?id=9"><img src="https://scontent.test/avatar.jpg"></a>' +
    '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=5">2h</a>' +
    '<a href="https://www.facebook.com/photo/?fbid=777"><img src="https://scontent.test/attached-photo.jpg"></a></div>';
  await fixture(html, async (page) => {
    const comment = normalizeComment((await scanCommentPage(page, { withReplies: true })).comments[0])!;
    assert.equal(comment.contentKind, "photo", "a photo-only comment is not empty");
    assert.ok(comment.images!.some((url) => url.includes("attached-photo")), "the attachment must be exported");
    assert.ok(!comment.images!.some((url) => url.includes("avatar")), "the avatar is not an attachment");
  });
});

test("a bare-span See more is counted, clicked and settled by the same rule", { skip: !canRunBrowser }, async () => {
  const html = card("Comment by Author", '<span dir="auto">Body</span><span>See more</span>', "1");
  await fixture(html, async (page) => {
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(scan.expanders.text, 1, "a span expander is pending work");
    assert.equal(scan.signature.expanders, 1, "and the settle signature must see the same one");
    assert.equal((await expandCommentSectionBatch(page, { withReplies: true, expandThreads: false })).text, 1);
  });
});

test("the expander resolves a card's ID the same way the scanner does", { skip: !canRunBrowser }, async () => {
  const html = '<div role="article" aria-label="Comment by Author">' +
    '<span dir="auto">See <a href="https://www.facebook.com/photo.php?fbid=1&comment_id=999">another</a></span>' +
    '<a href="https://www.facebook.com/photo.php?fbid=100&comment_id=42">4h</a>' +
    '<div role="button">See more</div></div>';
  await fixture(html, async (page) => {
    assert.equal((await scanCommentPage(page, { withReplies: true, expandableIds: ["42"] })).expanders.text, 1);
    const batch = await expandCommentSectionBatch(page, { withReplies: true, expandThreads: false, expandableIds: ["42"] });
    assert.equal(batch.text, 1, "a card the scanner counts as expandable must actually be expandable");
  });
});

test("the collector installs its remote callback name shim before scanning Facebook DOM", { skip: !canRunBrowser }, async () => {
  const html = card("Comment by Author", '<span dir="auto">Visible comment</span>', "7");
  await fixture(html, async (page) => {
    // Playwright executes serialized callbacks in the browser, where the
    // bundler's module-local __name helper does not exist. This reproduces the
    // live Reel failure unless the collector installs its page-local shim.
    await page.evaluate(() => { delete (globalThis as { __name?: unknown }).__name; });
    const scan = await scanCommentPage(page, { withReplies: true });
    assert.equal(scan.comments.length, 1);
  });
});
