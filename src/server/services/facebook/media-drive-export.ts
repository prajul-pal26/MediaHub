import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { drive_v3, sheets_v4 } from "googleapis";
import type { FbBrowserComment, FbBrowserPage } from "./browser-fetcher";
import { FB_MEDIA_COLUMNS, buildFbMediaRows } from "@/lib/fb-export";
import { writeResolvedMediaSheetTarget } from "./media-drive-target";
import { commentCountShortfallRequests } from "./media-sheet-format";

const FOLDER_NAME = "Facebook scraper";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_BYTES = 16 * 1024 * 1024;
const CELL_CHARS = 45_000;
const MAX_SAVED_ROWS = 20_000;
// Recognize only the exact prior managed schema, never infer renamed/reordered
// user headers when migrating the six columns removed from media exports.
const LEGACY_MEDIA_COLUMNS = [
  "Index", "Page / Profile Name", "Handle / ID", "Profile URL", "Collection", "Captured At",
  "Profile Picture", "Cover Photo", "Category", "About / Intro", "Verified Badge Observed",
  "Total Followers", "Total Page Likes", "Email", "Phone", "Website", "Instagram", "Twitter / X",
  "Post ID", "Post URL", "Content Type", "Message / Caption", "Published Time", "Attached Images",
  "Video URL", "Views Count", "Reactions Count", "Like Count", "Love Count", "Care Count",
  "Haha Count", "Wow Count", "Sad Count", "Angry Count", "Shares Count", "Reactions Status",
  "Reaction Counts Approximate", "Reactions Error", "Comments Count (Reported)", "Comments Scraped Count",
  "Comments Status", "Comments Stop Reason", "Comments Error", "Comments JSON",
] as const;
// The 38-column schema used before detailed comment accounting.  Do not use a
// positional slice here: Reported Delta Count was later inserted between the
// two original comment-count columns, and a slice would misidentify a legacy
// Comments Scraped Count as the new field during a safe retry.
const PRE_TEXT_SCOPE_MEDIA_COLUMNS = FB_MEDIA_COLUMNS.filter((column) => ![
  "Reported Delta Count", "Comments Retrieved Count", "Comments Text Count",
  "Comments Actual Text Count (Verified)", "Comments Excluded Non-text Count",
  "Comments Excluded Attachment Count", "Comments Content Scope", "Comments Source View",
  "Comments Accessible Count (Verified)", "Comments Accessibility Status",
  "Comments Accessibility Evidence",
].includes(column));
// The first rollout appended this field to avoid shifting oversized JSON
// continuations. Recognize that exact layout so it can be moved atomically
// into its final location beside the two comment counts.
const PRE_REPORTED_DELTA_POSITION_MEDIA_COLUMNS = [
  ...FB_MEDIA_COLUMNS.filter((column) => column !== "Reported Delta Count"),
  "Reported Delta Count",
] as const;
// The availability audit did not exist in older managed Sheets. Keep this
// predecessor independent of the Reported Delta Count's final position.
const PRE_ACCESSIBILITY_MEDIA_COLUMNS = FB_MEDIA_COLUMNS.filter((column) => ![
  "Comments Accessible Count (Verified)", "Comments Accessibility Status",
  "Comments Accessibility Evidence", "Reported Delta Count",
].includes(column));
// The first text-only rollout did not yet expose a verified raw-minus-nontext
// comparison. Accept that exact managed header before adding the new column.
const PRE_SOURCE_VIEW_MEDIA_COLUMNS = PRE_ACCESSIBILITY_MEDIA_COLUMNS.filter((column) => column !== "Comments Source View");
const PRE_VERIFIED_TEXT_MEDIA_COLUMNS = PRE_SOURCE_VIEW_MEDIA_COLUMNS.filter((column) => column !== "Comments Actual Text Count (Verified)");
const REMOVED_MEDIA_COLUMNS = new Set(["Profile Picture", "Cover Photo", "Verified Badge Observed", "Total Page Likes", "Website", "Attached Images"]);
const removedMediaColumn = (column: string) => REMOVED_MEDIA_COLUMNS.has(column.replace(/ \(continued \d+\)$/, ""));
const count = z.number().finite().nonnegative();
const optionalText = z.string().max(100_000).nullable().optional();
const link = z.string().url().max(8192).nullable().optional();
const commentSchema: z.ZodType<FbBrowserComment> = z.lazy(() => z.object({
  id: z.string().max(100), parentId: z.string().max(100).nullable().optional(),
  authorName: z.string().max(2000), text: z.string().max(100_000),
  commentUrl: link, authorProfileUrl: link, authorAvatar: link, authorBadge: optionalText,
  contentType: z.enum(["text", "gif", "image", "video", "attachment", "unavailable"]).optional(),
  contentKind: z.enum(["text", "emoji", "gif", "sticker", "video", "photo", "attachment", "empty"]).optional(),
  contentKinds: z.array(z.enum(["text", "emoji", "gif", "sticker", "video", "photo", "attachment", "empty"])).max(8).optional(),
  idSource: z.enum(["permalink", "derived"]).optional(),
  isHidden: z.boolean().optional(),
  hiddenSource: z.enum(["card_marker", "revealed_by_hidden_control"]).optional(),
  images: z.array(z.string().max(8192)).max(100).optional(), video: link,
  timeLabel: optionalText, createdAt: optionalText, metricsAvailable: z.boolean().optional(),
  likeCount: count, replyCount: count, depth: z.number().int().min(0).max(50),
  replies: z.array(commentSchema).max(5000).optional(),
}));

export const fbExportPageSchema = z.object({
  contentType: z.enum(["posts", "reels"]), handle: z.string().min(1).max(200), name: z.string().max(2000),
  url: z.string().url().max(2048), kind: z.enum(["page", "profile", "group", "post"]).optional(),
  profilePic: link.default(null), coverPic: link, followers: count.nullable(), likes: count.nullable(),
  category: z.string().max(2000).nullable(), about: z.string().max(50_000).nullable(), verified: z.boolean(),
  instagram: link.default(null), twitter: link.default(null), email: optionalText.default(null), phone: optionalText.default(null), website: link.default(null),
  retrieval: z.object({ capturedAt: z.string().max(100), fromCache: z.boolean(), durationMs: count, requested: count, returned: count, stopReason: z.enum(["limit", "end", "stalled", "timeout"]) }).optional(),
  posts: z.array(z.object({
    postId: z.string().regex(/^\d{1,40}$/), url: z.string().url().max(2048), text: z.string().max(100_000),
    mediaType: z.enum(["photo", "reel"]).optional(), metricsAvailable: z.boolean().optional(), views: count.nullable().optional(),
    publishedTime: optionalText, likes: count, comments: count, shares: count, images: z.array(z.string().max(8192)).max(100).optional(), video: link, isVideo: z.boolean().optional(),
    commentsStatus: z.enum(["pending", "running", "complete", "partial", "failed", "cancelled"]).optional(),
    commentsStopReason: optionalText, commentsDurationMs: count.optional(), commentsReportedCount: count.nullable().optional(),
    commentsObservedCount: count.optional(), commentsVerifiedAccessibleCount: count.optional(), commentsReportedDeltaCount: count.optional(), commentsAccessibility: z.object({
      sourceView: z.enum(["all", "newest"]), stablePasses: z.number().int().min(1).max(1_000), reportedCount: count,
      lastScanFingerprint: z.string().max(128), lastAttemptId: z.string().uuid().optional(), verifiedAt: optionalText,
    }).optional(), commentsTextCount: count.optional(), commentsExcludedNonTextCount: count.optional(), commentsExcludedAttachmentCount: count.optional(), commentsContentScope: z.enum(["text_only", "observed_nodes"]).optional(), commentsSourceView: z.enum(["all", "newest", "most_relevant", "unknown"]).optional(),
    commentsBreakdown: z.object({
      totalCount: count, topLevelCount: count, visibleTopLevelCount: count, hiddenTopLevelCount: count,
      replyCount: count, hiddenReplyCount: count, hiddenCount: count,
    }).optional(),
    commentsData: z.array(commentSchema).max(5000).optional(), commentsError: optionalText,
    engagement: z.object({ status: z.enum(["complete", "partial"]), totalReactions: count.nullable(), shares: count.nullable(),
      reactions: z.object({ like: count.optional(), love: count.optional(), care: count.optional(), haha: count.optional(), wow: count.optional(), sad: count.optional(), angry: count.optional() }),
      approximate: z.boolean().optional(), error: optionalText,
    }).optional(),
  })).max(2000),
});

/** Reject excessive payloads/depth before recursive comment validation. */
export const saveMediaSheetInput = z.preprocess((input, ctx) => {
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BYTES) throw new Error("Export exceeds the 16 MB save limit.");
    const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
      const current = stack.pop()!;
      if (++nodes > 400_000 || current.depth > 55) throw new Error("Export contains too many nested records.");
      if (current.value && typeof current.value === "object") for (const value of Object.values(current.value)) stack.push({ value, depth: current.depth + 1 });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid export payload." });
    return z.NEVER;
  }
  return input;
}, z.object({ brandId: z.string().uuid(), runId: z.string().uuid(), pages: z.array(fbExportPageSchema).min(1).max(2) }));

export interface ExportProfile { role: string; org_id: string; brand_id: string | null; assigned_brands?: string[] }
export interface MediaSheetResult { url: string; folderUrl: string; fileId: string; updatedAt: string }
export interface PreparedMediaSheet { columns: string[]; photos: string[][]; reels: string[][]; profileKey: string; profileName: string }
export interface MediaSheetRows { photos: Record<string, string>[]; reels: Record<string, string>[]; spans?: { photos: number; reels: number }; columns?: string[] }
interface ExistingMediaSheetRows extends MediaSheetRows {
  columnDeletes: { sheetId: number; indexes: number[] }[];
  /** Insert new managed scalar columns before continuations atomically, so an
   * interrupted values write can never relabel an old JSON continuation. */
  columnInserts: { sheetId: number; startIndex: number; count: number }[];
  /** Move an existing managed scalar as one atomic column operation. */
  columnMoves: { sheetId: number; startIndex: number; destinationIndex: number }[];
}

/** UTF-16 boundaries stay intact, so concatenating continuation cells is lossless. */
export function splitSheetCell(text: string): string[] {
  if (!text.length) return [""];
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CELL_CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function sheetColumn(index: number): string {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

function profileIdentity(page: FbBrowserPage): string {
  const url = new URL(page.url);
  if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) throw new TRPCError({ code: "BAD_REQUEST", message: "Export profile must have a Facebook URL." });
  return `${page.handle.toLowerCase()}|${url.pathname.replace(/\/+$/, "").toLowerCase()}|${url.searchParams.get("id") ?? ""}`;
}

export function prepareMediaSheet(pages: FbBrowserPage[]): PreparedMediaSheet {
  if (!pages.length || pages.length > 2 || pages.reduce((n, p) => n + p.posts.length, 0) > 2000) throw new TRPCError({ code: "BAD_REQUEST", message: "Save one profile with at most 2,000 combined photos and reels." });
  if (new Set(pages.map((p) => p.contentType)).size !== pages.length || pages.some((p) => !p.contentType)) throw new TRPCError({ code: "BAD_REQUEST", message: "Each media collection must appear once." });
  const identities = pages.map(profileIdentity);
  if (new Set(identities).size !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Save each Facebook profile in its own run." });
  const source: { photos: Record<string, unknown>[]; reels: Record<string, unknown>[] } = { photos: [], reels: [] };
  for (const page of pages) {
    const seen = new Set<string>();
    for (const post of page.posts) {
      const url = new URL(post.url ?? "");
      const id = page.contentType === "reels" ? /^\/reel\/(\d+)\/?$/.exec(url.pathname)?.[1] : /^\/photo(?:\.php|\/)?$/.test(url.pathname) ? url.searchParams.get("fbid") : null;
      if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname) || !id || id !== post.postId || seen.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Export media links must match unique IDs in their selected collection." });
      seen.add(id);
    }
    source[page.contentType === "reels" ? "reels" : "photos"] = buildFbMediaRows(page);
  }
  return packMediaRows(source, createHash("sha256").update(identities[0]).digest("hex"), pages[0].name || pages[0].handle);
}

function packMediaRows(source: { photos: Record<string, unknown>[]; reels: Record<string, unknown>[] }, profileKey: string, profileName: string): PreparedMediaSheet {
  const partCounts = new Map<string, number>();
  const splitRows = (rows: Record<string, unknown>[]) => rows.map((row) => FB_MEDIA_COLUMNS.map((column) => {
    const value = row[column];
    const parts = splitSheetCell(value == null ? "" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
    partCounts.set(column, Math.max(partCounts.get(column) ?? 1, parts.length));
    return parts;
  }));
  const photos = splitRows(source.photos), reels = splitRows(source.reels);
  const columns: string[] = [...FB_MEDIA_COLUMNS];
  const continuation: { column: number; part: number }[] = [];
  FB_MEDIA_COLUMNS.forEach((column, index) => {
    for (let part = 1; part < (partCounts.get(column) ?? 1); part++) { columns.push(`${column} (continued ${part + 1})`); continuation.push({ column: index, part }); }
  });
  const flatten = (rows: string[][][]) => rows.map((row) => [...row.map((parts) => parts[0]), ...continuation.map(({ column, part }) => row[column][part] ?? "")]);
  const prepared = { columns, photos: flatten(photos), reels: flatten(reels), profileKey, profileName };
  if (photos.length + reels.length > MAX_SAVED_ROWS || columns.length * (photos.length + reels.length + 4) > 9_000_000) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This profile Sheet has reached its safe row/cell capacity; existing data was not changed." });
  if (columns.length > 2000 || Buffer.byteLength(JSON.stringify(prepared), "utf8") > MAX_BYTES * 2) throw new TRPCError({ code: "BAD_REQUEST", message: "The expanded Sheet exceeds the 32 MB save limit." });
  return prepared;
}

/** Rewrite a managed Sheet in chronological media order without scraping again. */
export async function normalizeMediaSheetOrder(
  sheets: sheets_v4.Sheets,
  fileId: string,
  rows: MediaSheetRows,
  profileKey: string,
  profileName: string,
): Promise<void> {
  await writeMediaSheetValues(sheets, fileId, packMediaRows({ photos: rows.photos, reels: rows.reels }, profileKey, profileName), false);
}

/** Replace only app-managed media rows after a verified repair; headers and tabs remain managed. */
export async function replaceMediaSheetRows(
  sheets: sheets_v4.Sheets,
  fileId: string,
  rows: MediaSheetRows,
  profileKey: string,
  profileName: string,
): Promise<void> {
  await writeMediaSheetValues(sheets, fileId, packMediaRows({ photos: rows.photos, reels: rows.reels }, profileKey, profileName), false, true);
}

function managedMediaHeader(columns: string[]) {
  const base = [FB_MEDIA_COLUMNS, PRE_REPORTED_DELTA_POSITION_MEDIA_COLUMNS, PRE_ACCESSIBILITY_MEDIA_COLUMNS, PRE_SOURCE_VIEW_MEDIA_COLUMNS, PRE_VERIFIED_TEXT_MEDIA_COLUMNS, PRE_TEXT_SCOPE_MEDIA_COLUMNS, LEGACY_MEDIA_COLUMNS].find((candidate) => candidate.every((column, i) => columns[i] === column));
  if (!base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The profile Sheet's managed headers were changed. Existing data was not overwritten." });
  const continuation = new Map<string, { part: number; index: number }[]>();
  for (let i = base.length; i < columns.length; i++) {
    const match = /^(.*) \(continued (\d+)\)$/.exec(columns[i]);
    if (!match || !base.some((c) => c === match[1]) || Number(match[2]) < 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The managed Sheet has unsupported additional columns; existing data was preserved." });
    const parts = continuation.get(match[1]) ?? [];
    parts.push({ part: Number(match[2]), index: i });
    continuation.set(match[1], parts);
  }
  for (const parts of continuation.values()) {
    parts.sort((a, b) => a.part - b.part);
    if (parts.some((part, i) => part.part !== i + 2)) throw new Error("A continuation column is missing or duplicated.");
  }
  return { base, continuation };
}

/** Reconstitute validated current/legacy rows by header names before merging. */
export function unpackMediaRows(columns: string[], rows: unknown[][]): Record<string, string>[] {
  const { base, continuation } = managedMediaHeader(columns);
  return rows.filter((row) => row.some((value) => value !== null && value !== undefined && String(value) !== "")).map((row) => {
    const result: Record<string, string> = {};
    base.forEach((column, index) => {
      if (!removedMediaColumn(column)) result[column] = String(row[index] ?? "") + (continuation.get(column) ?? []).map((part) => String(row[part.index] ?? "")).join("");
    });
    if (!/^\d{1,40}$/.test(result["Post ID"])) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An existing media row has no valid ID; it was preserved instead of overwritten." });
    return result;
  });
}

/** Repeated fetches update the same comment ID and never duplicate replies. */
export function mergeSavedComments(previous: FbBrowserComment[], incoming: FbBrowserComment[]): { comments: FbBrowserComment[]; count: number } {
  const map = new Map<string, FbBrowserComment>();
  const walk = (comments: FbBrowserComment[], inheritedParent: string | null, depth: number) => {
    if (depth > 50) throw new Error("Stored comments exceed the supported nesting depth.");
    for (const source of comments) {
      if (!source || typeof source.id !== "string" || !source.id) throw new Error("A stored comment has no stable ID.");
      const old = map.get(source.id);
      const copy = { ...(old ?? source), replies: [] } as FbBrowserComment;
      for (const [key, value] of Object.entries(source)) {
        if (key === "replies" || key === "replyCount" || key === "depth" || value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
        if (key === "likeCount" && source.metricsAvailable === false) continue;
        if (key === "metricsAvailable" && value === false && old?.metricsAvailable) continue;
        (copy as unknown as Record<string, unknown>)[key] = value;
      }
      copy.parentId = source.parentId || inheritedParent || old?.parentId || null;
      copy.replyCount = 0;
      copy.depth = copy.parentId ? 1 : 0;
      map.set(source.id, copy);
      if (map.size > 100_000) throw new Error("This media's saved comments exceed the safe merge limit.");
      walk(source.replies ?? [], source.id, depth + 1);
    }
  };
  walk(previous, null, 0);
  walk(incoming, null, 0);
  const roots: FbBrowserComment[] = [];
  for (const comment of map.values()) {
    const visited = new Set([comment.id]);
    let parent = comment.parentId ? map.get(comment.parentId) : undefined;
    let ancestor = parent;
    while (ancestor) {
      if (visited.has(ancestor.id)) { parent = undefined; break; }
      visited.add(ancestor.id);
      ancestor = ancestor.parentId ? map.get(ancestor.parentId) : undefined;
    }
    if (parent) { parent.replies!.push(comment); parent.replyCount = parent.replies!.length; }
    else roots.push(comment);
  }
  return { comments: roots, count: map.size };
}

function parseSavedComments(value: string): FbBrowserComment[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as FbBrowserComment[];
  } catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stored comments JSON could not be read; the existing Sheet was left intact." }); }
}

export function mergeMediaSheetRows(previous: MediaSheetRows, incoming: PreparedMediaSheet): PreparedMediaSheet {
  const next = { photos: unpackMediaRows(incoming.columns, incoming.photos), reels: unpackMediaRows(incoming.columns, incoming.reels) };
  const profileFields = FB_MEDIA_COLUMNS.slice(1, FB_MEDIA_COLUMNS.indexOf("Post ID")).filter((column) => column !== "Collection" && column !== "Captured At");
  const profileUpdates: Record<string, string> = {};
  const captureTime = (row: Record<string, string>) => Date.parse(row["Captured At"] ?? "") || 0;
  const available = (value: string | undefined) => value !== undefined && value.trim() !== "";
  // Interrupted saves can leave older profile values in the second collection.
  // Prefer the most recently captured available field, not whichever tab is last.
  for (const row of [...previous.photos, ...previous.reels, ...next.photos, ...next.reels].sort((a, b) => captureTime(a) - captureTime(b))) for (const field of profileFields) if (available(row[field])) profileUpdates[field] = row[field];
  const merge = (existing: Record<string, string>[], updates: Record<string, string>[]) => {
    const rows = new Map<string, Record<string, string>>();
    for (const row of [...existing, ...updates]) {
      const id = row["Post ID"];
      const old = rows.get(id);
      const result = { ...(old ?? row) };
      const olderGrid = Boolean(old && captureTime(old) && captureTime(row) && captureTime(row) < captureTime(old));
      const delayedInitial = Boolean(old && /^(complete|partial|failed|cancelled)$/.test(old["Comments Status"])
        && /^(pending|running)$/.test(row["Comments Status"]) && (!captureTime(row) || captureTime(row) <= captureTime(old)));
      for (const [key, value] of Object.entries(row)) {
        if (delayedInitial && /^(Comments Status|Comments Stop Reason|Comments Error)$/.test(key)) continue;
        // This timestamp belongs to the media grid, which can come from cache.
        // Freshly observed comments/engagement must still update that media.
        if (olderGrid && key === "Captured At") continue;
        // A blank verified text total is meaningful when this incoming result
        // includes a scoped comments measurement, so it must not retain stale
        // text-only coverage after an observed-node update.
        if (key === "Comments Actual Text Count (Verified)"
          && /^(text_only|observed_nodes)$/.test(row["Comments Content Scope"] ?? "")
          && available(row["Comments Status"])) {
          result[key] = value;
          continue;
        }
        // A later comments pass can deliberately clear a previous verified
        // availability classification (for example after newly visible IDs or
        // a timeout). Blank values are therefore meaningful only when this row
        // carries a fresh comment status; metadata-only saves preserve it.
        if ((key === "Comments Accessible Count (Verified)" || key === "Comments Accessibility Status" || key === "Comments Accessibility Evidence")
          && available(row["Comments Status"])) {
          result[key] = value;
          continue;
        }
        if (available(value)) result[key] = value;
      }
      if (old?.["Comments JSON"] || row["Comments JSON"]) {
        const saved = mergeSavedComments(parseSavedComments(old?.["Comments JSON"] ?? ""), parseSavedComments(row["Comments JSON"] ?? ""));
        result["Comments JSON"] = JSON.stringify(saved.comments);
        result["Comments Scraped Count"] = String(saved.count);
      }
      if (row["Comments Status"] === "complete") result["Comments Error"] = "";
      if (row["Reactions Status"] === "complete") {
        result["Reactions Error"] = "";
        // Absence of the approximate flag on a complete observed result means
        // the new counts are exact; an older rounded flag must not stick forever.
        result["Reaction Counts Approximate"] = row["Reaction Counts Approximate"] || "false";
      }
      rows.set(id, result);
    }
    const published = (row: Record<string, string>) => Date.parse(row["Published Time"] ?? "");
    // Keep old media at the top and append newer media at the bottom. Unknown
    // publication times retain their arrival order, so a new unknown item also
    // lands after the already-saved rows instead of jumping to the top.
    return [...rows.values()]
      .map((row, arrival) => ({ row, arrival, published: published(row) }))
      .sort((a, b) => {
        const aKnown = Number.isFinite(a.published), bKnown = Number.isFinite(b.published);
        if (aKnown && bKnown) return a.published - b.published || a.arrival - b.arrival;
        if (aKnown) return -1;
        if (bKnown) return 1;
        return a.arrival - b.arrival;
      })
      .map(({ row }, index) => ({ ...row, ...profileUpdates, Index: String(index + 1) }));
  };
  const prepared = packMediaRows({ photos: merge(previous.photos, next.photos), reels: merge(previous.reels, next.reels) }, incoming.profileKey, incoming.profileName);
  // Once a continuation column exists its position is stable. This permits a
  // retry to read older, not-yet-updated rows after a request stops mid-batch.
  // App-owned scalar fields must precede the JSON continuation columns. This
  // is a one-way managed-header upgrade; values are aligned by header name.
  const columns: string[] = [...FB_MEDIA_COLUMNS];
  for (const column of [...(previous.columns ?? []), ...prepared.columns]) {
    if (/^.+ \(continued \d+\)$/.test(column) && !columns.includes(column)) columns.push(column);
  }
  const indexes = columns.map((column) => prepared.columns.indexOf(column));
  const align = (rows: string[][]) => rows.map((row) => indexes.map((index) => index < 0 ? "" : row[index]));
  const aligned = { ...prepared, columns, photos: align(prepared.photos), reels: align(prepared.reels) };
  if (columns.length > 2000 || columns.length * (aligned.photos.length + aligned.reels.length + 4) > 9_000_000 || Buffer.byteLength(JSON.stringify(aligned), "utf8") > MAX_BYTES * 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The profile Sheet has reached its safe continuation-column capacity; existing data was not changed." });
  return aligned;
}

export async function readExistingMediaRows(sheets: sheets_v4.Sheets, fileId: string, tabs: sheets_v4.Schema$SheetProperties[]): Promise<ExistingMediaSheetRows> {
  const result: ExistingMediaSheetRows = { photos: [], reels: [], spans: { photos: 0, reels: 0 }, columns: [...FB_MEDIA_COLUMNS], columnDeletes: [], columnInserts: [], columnMoves: [] };
  let bytes = 0;
  for (const title of ["Photos", "Reels"] as const) {
    const tab = tabs.find((t) => t.title === title);
    if (!tab) continue;
    const width = tab.gridProperties?.columnCount ?? FB_MEDIA_COLUMNS.length;
    const height = tab.gridProperties?.rowCount ?? 1;
    if (width > 2000) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The existing Sheet is wider than the safe read limit; no data was changed." });
    const headerRead = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${title}'!A1:${sheetColumn(width - 1)}1`, valueRenderOption: "UNFORMATTED_VALUE" });
    const header = (headerRead.data.values?.[0] ?? []).map(String);
    if (!header.length) {
      if (height > 1) {
        const existingValues = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${title}'!A2:${sheetColumn(width - 1)}${Math.min(height, MAX_SAVED_ROWS + 2)}`, valueRenderOption: "UNFORMATTED_VALUE" });
        if (existingValues.data.values?.some((row) => row.some((value) => value !== null && value !== undefined && String(value) !== ""))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The managed Sheet has data without its headers; existing values were preserved." });
      }
      continue;
    }
    const managed = managedMediaHeader(header);
    const indexes = header.flatMap((column, index) => removedMediaColumn(column) ? [index] : []);
    if (indexes.length && height > MAX_SAVED_ROWS + 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The legacy Sheet is too tall to validate safely before migration; existing data was preserved." });
    const idColumn = sheetColumn(header.indexOf("Post ID"));
    const scanned = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${title}'!${idColumn}1:${idColumn}${Math.min(height, MAX_SAVED_ROWS + 2)}`, valueRenderOption: "UNFORMATTED_VALUE" });
    const rowCount = (scanned.data.values?.length ?? 1) - 1;
    result.spans![title === "Photos" ? "photos" : "reels"] = rowCount;
    if (rowCount > MAX_SAVED_ROWS) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The existing profile exceeds the safe read limit; no rows were changed." });
    const values: unknown[][] = [];
    for (let offset = 0; offset < rowCount; offset += 100) {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${title}'!A${offset + 2}:${sheetColumn(header.length - 1)}${Math.min(rowCount, offset + 100) + 1}`, valueRenderOption: "UNFORMATTED_VALUE" });
      const part = response.data.values ?? [];
      bytes += Buffer.byteLength(JSON.stringify(part), "utf8");
      if (bytes > MAX_BYTES * 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The existing profile data exceeds the safe merge limit; it was not truncated." });
      values.push(...part);
    }
    result[title === "Photos" ? "photos" : "reels"] = unpackMediaRows(header, values);
    if (indexes.length && rowCount + 2 <= height) {
      const tail = await sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${title}'!A${rowCount + 2}:${sheetColumn(header.length - 1)}${height}`, valueRenderOption: "UNFORMATTED_VALUE" });
      if (tail.data.values?.some((row) => row.some((value) => value !== null && value !== undefined && String(value) !== ""))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A legacy media row has data without a Post ID; existing values were preserved." });
    }
    if (indexes.length) result.columnDeletes.push({ sheetId: tab.sheetId!, indexes });
    const survivingBase = managed.base.filter((column) => !removedMediaColumn(column));
    const trailingDelta = managed.base === PRE_REPORTED_DELTA_POSITION_MEDIA_COLUMNS;
    const deltaTarget = FB_MEDIA_COLUMNS.indexOf("Reported Delta Count");
    let planned = [...survivingBase];
    if (trailingDelta) {
      const startIndex = planned.indexOf("Reported Delta Count");
      if (startIndex < 0 || deltaTarget < 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The profile Sheet's Reported Delta Count column could not be relocated safely." });
      result.columnMoves.push({ sheetId: tab.sheetId!, startIndex, destinationIndex: deltaTarget });
      const [delta] = planned.splice(startIndex, 1);
      planned.splice(deltaTarget, 0, delta);
    }
    // Insert absent managed scalars at their final positions. Each insertion
    // runs after the prior one, so later indexes are already final indexes.
    for (let index = 0; index < FB_MEDIA_COLUMNS.length; index++) {
      const expected = FB_MEDIA_COLUMNS[index];
      if (planned[index] === expected) continue;
      if (planned.includes(expected)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The profile Sheet's managed headers are in an unsupported order. Existing data was not overwritten." });
      planned.splice(index, 0, expected);
      result.columnInserts.push({ sheetId: tab.sheetId!, startIndex: index, count: 1 });
    }
    if (JSON.stringify(planned) !== JSON.stringify(FB_MEDIA_COLUMNS)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The profile Sheet's managed headers were changed. Existing data was not overwritten." });
    for (const column of header) if (!removedMediaColumn(column) && !result.columns!.includes(column)) result.columns!.push(column);
  }
  return result;
}

async function authorizedConnection(profile: ExportProfile, brandId: string) {
  const [{ getDb }, { assertBrandAccess }] = await Promise.all([import("@/lib/supabase/db"), import("@/server/trpc/index")]);
  assertBrandAccess(profile, brandId);
  const db = getDb();
  const { data: brand } = await db.from("brands").select("id,name").eq("id", brandId).eq("org_id", profile.org_id).single();
  if (!brand) throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found in this organization." });
  const { data: conn } = await db.from("drive_connections").select("root_folder_id").eq("brand_id", brandId).eq("is_active", true).single();
  if (!conn || !/^[A-Za-z0-9_-]+$/.test(conn.root_folder_id)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Google Drive for this brand before saving." });
  return { brand: brand as { id: string; name: string }, rootId: String(conn.root_folder_id) };
}

export async function mediaExportDestinations(profile: ExportProfile): Promise<{ brandId: string; brandName: string; rootFolderUrl: string }[]> {
  const [{ getDb }, { assertBrandAccess }] = await Promise.all([import("@/lib/supabase/db"), import("@/server/trpc/index")]);
  const db = getDb();
  const { data: brands, error } = await db.from("brands").select("id,name").eq("org_id", profile.org_id).order("name");
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not load export destinations." });
  const allowed = (brands as { id: string; name: string }[] ?? []).filter((brand) => { try { assertBrandAccess(profile, brand.id); return true; } catch { return false; } });
  if (!allowed.length) return [];
  const { data: connections, error: connectionError } = await db.from("drive_connections").select("brand_id,root_folder_id").eq("is_active", true).in("brand_id", allowed.map((b) => b.id));
  if (connectionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not load connected export destinations." });
  return (connections as { brand_id: string; root_folder_id: string }[] ?? []).flatMap((conn) => {
    const brand = allowed.find((b) => b.id === conn.brand_id);
    return brand && /^[A-Za-z0-9_-]+$/.test(conn.root_folder_id) ? [{ brandId: brand.id, brandName: brand.name, rootFolderUrl: `https://drive.google.com/drive/folders/${conn.root_folder_id}` }] : [];
  });
}

const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function exportFolder(drive: drive_v3.Drive, rootId: string): Promise<{ id: string; url: string }> {
  const root = await drive.files.get({ fileId: rootId, fields: "id,mimeType,trashed,capabilities(canAddChildren)", supportsAllDrives: true });
  if (root.data.trashed || root.data.mimeType !== FOLDER_MIME || root.data.capabilities?.canAddChildren === false) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The connected brand root is not a writable Drive folder." });
  const found = await drive.files.list({ q: `'${escaped(rootId)}' in parents and name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`, fields: "files(id,webViewLink)", orderBy: "createdTime", pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true });
  let folder = found.data.files?.[0];
  if (!folder) folder = (await drive.files.create({ requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: [rootId] }, fields: "id,webViewLink", supportsAllDrives: true }, { retry: false })).data;
  if (!folder.id || !folder.webViewLink) throw new Error("The export folder was not verified.");
  return { id: folder.id, url: folder.webViewLink };
}

export async function writeMediaSheetValues(sheets: sheets_v4.Sheets, fileId: string, incoming: PreparedMediaSheet, fresh: boolean, replaceExisting = false): Promise<void> {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: "sheets(properties,conditionalFormats)" });
  const existing = metadata.data.sheets?.map((s) => s.properties!).filter(Boolean) ?? [];
  const existingRows: ExistingMediaSheetRows = fresh ? { photos: [], reels: [], columnDeletes: [], columnInserts: [], columnMoves: [] } : await readExistingMediaRows(sheets, fileId, existing);
  const saved: ExistingMediaSheetRows = replaceExisting ? { ...existingRows, photos: [], reels: [] } : existingRows;
  const prepared = mergeMediaSheetRows(saved, incoming);
  if (saved.columnDeletes.length) {
    const deletions: sheets_v4.Schema$Request[] = [];
    for (const change of saved.columnDeletes) {
      // Higher indexes first prevent one deletion from shifting a later target.
      const ranges: { start: number; end: number }[] = [];
      for (const index of [...change.indexes].sort((a, b) => b - a)) {
        const range = ranges.at(-1);
        if (range && index === range.start - 1) range.start = index;
        else ranges.push({ start: index, end: index + 1 });
      }
      for (const range of ranges) deletions.push({ deleteDimension: { range: { sheetId: change.sheetId, dimension: "COLUMNS", startIndex: range.start, endIndex: range.end } } });
    }
    // Both collections and comments were validated above. One atomic request
    // shifts every stored row together; writing a shorter header first would
    // relabel old rows if a later values batch failed. On an ambiguous response,
    // retry must re-read the actual headers, never replay index deletions.
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: fileId, requestBody: { requests: deletions } }, { retry: false });
    for (const change of saved.columnDeletes) {
      const tab = existing.find((item) => item.sheetId === change.sheetId)!;
      tab.gridProperties = { ...tab.gridProperties, columnCount: (tab.gridProperties?.columnCount ?? LEGACY_MEDIA_COLUMNS.length) - change.indexes.length };
    }
  }
  if (saved.columnMoves.length) {
    const moves: sheets_v4.Schema$Request[] = saved.columnMoves.map((change) => ({ moveDimension: {
      source: { sheetId: change.sheetId, dimension: "COLUMNS", startIndex: change.startIndex, endIndex: change.startIndex + 1 },
      destinationIndex: change.destinationIndex,
    } }));
    // A column move shifts the header and every stored row together before a
    // values write. If the response is ambiguous, the next save rereads the
    // normalized header rather than replaying an index-based operation.
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: fileId, requestBody: { requests: moves } }, { retry: false });
  }
  if (saved.columnInserts.length) {
    const upgrades: sheets_v4.Schema$Request[] = [];
    for (const change of saved.columnInserts) {
      upgrades.push({ insertDimension: { range: {
        sheetId: change.sheetId, dimension: "COLUMNS", startIndex: change.startIndex, endIndex: change.startIndex + change.count,
      }, inheritFromBefore: true } });
    }
    for (const sheetId of new Set(saved.columnInserts.map((change) => change.sheetId))) {
      upgrades.push({ updateCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: prepared.columns.length },
        rows: [{ values: prepared.columns.map((column) => ({ userEnteredValue: { stringValue: column } })) }],
        fields: "userEnteredValue",
      } });
      const tab = existing.find((item) => item.sheetId === sheetId)!;
      const added = saved.columnInserts.filter((change) => change.sheetId === sheetId).reduce((sum, change) => sum + change.count, 0);
      tab.gridProperties = { ...tab.gridProperties, columnCount: (tab.gridProperties?.columnCount ?? 1) + added };
    }
    // The row shift and new header are one atomic Google Sheets operation. An
    // ambiguous response is resolved by reading headers again; do not replay
    // an index-based insertion.
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: fileId, requestBody: { requests: upgrades } }, { retry: false });
  }
  let nextId = Math.max(0, ...existing.map((s) => s.sheetId ?? 0)) + 1;
  const requests: sheets_v4.Schema$Request[] = [];
  const targets = (["Photos", "Reels"] as const).map((title, index) => {
    let current = existing.find((s) => s.title === title);
    if (!current && fresh && index === 0 && existing.length === 1) {
      current = { ...existing[0], title };
      requests.push({ updateSheetProperties: { properties: { sheetId: current.sheetId, title }, fields: "title" } });
    }
    if (!current) {
      current = { sheetId: nextId++, title, gridProperties: { rowCount: 1, columnCount: prepared.columns.length } };
      requests.push({ addSheet: { properties: current } });
    }
    const rows = title === "Photos" ? prepared.photos : prepared.reels;
    // Retain one blank row after the data for bounded row-count verification,
    // including the unselected collection's header-only tab.
    const rowCount = Math.max(2, current.gridProperties?.rowCount ?? 1, rows.length + 2);
    const columnCount = Math.max(current.gridProperties?.columnCount ?? 1, prepared.columns.length);
    requests.push({ updateSheetProperties: { properties: { sheetId: current.sheetId, gridProperties: { rowCount, columnCount, frozenRowCount: 1, frozenColumnCount: 2 } }, fields: "gridProperties" } });
    requests.push({ repeatCell: { range: { sheetId: current.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: prepared.columns.length }, cell: { userEnteredFormat: { backgroundColor: { red: 0.12, green: 0.2, blue: 0.32 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: "WRAP" } }, fields: "userEnteredFormat" } });
    requests.push({ updateDimensionProperties: { range: { sheetId: current.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: prepared.columns.length }, properties: { pixelSize: 180 }, fields: "pixelSize" } });
    requests.push(...commentCountShortfallRequests(current.sheetId!, prepared.columns,
      metadata.data.sheets?.find((sheet) => sheet.properties?.sheetId === current.sheetId)?.conditionalFormats ?? []));
    return { title, rows, previousRows: (saved.spans?.[title === "Photos" ? "photos" : "reels"] ?? saved[title === "Photos" ? "photos" : "reels"].length) + 1, previousColumns: current.gridProperties?.columnCount ?? 1 };
  });
  // Conditional-format indexes may shift after the request commits. A failed
  // response must be retried through a fresh metadata read, never replayed.
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: fileId, requestBody: { requests } }, { retry: false });
  for (const target of targets) {
    const values = [prepared.columns, ...target.rows];
    // Rewrite current data first. Empty cells in the same ranges clear old
    // continuation columns without deleting unrelated tabs or permissions.
    const width = Math.max(prepared.columns.length, Math.min(target.previousColumns, 2000));
    let start = 0;
    while (start < values.length) {
      let size = 0, end = start;
      while (end < values.length && (size < 700_000 || end === start)) { size += Buffer.byteLength(JSON.stringify(values[end]), "utf8"); end++; }
      const batch = values.slice(start, end).map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
      await sheets.spreadsheets.values.update({ spreadsheetId: fileId, range: `'${target.title}'!A${start + 1}:${sheetColumn(width - 1)}${end}`, valueInputOption: "RAW", requestBody: { majorDimension: "ROWS", values: batch } });
      start = end;
    }
    // These are application-owned collection tabs; removed media must not leave
    // stale rows from a prior snapshot behind. Clear only the bounded old tail.
    if (target.previousRows > values.length) await sheets.spreadsheets.values.clear({ spreadsheetId: fileId, range: `'${target.title}'!A${values.length + 1}:${sheetColumn(width - 1)}${Math.min(target.previousRows, MAX_SAVED_ROWS + 1)}`, requestBody: {} });
  }
  const idIndex = prepared.columns.indexOf("Post ID");
  const commentIndex = prepared.columns.indexOf("Comments Scraped Count");
  const ranges = targets.flatMap((t) => [`'${t.title}'!A1:${sheetColumn(prepared.columns.length - 1)}1`, `'${t.title}'!${sheetColumn(idIndex)}2:${sheetColumn(idIndex)}${Math.max(2, t.rows.length + 2)}`, `'${t.title}'!${sheetColumn(commentIndex)}2:${sheetColumn(commentIndex)}${Math.max(2, t.rows.length + 1)}`]);
  const verification = await sheets.spreadsheets.values.batchGet({ spreadsheetId: fileId, ranges, valueRenderOption: "UNFORMATTED_VALUE" });
  for (const [i, target] of targets.entries()) {
    const header = verification.data.valueRanges?.[i * 3]?.values?.[0] ?? [];
    const ids = (verification.data.valueRanges?.[i * 3 + 1]?.values ?? []).map((r) => String(r[0] ?? ""));
    const comments = verification.data.valueRanges?.[i * 3 + 2]?.values ?? [];
    if (JSON.stringify(header) !== JSON.stringify(prepared.columns) || JSON.stringify(ids) !== JSON.stringify(target.rows.map((r) => r[idIndex])) || target.rows.some((r, row) => String(comments[row]?.[0] ?? "") !== r[commentIndex])) throw new Error("The saved Google Sheet did not pass header and row readback verification.");
  }
}

export async function saveMediaSheet(profile: ExportProfile, input: { brandId: string; runId: string; pages: FbBrowserPage[] }): Promise<MediaSheetResult> {
  const prepared = prepareMediaSheet(input.pages);
  const connection = await authorizedConnection(profile, input.brandId);
  const [{ getAuthenticatedDrive }, { google }, { getRedis }] = await Promise.all([import("@/server/services/drive/client"), import("googleapis"), import("@/lib/redis")]);
  const redis = getRedis();
  const lockKey = `fb-sheet-lock:${profile.org_id}:${input.brandId}`;
  const token = randomUUID();
  if (!(await redis.set(lockKey, token, "EX", 180, "NX"))) throw new TRPCError({ code: "CONFLICT", message: "This brand already has a Sheet save in progress. Retry shortly." });
  const renew = setInterval(() => { void redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],180) end return 0", 1, lockKey, token).catch(() => {}); }, 30_000);
  const mappingKey = `fb-sheet-profile:${profile.org_id}:${input.brandId}:${prepared.profileKey}`;
  try {
    const requestKey = `fb-sheet-request:${profile.org_id}:${input.brandId}:${input.runId}`;
    const boundProfile = await redis.get(requestKey);
    if (boundProfile && boundProfile !== prepared.profileKey) throw new TRPCError({ code: "CONFLICT", message: "This save request already belongs to a different Facebook profile." });
    await redis.set(requestKey, prepared.profileKey, "EX", 30 * 86400);
    const drive = await getAuthenticatedDrive(input.brandId, profile.org_id);
    const sheets = google.sheets({ version: "v4", auth: drive.context._options.auth });
    const folder = await exportFolder(drive, connection.rootId);
    const appProperties = { mh_org: profile.org_id, mh_brand: input.brandId, mh_fb_profile: prepared.profileKey };
    const pointer = {
      get: () => redis.get(mappingKey),
      set: (id: string) => redis.set(mappingKey, id, "EX", 30 * 86400),
      clear: () => redis.del(mappingKey),
    };
    const verified = await writeResolvedMediaSheetTarget(drive, {
      folderId: folder.id, profileName: prepared.profileName, properties: appProperties, pointer,
      write: (fileId, fresh) => writeMediaSheetValues(sheets, fileId, prepared, fresh),
    });
    // Keep the profile-list summary cheap to render. Counts are read from the
    // final Sheet after its verified write, so a refresh reports merged totals
    // rather than merely the size of this fetch.
    const postIdColumn = sheetColumn(FB_MEDIA_COLUMNS.indexOf("Post ID"));
    const counts = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: verified.id!,
      ranges: [`Photos!${postIdColumn}2:${postIdColumn}`, `Reels!${postIdColumn}2:${postIdColumn}`],
      valueRenderOption: "UNFORMATTED_VALUE",
    }).then((response) => ({
      photos: response.data.valueRanges?.[0]?.values?.filter((row) => String(row[0] ?? "").trim()).length ?? 0,
      reels: response.data.valueRanges?.[1]?.values?.filter((row) => String(row[0] ?? "").trim()).length ?? 0,
    })).catch(() => null);
    if (counts) {
      const { getDb } = await import("@/lib/supabase/db");
      await getDb().from("fb_profile_stats").upsert({
        org_id: profile.org_id, brand_id: input.brandId, profile_key: prepared.profileKey,
        photos_count: counts.photos, reels_count: counts.reels, updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,brand_id,profile_key" }).then(() => {}).catch(() => {});
    }
    return {
      url: verified.webViewLink!, folderUrl: folder.url, fileId: verified.id!,
      updatedAt: verified.modifiedTime || new Date().toISOString(),
    };

  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Google Drive could not complete and verify this Sheet save. Check the brand connection and retry the same run.", cause: error });
  } finally {
    clearInterval(renew);
    await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0", 1, lockKey, token).catch(() => {});
  }
}
