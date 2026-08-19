/**
 * Client-side export helpers for scraped Facebook data.
 *
 * Nested records (a post carrying comments, a comment carrying replies) are
 * flattened into one row per record so the CSV opens cleanly in a spreadsheet,
 * while the JSON export keeps the full nested shape.
 */
import Papa from "papaparse";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export function downloadJson(data: unknown, basename: string): void {
  download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `${basename}-${stamp()}.json`);
}

export function downloadCsv(rows: Record<string, unknown>[], basename: string): void {
  if (!rows.length) return;
  // Union of keys across rows — records are not uniformly shaped.
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = Papa.unparse({ fields: columns, data: rows.map((row) => columns.map((c) => row[c] ?? "")) });
  download(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), `${basename}-${stamp()}.csv`);
}

/** Scalars stay; arrays/objects become readable single-cell strings. */
function flattenValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return value;
  return String(value);
}

export function postsToRows(posts: any[]): Record<string, unknown>[] {
  return posts.map((post) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(post)) {
      if (key === "commentsFull") continue;
      row[key] = flattenValue(value);
    }
    row.commentsScraped = Array.isArray(post.commentsFull) ? post.commentsFull.length : 0;
    return row;
  });
}

/** One row per comment AND per reply, linked by parentCommentId. */
export function commentsToRows(comments: any[], postUrl = ""): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const push = (comment: any, parentId: string) => {
    rows.push({
      postUrl,
      parentCommentId: parentId,
      commentId: comment.commentId,
      commentUrl: comment.commentUrl,
      commenterName: comment.commenterName,
      commenterId: comment.commenterId,
      commenterUrl: comment.commenterUrl,
      commenterMeta: comment.commenterMeta,
      commentText: comment.commentText,
      commentTime: comment.commentTime,
      commentImage: comment.commentImage,
      commentReactionCount: comment.commentReactionCount,
      replyCount: comment.replies?.length ?? 0,
      depth: comment.depth,
      source: comment.source,
    });
    for (const reply of comment.replies ?? []) push(reply, comment.commentId);
  };
  for (const comment of comments) push(comment, "");
  return rows;
}

export function reactorsToRows(reactors: any[]): Record<string, unknown>[] {
  return reactors.map((r) => ({ name: r.name, link: r.link, type: r.type }));
}

export function profileToRows(profile: any): Record<string, unknown>[] {
  if (!profile) return [];
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) row[key] = flattenValue(value);
  return [row];
}
