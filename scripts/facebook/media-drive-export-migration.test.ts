import assert from "node:assert/strict";
import { test } from "node:test";
import type { sheets_v4 } from "googleapis";
import type { FbBrowserPage } from "../../src/server/services/facebook/browser-fetcher";
import { FB_MEDIA_COLUMNS } from "../../src/lib/fb-export";
import { prepareMediaSheet, splitSheetCell, unpackMediaRows, writeMediaSheetValues } from "../../src/server/services/facebook/media-drive-export";

// This is the actual previous public contract, independent of the migration's
// detection constant. Its original Post ID column is S, not the new N column.
const legacy = [
  "Index", "Page / Profile Name", "Handle / ID", "Profile URL", "Collection", "Captured At",
  "Profile Picture", "Cover Photo", "Category", "About / Intro", "Verified Badge Observed",
  "Total Followers", "Total Page Likes", "Email", "Phone", "Website", "Instagram", "Twitter / X",
  "Post ID", "Post URL", "Content Type", "Message / Caption", "Published Time", "Attached Images",
  "Video URL", "Views Count", "Reactions Count", "Like Count", "Love Count", "Care Count",
  "Haha Count", "Wow Count", "Sad Count", "Angry Count", "Shares Count", "Reactions Status",
  "Reaction Counts Approximate", "Reactions Error", "Comments Count (Reported)", "Comments Scraped Count",
  "Comments Status", "Comments Stop Reason", "Comments Error", "Comments JSON",
];
const removed = ["Profile Picture", "Cover Photo", "Verified Badge Observed", "Total Page Likes", "Website", "Attached Images"];
type Tab = { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number }; cells: string[][] };
const oldRow = (id: number, index: number, kind: "Photos" | "Reels"): Record<string, string> => ({
  ...Object.fromEntries(legacy.map((column) => [column, ""])),
  Index: String(index + 1), "Page / Profile Name": "Owner", "Handle / ID": "owner", "Profile URL": "https://www.facebook.com/owner/",
  Collection: kind, "Captured At": "2026-09-06T12:00:00Z", Category: "Public figure", "About / Intro": "Retain the profile description",
  "Profile Picture": "removed profile.jpg", "Cover Photo": "removed cover.jpg", "Verified Badge Observed": "Yes", "Total Page Likes": "500",
  "Total Followers": "1234", Email: "owner@example.test", Phone: "12345", Website: "removed website", Instagram: "https://www.instagram.com/owner/", "Twitter / X": "https://x.com/owner",
  "Post ID": String(id), "Post URL": kind === "Photos" ? `https://www.facebook.com/photo.php?fbid=${id}` : `https://www.facebook.com/reel/${id}/`,
  "Content Type": kind === "Photos" ? "photo" : "reel", "Message / Caption": `Caption ${id} ` + "c".repeat(60_000),
  "Published Time": `2026-09-0${index + 1}T12:00:00Z`, "Attached Images": "removed image list ".repeat(3000),
  "Video URL": `https://example.test/video-${id}.mp4`, "Views Count": String(id * 10), "Reactions Count": "4", "Like Count": "4",
  "Love Count": "0", "Care Count": "0", "Haha Count": "0", "Wow Count": "0", "Sad Count": "0", "Angry Count": "0", "Shares Count": "0",
  "Reactions Status": "complete", "Reaction Counts Approximate": "false", "Comments Count (Reported)": "1", "Comments Scraped Count": "1",
  "Comments Status": "complete", "Comments Stop Reason": "visible-comments-exhausted",
  "Comments JSON": JSON.stringify([{ id: `comment-${id}`, authorName: "Example", text: `Comment ${id} ` + "😀".repeat(30_000), likeCount: 0, replyCount: 0, depth: 0, parentId: null, replies: [] }]),
});

function fixture() {
  const expected = { Photos: Array.from({ length: 8 }, (_, i) => oldRow(100 + i, i, "Photos")), Reels: [oldRow(200, 0, "Reels"), oldRow(201, 1, "Reels")] };
  const parts = new Map<string, number>();
  for (const row of [...expected.Photos, ...expected.Reels]) for (const name of legacy) parts.set(name, Math.max(parts.get(name) ?? 1, splitSheetCell(row[name]).length));
  const header = [...legacy];
  for (const name of legacy) for (let part = 2; part <= (parts.get(name) ?? 1); part++) header.push(`${name} (continued ${part})`);
  const encode = (row: Record<string, string>) => header.map((name) => {
    const match = /^(.*) \(continued (\d+)\)$/.exec(name);
    return splitSheetCell(row[match?.[1] ?? name])[Number(match?.[2] ?? 1) - 1] ?? "";
  });
  const tabs: Tab[] = Object.entries(expected).map(([title, rows], sheetId) => ({ sheetId, title, gridProperties: { rowCount: 100, columnCount: header.length + 2 }, cells: [[...header], ...rows.map(encode)] }));
  tabs.push({ sheetId: 2, title: "Unrelated notes", gridProperties: { rowCount: 10, columnCount: 4 }, cells: [["Leave this tab alone"], ["Unrelated values"]] });
  const changes: sheets_v4.Schema$Request[][] = [];
  const controls = { lostMigrationResponse: false, interruptedData: false, valuesWrites: 0, deletedBatches: 0, idReads: [] as string[] };
  const col = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const range = (value: string) => {
    const match = /^'([^']+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(value)!;
    return { tab: tabs.find((t) => t.title === match[1])!, firstRow: +match[3] - 1, lastRow: +match[5], firstCol: col(match[2]), lastCol: col(match[4]) + 1 };
  };
  const read = (address: string) => {
    const r = range(address);
    if (r.firstCol === r.lastCol - 1) controls.idReads.push(address);
    const values = Array.from({ length: r.lastRow - r.firstRow }, (_, i) => Array.from({ length: r.lastCol - r.firstCol }, (_, j) => r.tab.cells[r.firstRow + i]?.[r.firstCol + j] ?? ""));
    for (const row of values) while (row.length && row.at(-1) === "") row.pop();
    while (values.length && !values.at(-1)!.length) values.pop();
    return { values };
  };
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: tabs.map(({ sheetId, title, gridProperties }) => ({ properties: { sheetId, title, gridProperties: { ...gridProperties } } })) } }),
    batchUpdate: async ({ requestBody }: { requestBody: { requests: sheets_v4.Schema$Request[] } }, options?: { retry?: boolean }) => {
      const requests = requestBody.requests;
      changes.push(requests);
      if (requests.some((request) => request.deleteDimension)) {
        assert.ok(requests.every((request) => request.deleteDimension), "migration is an independent atomic batch");
        assert.equal(options?.retry, false, "do not automatically replay column indexes after an ambiguous response");
        const next = structuredClone(tabs);
        for (const request of requests) {
          const r = request.deleteDimension!.range!; assert.equal(r.dimension, "COLUMNS");
          const tab = next.find((item) => item.sheetId === r.sheetId)!;
          for (const name of tab.cells[0].slice(r.startIndex!, r.endIndex!)) assert.ok(removed.includes(name.replace(/ \(continued \d+\)$/, "")), name);
          for (const row of tab.cells) row.splice(r.startIndex!, r.endIndex! - r.startIndex!);
          tab.gridProperties.columnCount -= r.endIndex! - r.startIndex!;
        }
        tabs.splice(0, tabs.length, ...next); controls.deletedBatches++;
        if (controls.lostMigrationResponse) { controls.lostMigrationResponse = false; throw new Error("Migration response lost after atomic apply"); }
      } else if (requests.some((request) => request.insertDimension)) {
        const next = structuredClone(tabs);
        for (const request of requests) if (request.insertDimension) {
          const range = request.insertDimension.range!; assert.equal(range.dimension, "COLUMNS");
          const tab = next.find((item) => item.sheetId === range.sheetId)!;
          const width = range.endIndex! - range.startIndex!;
          for (const row of tab.cells) row.splice(range.startIndex!, 0, ...Array(width).fill(""));
          tab.gridProperties.columnCount += width;
        }
        for (const request of requests) if (request.updateCells) {
          const range = request.updateCells.range!; const tab = next.find((item) => item.sheetId === range.sheetId)!;
          const values = request.updateCells.rows?.[0]?.values ?? [];
          values.forEach((cell, index) => { tab.cells[0][(range.startColumnIndex ?? 0) + index] = cell.userEnteredValue?.stringValue ?? ""; });
        }
        tabs.splice(0, tabs.length, ...next);
      } else for (const request of requests) if (request.updateSheetProperties) {
        const properties = request.updateSheetProperties.properties!; const tab = tabs.find((item) => item.sheetId === properties.sheetId)!;
        if (properties.gridProperties) tab.gridProperties = { rowCount: properties.gridProperties.rowCount!, columnCount: properties.gridProperties.columnCount! };
      }
      return { data: {} };
    },
    values: {
      get: async ({ range: address }: { range: string }) => ({ data: read(address) }),
      batchGet: async ({ ranges }: { ranges: string[] }) => ({ data: { valueRanges: ranges.map(read) } }),
      update: async ({ range: address, requestBody, valueInputOption }: { range: string; requestBody: { values: string[][] }; valueInputOption: string }) => {
        if (controls.interruptedData && address.startsWith("'Photos'!") && !address.startsWith("'Photos'!A1:")) { controls.interruptedData = false; throw new Error("Data write interrupted after first batch"); }
        controls.valuesWrites++; assert.equal(valueInputOption, "RAW");
        const r = range(address); requestBody.values.forEach((row, i) => row.forEach((value, j) => { r.tab.cells[r.firstRow + i] ??= []; r.tab.cells[r.firstRow + i][r.firstCol + j] = value; }));
        return { data: {} };
      },
      clear: async () => { throw new Error("No existing media row should be cleared in migration"); },
    },
  } } as unknown as sheets_v4.Sheets;
  const minimal: FbBrowserPage = { name: "Owner", handle: "owner", url: "https://www.facebook.com/owner/", contentType: "posts", profilePic: null, followers: null, likes: null, category: null, about: null, verified: false, instagram: null, twitter: null, email: null, phone: null, website: null,
    posts: [{ postId: "100", url: "https://www.facebook.com/photo.php?fbid=100", text: "", likes: 0, shares: 0, comments: 0, metricsAvailable: false }] };
  const save = () => writeMediaSheetValues(client, "managed-sheet", prepareMediaSheet([minimal]), false);
  const assertPreserved = () => {
    for (const title of ["Photos", "Reels"] as const) {
      const tab = tabs.find((item) => item.title === title)!;
      const headers = tab.cells[0].filter(Boolean);
      const isCurrent = JSON.stringify(headers.slice(0, FB_MEDIA_COLUMNS.length)) === JSON.stringify(FB_MEDIA_COLUMNS);
      // The older 38-column layout predates Reported Delta Count, which now
      // sits between the two comment counts. It must remain recognizable after
      // a lost deletion response, before the safe retry inserts that field.
      const preUpgrade = FB_MEDIA_COLUMNS.filter((column) => ![
        "Reported Delta Count", "Comments Retrieved Count", "Comments Text Count",
        "Comments Actual Text Count (Verified)", "Comments Excluded Non-text Count",
        "Comments Excluded Attachment Count", "Comments Content Scope", "Comments Source View",
        "Comments Accessible Count (Verified)", "Comments Accessibility Status",
        "Comments Accessibility Evidence",
      ].includes(column));
      const isPreUpgrade = JSON.stringify(headers.slice(0, preUpgrade.length)) === JSON.stringify(preUpgrade);
      assert.ok(isCurrent || isPreUpgrade, `recognized managed header for ${title}`);
      assert.ok(headers.every((name) => !removed.includes(name.replace(/ \(continued \d+\)$/, ""))));
      const rows = unpackMediaRows(headers, tab.cells.slice(1));
      assert.equal(rows.length, expected[title].length);
      for (const row of rows) {
        const before = expected[title].find((item) => item["Post ID"] === row["Post ID"])!;
        assert.ok(before, row["Post ID"]);
        for (const column of FB_MEDIA_COLUMNS) if (headers.includes(column)) assert.equal(row[column], before[column] ?? "", `${title} ${row["Post ID"]} ${column}`);
      }
      assert.notEqual(rows[0]["Published Time"], rows[1]["Published Time"]);
      assert.notEqual(rows[0]["Views Count"], rows[1]["Views Count"]);
    }
    assert.deepEqual(tabs.find((item) => item.title === "Unrelated notes")!.cells, [["Leave this tab alone"], ["Unrelated values"]]);
  };
  return { tabs, expected, controls, changes, save, assertPreserved };
}

test("legacy columns and only their continuations are atomically removed from both tabs", async () => {
  const f = fixture(); await f.save();
  assert.equal(f.controls.deletedBatches, 1);
  assert.deepEqual(new Set(f.changes[0].map((request) => request.deleteDimension!.range!.sheetId)), new Set([0, 1]));
  assert.ok(f.controls.idReads.some((range) => range.startsWith("'Photos'!S1:S")), "read Post ID at the validated legacy offset");
  f.assertPreserved();
  await f.save(); assert.equal(f.controls.deletedBatches, 1); f.assertPreserved();
});

test("retry after lost atomic migration response never deletes shifted columns again", async () => {
  const f = fixture(); f.controls.lostMigrationResponse = true;
  await assert.rejects(f.save, /response lost/);
  assert.equal(f.controls.valuesWrites, 0); f.assertPreserved();
  await f.save(); assert.equal(f.controls.deletedBatches, 1); f.assertPreserved();
  assert.ok(f.controls.idReads.some((range) => range.startsWith("'Photos'!N1:N")), "retry locates Post ID in the migrated header");
});

test("interrupted row writes after migration retain every other row and full continuation JSON", async () => {
  const f = fixture(); f.controls.interruptedData = true;
  await assert.rejects(f.save, /Data write interrupted/);
  assert.equal(f.controls.deletedBatches, 1); assert.ok(f.controls.valuesWrites > 0);
  f.assertPreserved();
  await f.save(); assert.equal(f.controls.deletedBatches, 1); f.assertPreserved();
});

test("all legacy rows and headers validate before either tab is changed", async () => {
  for (const corrupt of [
    (tab: Tab) => { tab.cells[0][legacy.indexOf("About / Intro")] = "User changed this header"; },
    (tab: Tab) => { tab.cells[1][legacy.indexOf("Comments JSON")] = "invalid JSON"; },
    (tab: Tab) => { tab.cells[2][legacy.indexOf("Post ID")] = "invalid-id"; },
    (tab: Tab) => { tab.cells[0].push("User notes"); tab.gridProperties.columnCount++; },
    (tab: Tab) => { tab.cells.push(["An unkeyed trailing row"]); },
    (tab: Tab) => { tab.cells[0] = []; },
  ]) {
    const f = fixture(); corrupt(f.tabs.find((tab) => tab.title === "Reels")!);
    const before = structuredClone(f.tabs);
    await assert.rejects(f.save);
    assert.equal(f.changes.length, 0); assert.equal(f.controls.valuesWrites, 0);
    assert.deepEqual(f.tabs, before);
  }
});
