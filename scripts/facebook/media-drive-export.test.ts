import assert from "node:assert/strict";
import { test } from "node:test";
import type { sheets_v4 } from "googleapis";
import type { FbBrowserPage } from "../../src/server/services/facebook/browser-fetcher";
import { FB_MEDIA_COLUMNS, buildFbMediaRows } from "../../src/lib/fb-export";
import { prepareMediaSheet, saveMediaSheetInput, sheetColumn, splitSheetCell, writeMediaSheetValues, mergeMediaSheetRows, unpackMediaRows, mergeSavedComments } from "../../src/server/services/facebook/media-drive-export";

function page(kind: "posts" | "reels" = "posts"): FbBrowserPage {
  return { handle: "owner", name: "Owner", url: "https://www.facebook.com/owner/", contentType: kind,
    profilePic: null, followers: null, likes: null, category: null, about: null, verified: false,
    instagram: null, twitter: null, email: null, phone: null, website: null,
    posts: [{ postId: "123", url: kind === "posts" ? "https://www.facebook.com/photo.php?fbid=123" : "https://www.facebook.com/reel/123/", text: "=IMPORTXML(\"https://example.test\")", likes: 0, comments: 0, shares: 0, metricsAvailable: false }],
  };
}

test("Photos and Reels share fixed columns, preserving numeric-looking IDs and literal formulas", () => {
  const result = prepareMediaSheet([page(), page("reels")]);
  assert.deepEqual(result.columns, [...FB_MEDIA_COLUMNS]);
  assert.equal(result.photos[0].length, result.reels[0].length);
  assert.equal(result.photos[0][result.columns.indexOf("Post ID")], "123");
  assert.equal(result.photos[0][result.columns.indexOf("Message / Caption")], page().posts[0].text);
  assert.equal(result.photos[0][result.columns.indexOf("Reactions Count")], "");
});

test("shared exports omit only the six removed columns and preserve About, caption, video and views", () => {
  assert.equal(FB_MEDIA_COLUMNS.length, 49);
  for (const kind of ["posts", "reels"] as const) {
    const value = page(kind);
    Object.assign(value, { profilePic: "https://example.test/profile.jpg", coverPic: "https://example.test/cover.jpg", verified: true, likes: 123, website: "https://example.test", about: "Retained profile description" });
    Object.assign(value.posts[0], { images: ["https://example.test/photo.jpg"], text: "Retained caption", video: "https://example.test/video.mp4", views: 0 });
    const [row] = buildFbMediaRows(value);
    assert.deepEqual(Object.keys(row), [...FB_MEDIA_COLUMNS]);
    for (const removed of ["Profile Picture", "Cover Photo", "Verified Badge Observed", "Total Page Likes", "Website", "Attached Images"]) assert.equal(removed in row, false, removed);
    assert.equal(row["About / Intro"], "Retained profile description");
    assert.equal(row["Message / Caption"], "Retained caption");
    assert.equal(row["Video URL"], "https://example.test/video.mp4");
    assert.equal(row["Views Count"], 0);
  }
});

test("verified retrievable comments are exported separately from Facebook's raw badge", () => {
  const photo = page();
  photo.posts[0].commentsReportedCount = 5;
  photo.posts[0].commentsStatus = "partial";
  photo.posts[0].commentsData = [
    { id: "c1", authorName: "Reader", text: "First", likeCount: 0, replyCount: 0, depth: 0 },
    { id: "c2", authorName: "Reader", text: "Second", likeCount: 0, replyCount: 0, depth: 0 },
  ];
  photo.posts[0].commentsVerifiedAccessibleCount = 2;
  photo.posts[0].commentsAccessibility = {
    sourceView: "newest", stablePasses: 2, reportedCount: 5,
    lastScanFingerprint: "a".repeat(64), verifiedAt: "2026-09-11T00:00:00.000Z",
  };
  const [row] = buildFbMediaRows(photo);
  assert.equal(row["Comments Count (Reported)"], 5);
  assert.equal(row["Comments Scraped Count"], 2);
  assert.equal(row["Comments Accessible Count (Verified)"], 2);
  assert.equal(row["Reported Delta Count"], 2);
  assert.equal(row["Comments Accessibility Status"], "Verified after 2 matching Newest scans");
  assert.match(String(row["Comments Accessibility Evidence"]), /"stablePasses":2/);
});

test("a clean Newest-panel count populates Reported Delta Count before a second scan", () => {
  const photo = page();
  photo.posts[0].commentsReportedCount = 5;
  photo.posts[0].commentsStatus = "partial";
  photo.posts[0].commentsData = [
    { id: "c1", authorName: "Reader", text: "First", likeCount: 0, replyCount: 0, depth: 0 },
    { id: "c2", authorName: "Reader", text: "Second", likeCount: 0, replyCount: 0, depth: 0 },
  ];
  photo.posts[0].commentsReportedDeltaCount = 2;
  const [row] = buildFbMediaRows(photo);
  assert.equal(row["Comments Count (Reported)"], 5);
  assert.equal(row["Reported Delta Count"], 2);
  assert.equal(row["Comments Scraped Count"], 2);
  assert.equal(row["Comments Accessible Count (Verified)"], "");
});

test("the trailing Reported Delta Count predecessor remains readable before its safe column move", () => {
  const photo = page();
  photo.posts[0].commentsReportedCount = 5;
  photo.posts[0].commentsStatus = "partial";
  photo.posts[0].commentsData = [
    { id: "c1", authorName: "Reader", text: "First", likeCount: 0, replyCount: 0, depth: 0 },
    { id: "c2", authorName: "Reader", text: "Second", likeCount: 0, replyCount: 0, depth: 0 },
  ];
  photo.posts[0].commentsVerifiedAccessibleCount = 2;
  photo.posts[0].commentsReportedDeltaCount = 2;
  photo.posts[0].commentsAccessibility = {
    sourceView: "newest", stablePasses: 2, reportedCount: 5,
    lastScanFingerprint: "b".repeat(64), verifiedAt: "2026-09-11T00:00:00.000Z",
  };
  const priorColumns = [...FB_MEDIA_COLUMNS.filter((column) => column !== "Reported Delta Count"), "Reported Delta Count"];
  const [row] = buildFbMediaRows(photo);
  const prior = unpackMediaRows(priorColumns, [priorColumns.map((column) => String(row[column] ?? ""))]);
  const merged = mergeMediaSheetRows({ photos: prior, reels: [], columns: priorColumns }, prepareMediaSheet([photo]));
  assert.deepEqual(merged.columns.slice(0, FB_MEDIA_COLUMNS.length), [...FB_MEDIA_COLUMNS]);
  const normalized = unpackMediaRows(merged.columns, merged.photos)[0];
  assert.equal(normalized["Reported Delta Count"], "2");
  assert.equal(normalized["Comments Scraped Count"], "2");
  assert.equal(JSON.parse(normalized["Comments JSON"]).length, 2);
});

test("oversized comments JSON is split losslessly at safe Unicode boundaries", () => {
  const comments = [{ id: "1234", authorName: "Example", text: "😀".repeat(40_000), likeCount: 0, replyCount: 0, depth: 0 }];
  const photo = page();
  photo.posts[0].commentsData = comments;
  photo.posts[0].commentsStatus = "complete";
  const prepared = prepareMediaSheet([photo, page("reels")]);
  const columns = prepared.columns.flatMap((title, i) => title === "Comments JSON" || title.startsWith("Comments JSON (continued ") ? [i] : []);
  assert.ok(columns.length > 1);
  assert.equal(columns.map((i) => prepared.photos[0][i]).join(""), JSON.stringify(comments));
  for (const index of columns) assert.ok(prepared.photos[0][index].length <= 45_000);
  assert.equal(prepared.reels[0].length, prepared.columns.length);
  const unicode = `${"x".repeat(44_999)}😀ending`;
  const parts = splitSheetCell(unicode);
  assert.equal(parts.join(""), unicode);
  assert.equal(parts[0].length, 44_999);
});

test("mixed profiles, foreign URLs, duplicate media, and mismatched media types are rejected", () => {
  const other = page("reels"); other.handle = "other";
  assert.throws(() => prepareMediaSheet([page(), other]));
  const foreign = page(); foreign.url = "https://facebook.com.evil.test/owner/";
  assert.throws(() => prepareMediaSheet([foreign]));
  const duplicate = page(); duplicate.posts.push({ ...duplicate.posts[0] });
  assert.throws(() => prepareMediaSheet([duplicate]));
  const wrong = page(); wrong.posts[0].url = "https://www.facebook.com/reel/123/";
  assert.throws(() => prepareMediaSheet([wrong]));
});

test("save inputs reject oversized and recursively excessive data before writes", () => {
  const input = { brandId: "a3157a10-0c10-4f4a-8f15-dcc790184f7a", runId: "3ab5dcad-f0cf-49cc-a2fb-cd2d43acb329", pages: [page()] };
  assert.equal(saveMediaSheetInput.safeParse(input).success, true);
  assert.equal(saveMediaSheetInput.safeParse({ ...input, extra: "a".repeat(17 * 1024 * 1024) }).success, false);
  assert.equal(sheetColumn(0), "A");
  assert.equal(sheetColumn(25), "Z");
  assert.equal(sheetColumn(26), "AA");
  assert.equal(sheetColumn(701), "ZZ");
});

test("later runs append new media and update existing IDs while retaining the other collection", () => {
  const firstPhoto = page(); firstPhoto.email = "owner@example.test"; firstPhoto.posts[0].text = "Original caption";
  const first = prepareMediaSheet([firstPhoto, page("reels")]);
  const secondPhoto = page(); secondPhoto.posts[0].text = "";
  secondPhoto.posts.push({ ...secondPhoto.posts[0], postId: "456", url: "https://www.facebook.com/photo.php?fbid=456", text: "New photo" });
  secondPhoto.posts[0].engagement = { status: "complete", totalReactions: 0, shares: 0, reactions: { like: 0 } };
  const second = prepareMediaSheet([secondPhoto]);
  assert.equal(second.profileKey, first.profileKey);
  const merged = mergeMediaSheetRows({ photos: unpackMediaRows(first.columns, first.photos), reels: unpackMediaRows(first.columns, first.reels) }, second);
  const photos = unpackMediaRows(merged.columns, merged.photos), reels = unpackMediaRows(merged.columns, merged.reels);
  assert.deepEqual(photos.map((p) => p["Post ID"]), ["123", "456"]);
  assert.equal(reels.length, 1);
  assert.equal(photos[0]["Message / Caption"], "Original caption");
  assert.equal(photos[0]["Email"], "owner@example.test");
  assert.equal(photos[1]["Email"], "owner@example.test");
  assert.equal(reels[0]["Email"], "owner@example.test");
  assert.equal(photos[0]["Like Count"], "0");
});

test("repeated comments merge by IDs, preserving old replies and adding only new IDs", () => {
  const c = (id: string, text: string) => ({ id, text, authorName: "Example", likeCount: 2, metricsAvailable: true, replyCount: 0, depth: 0 });
  const old = [{ ...c("1", "Old body"), replies: [{ ...c("2", "Prior reply"), parentId: "1", depth: 1 }] }];
  const fresh = [{ ...c("1", "Updated body"), replies: [{ ...c("2", "Prior reply"), parentId: "1", depth: 1 }, { ...c("3", "New reply"), parentId: "1", depth: 1 }] }];
  const result = mergeSavedComments(old, fresh);
  assert.equal(result.count, 3);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].text, "Updated body");
  assert.equal(result.comments[0].replyCount, 2);
  assert.deepEqual(result.comments[0].replies!.map((r) => r.id), ["2", "3"]);
  assert.equal(mergeSavedComments(result.comments, fresh).count, 3);
  assert.equal(mergeSavedComments(result.comments, []).count, 3);
  const unavailable = [{ ...c("1", ""), likeCount: 0, metricsAvailable: false }];
  assert.equal(mergeSavedComments(result.comments, unavailable).comments[0].likeCount, 2);
});

test("metadata-only and partial saves retain prior Comments JSON without inflating counts", () => {
  const initial = page();
  initial.posts[0].commentsStatus = "complete";
  initial.posts[0].commentsData = [{ id: "1", authorName: "Example", text: "Saved", likeCount: 0, replyCount: 0, depth: 0 }];
  const first = prepareMediaSheet([initial]);
  const stored = { photos: unpackMediaRows(first.columns, first.photos), reels: [] };
  const metadataOnly = mergeMediaSheetRows(stored, prepareMediaSheet([page()]));
  const row = unpackMediaRows(metadataOnly.columns, metadataOnly.photos)[0];
  assert.equal(row["Comments Scraped Count"], "1");
  assert.equal(JSON.parse(row["Comments JSON"])[0].id, "1");
  const partial = page(); partial.posts[0].commentsStatus = "partial"; partial.posts[0].commentsData = [];
  const again = mergeMediaSheetRows({ photos: [row], reels: [] }, prepareMediaSheet([partial]));
  const finalRow = unpackMediaRows(again.columns, again.photos)[0];
  assert.equal(finalRow["Comments Scraped Count"], "1");
  assert.equal(JSON.parse(finalRow["Comments JSON"]).length, 1);
  assert.equal(finalRow["Comments Status"], "partial");
});

test("delayed initial saves do not downgrade terminal details for the same capture", () => {
  const complete = page();
  complete.retrieval = { capturedAt: "2026-09-06T12:00:00Z", fromCache: false, durationMs: 100, requested: 1, returned: 1, stopReason: "limit" };
  complete.posts[0].commentsStatus = "complete";
  complete.posts[0].commentsStopReason = "visible-comments-exhausted";
  complete.posts[0].commentsData = [{ id: "1", authorName: "Example", text: "Saved", likeCount: 0, replyCount: 0, depth: 0 }];
  const saved = prepareMediaSheet([complete]);
  const pending = page(); pending.retrieval = complete.retrieval; pending.posts[0].commentsStatus = "running";
  const merged = mergeMediaSheetRows({ photos: unpackMediaRows(saved.columns, saved.photos), reels: [] }, prepareMediaSheet([pending]));
  const row = unpackMediaRows(merged.columns, merged.photos)[0];
  assert.equal(row["Comments Status"], "complete");
  assert.equal(row["Comments Stop Reason"], "visible-comments-exhausted");
  assert.equal(row["Comments Scraped Count"], "1");
  pending.retrieval = { ...pending.retrieval, capturedAt: "2026-09-07T12:00:00Z" };
  pending.posts[0].commentsStatus = "partial";
  const newer = mergeMediaSheetRows({ photos: [row], reels: [] }, prepareMediaSheet([pending]));
  assert.equal(unpackMediaRows(newer.columns, newer.photos)[0]["Comments Status"], "partial");
});

test("older grid metadata preserves newer profile fields while accepting fresh comments on cached media", () => {
  const recent = page(); recent.email = "new@example.test";
  recent.retrieval = { capturedAt: "2026-09-07T12:00:00Z", fromCache: false, durationMs: 100, requested: 1, returned: 1, stopReason: "limit" };
  recent.posts[0].commentsData = [{ id: "1", authorName: "Example", text: "Updated body", likeCount: 0, replyCount: 0, depth: 0 }];
  recent.posts[0].commentsStatus = "complete";
  const oldReel = page("reels"); oldReel.email = "old@example.test"; oldReel.retrieval = { ...recent.retrieval, capturedAt: "2026-09-06T12:00:00Z" };
  const saved = prepareMediaSheet([recent, oldReel]);
  const stale = page(); stale.email = "stale@example.test"; stale.retrieval = { ...oldReel.retrieval, fromCache: true };
  stale.posts[0].commentsData = [{ ...recent.posts[0].commentsData[0], text: "Fresh body on cached media" }];
  stale.posts[0].commentsStatus = "partial";
  const merged = mergeMediaSheetRows({ photos: unpackMediaRows(saved.columns, saved.photos), reels: unpackMediaRows(saved.columns, saved.reels) }, prepareMediaSheet([stale]));
  const row = unpackMediaRows(merged.columns, merged.photos)[0];
  assert.equal(row.Email, "new@example.test");
  assert.equal(unpackMediaRows(merged.columns, merged.reels)[0].Email, "new@example.test");
  assert.equal(row["Captured At"], recent.retrieval.capturedAt);
  assert.equal(JSON.parse(row["Comments JSON"])[0].text, "Fresh body on cached media");
  assert.equal(row["Comments Status"], "partial");
});

test("exact observed zero replaces rounded counts and clears their old approximation flag", () => {
  const rounded = page(); rounded.posts[0].engagement = { status: "partial", totalReactions: 1200, shares: 2, reactions: { like: 1200 }, approximate: true };
  const saved = prepareMediaSheet([rounded]);
  const exact = page(); exact.posts[0].engagement = { status: "complete", totalReactions: 0, shares: 0, reactions: { like: 0 } };
  const merged = mergeMediaSheetRows({ photos: unpackMediaRows(saved.columns, saved.photos), reels: [] }, prepareMediaSheet([exact]));
  const row = unpackMediaRows(merged.columns, merged.photos)[0];
  assert.equal(row["Like Count"], "0"); assert.equal(row["Shares Count"], "0"); assert.equal(row["Reaction Counts Approximate"], "false");
});

test("native writes use RAW text and verify both headers and collection row IDs", async () => {
  const prepared = prepareMediaSheet([page()]);
  const updates: { valueInputOption: string; requestBody: { values: string[][] }; range: string }[] = [];
  const requests: sheets_v4.Schema$Request[] = [];
  const fake = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 1000, columnCount: 26 } } }] } }),
    batchUpdate: async (input: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => { requests.push(...input.requestBody.requests); return { data: {} }; },
    values: {
      update: async (input: typeof updates[number]) => { updates.push(input); return { data: {} }; },
      clear: async () => ({ data: {} }),
      batchGet: async () => ({ data: { valueRanges: [
        { values: [prepared.columns] }, { values: [["123"]] }, { values: [] },
        { values: [prepared.columns] }, { values: [] }, { values: [] },
      ] } }),
    },
  } } as unknown as sheets_v4.Sheets;
  await writeMediaSheetValues(fake, "test-sheet", prepared, true);
  assert.equal(updates.length, 2);
  assert.ok(updates.every((u) => u.valueInputOption === "RAW"));
  assert.equal(updates[0].requestBody.values[1][prepared.columns.indexOf("Message / Caption")], page().posts[0].text);
  assert.ok(requests.some((r) => r.addSheet?.properties?.title === "Reels"));
  assert.ok(requests.filter((r) => r.updateSheetProperties?.properties?.gridProperties).every((r) => (r.updateSheetProperties!.properties!.gridProperties!.rowCount ?? 0) >= 2));
  fake.spreadsheets.values.batchGet = (async () => ({ data: { valueRanges: [{ values: [["wrong header"]] }] } })) as typeof fake.spreadsheets.values.batchGet;
  await assert.rejects(() => writeMediaSheetValues(fake, "test-sheet", prepared, false), /readback verification/);
});

test("native second and repeated saves read prior tabs, append media, and retain deduplicated comments", async () => {
  type Tab = { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number }; cells: string[][] };
  const tabs: Tab[] = [{ sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 1000, columnCount: 26 }, cells: [] }];
  const col = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const range = (value: string) => {
    const m = /^'([^']+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(value)!;
    return { tab: tabs.find((t) => t.title === m[1])!, startRow: +m[3] - 1, endRow: +m[5], startCol: col(m[2]), endCol: col(m[4]) + 1 };
  };
  const read = (value: string) => {
    const r = range(value);
    const values = Array.from({ length: r.endRow - r.startRow }, (_, i) => Array.from({ length: r.endCol - r.startCol }, (_, j) => r.tab.cells[r.startRow + i]?.[r.startCol + j] ?? ""));
    for (const row of values) while (row.length && row.at(-1) === "") row.pop();
    while (values.length && !values.at(-1)!.length) values.pop();
    return { values };
  };
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: tabs.map(({ sheetId, title, gridProperties }) => ({ properties: { sheetId, title, gridProperties } })) } }),
    batchUpdate: async ({ requestBody }: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
      for (const request of requestBody.requests) {
        if (request.addSheet) { const p = request.addSheet.properties!; tabs.push({ sheetId: p.sheetId!, title: p.title!, gridProperties: { rowCount: p.gridProperties!.rowCount!, columnCount: p.gridProperties!.columnCount! }, cells: [] }); }
        if (request.updateSheetProperties) { const p = request.updateSheetProperties.properties!; const t = tabs.find((item) => item.sheetId === p.sheetId)!; if (p.title) t.title = p.title; if (p.gridProperties) t.gridProperties = { rowCount: p.gridProperties.rowCount!, columnCount: p.gridProperties.columnCount! }; }
      }
      return { data: {} };
    },
    values: {
      update: async ({ range: address, valueInputOption, requestBody }: { range: string; valueInputOption: string; requestBody: { values: string[][] } }) => {
        assert.equal(valueInputOption, "RAW");
        const r = range(address);
        requestBody.values.forEach((row, i) => row.forEach((value, j) => { r.tab.cells[r.startRow + i] ??= []; r.tab.cells[r.startRow + i][r.startCol + j] = value; }));
        return { data: {} };
      },
      clear: async ({ range: address }: { range: string }) => { const r = range(address); for (let i = r.startRow; i < r.endRow; i++) for (let j = r.startCol; j < r.endCol; j++) { r.tab.cells[i] ??= []; r.tab.cells[i][j] = ""; } return { data: {} }; },
      get: async ({ range: address }: { range: string }) => ({ data: read(address) }),
      batchGet: async ({ ranges }: { ranges: string[] }) => ({ data: { valueRanges: ranges.map(read) } }),
    },
  } } as unknown as sheets_v4.Sheets;
  const firstPhoto = page();
  const comment = { id: "1", authorName: "Example", text: "Saved comment", likeCount: 0, replyCount: 0, depth: 0 };
  firstPhoto.posts[0].commentsData = [comment]; firstPhoto.posts[0].commentsStatus = "complete";
  await writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([firstPhoto, page("reels")]), true);
  const next = page();
  next.posts[0].commentsData = [{ ...comment, text: "Updated comment", replies: [{ ...comment, id: "2", text: "New reply", parentId: "1", depth: 1 }] }];
  next.posts[0].commentsStatus = "partial";
  next.posts.push({ ...page().posts[0], postId: "456", url: "https://www.facebook.com/photo.php?fbid=456" });
  await writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([next]), false);
  await writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([next]), false);
  const photos = tabs.find((t) => t.title === "Photos")!, reels = tabs.find((t) => t.title === "Reels")!;
  const rows = unpackMediaRows(photos.cells[0], photos.cells.slice(1));
  assert.deepEqual(rows.map((r) => r["Post ID"]), ["123", "456"]);
  assert.equal(rows[0]["Comments Scraped Count"], "2");
  const saved = JSON.parse(rows[0]["Comments JSON"]);
  assert.equal(saved.length, 1); assert.equal(saved[0].text, "Updated comment"); assert.equal(saved[0].replies.length, 1);
  assert.equal(unpackMediaRows(reels.cells[0], reels.cells.slice(1)).length, 1);

  // Store enough long JSON rows to require multiple write requests. A later
  // long caption adds a continuation column before comments in base-field order.
  const large = page();
  large.posts = Array.from({ length: 10 }, (_, i) => ({ ...page().posts[0], postId: String(500 + i), url: `https://www.facebook.com/photo.php?fbid=${500 + i}`, commentsStatus: "complete", commentsData: [{ ...comment, text: "x".repeat(80_000) }] }));
  await writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([large]), false);
  const commentPartIndex = photos.cells[0].indexOf("Comments JSON (continued 2)");
  const caption = page(); caption.posts[0].text = "c".repeat(60_000);
  const originalUpdate = client.spreadsheets.values.update.bind(client.spreadsheets.values);
  let interrupted = false;
  client.spreadsheets.values.update = (async (input: { range: string }) => {
    if (!interrupted && input.range.startsWith("'Photos'!") && !input.range.startsWith("'Photos'!A1:")) { interrupted = true; throw new Error("Simulated interrupted write"); }
    return originalUpdate(input);
  }) as typeof client.spreadsheets.values.update;
  await assert.rejects(() => writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([caption]), false), /interrupted write/);
  assert.equal(photos.cells[0].indexOf("Comments JSON (continued 2)"), commentPartIndex);
  await writeMediaSheetValues(client, "profile-sheet", prepareMediaSheet([caption]), false);
  const recovered = unpackMediaRows(photos.cells[0], photos.cells.slice(1));
  assert.equal(recovered.length, 12);
  for (const media of recovered.filter((r) => Number(r["Post ID"]) >= 500)) assert.equal(JSON.parse(media["Comments JSON"])[0].text.length, 80_000);
  assert.equal(recovered.find((r) => r["Post ID"] === "123")!["Message / Caption"].length, 60_000);
});
