/**
 * Client-side export helpers for scraped Facebook data.
 *
 * Flattened into structured rows per record so the CSV opens cleanly in
 * Excel/Google Sheets, supporting Pages, Profiles, Posts, and Comments.
 */
import type { FbBrowserPage, FbBrowserPost, FbBrowserComment } from "@/server/services/facebook/browser-fetcher";
import type { FbScrapedPost, FbScrapedComment, FbScrapedReactor, FbScrapedProfile, FbScrapedGroup } from "@/server/services/facebook/scraper-types";

/** Display/count nested and legacy flat replies once, without changing the exported tree. */
export function flattenFbComments(comments: FbBrowserComment[]): FbBrowserComment[] {
  const rows: FbBrowserComment[] = [];
  const seen = new Set<string>();
  const visit = (comment: FbBrowserComment, parentDepth: number) => {
    const depth = Math.max(comment.depth ?? 0, parentDepth);
    if (!comment.id || !seen.has(comment.id)) {
      if (comment.id) seen.add(comment.id);
      rows.push({ ...comment, depth });
    }
    for (const reply of comment.replies ?? []) visit(reply, depth + 1);
  };
  for (const comment of comments) visit(comment, 0);
  return rows;
}

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

export async function downloadCsv(rows: Record<string, unknown>[], basename: string): Promise<void> {
  if (!rows.length) return;
  const { default: Papa } = await import("papaparse");
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = Papa.unparse({ fields: columns, data: rows.map((row) => columns.map((c) => row[c] ?? "")) });
  download(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }), `${basename}-${stamp()}.csv`);
}

/** Scalars stay; arrays/objects become readable single-cell strings. */
function flattenValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return value;
  return String(value);
}

export function exportFbPageSummaryCsv(page: FbBrowserPage): void {
  const s = page.stats;
  const metricsAvailable = page.posts.length > 0 && page.posts.every((post) => post.metricsAvailable !== false);
  const commentPosts = page.posts.filter((post) => post.commentsStatus !== undefined || (post.commentsData?.length ?? 0) > 0);
  const allKnown = (values: Array<number | null | undefined>) => values.length > 0 && values.every((value) => value != null);
  const sum = (values: Array<number | null | undefined>): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const reportedCommentCounts = commentPosts.map((post) => post.commentsReportedCount ?? (post.metricsAvailable === false ? null : post.comments));
  const scrapedTextCommentCounts = commentPosts.map((post) => post.commentsTextCount ?? (
    (post.commentsStatus === "complete" || post.commentsStatus === "partial") && Array.isArray(post.commentsData)
      ? flattenFbComments(post.commentsData).length
      : null
  ));
  const actualTextCommentCounts = commentPosts.map((post) => {
    const reported = post.commentsReportedCount ?? (post.metricsAvailable === false ? null : post.comments);
    return post.commentsContentScope === "text_only"
      && post.commentsStatus === "complete"
      && reported != null
      && post.commentsObservedCount === reported
      && post.commentsExcludedNonTextCount != null
      ? Math.max(0, reported - post.commentsExcludedNonTextCount)
      : null;
  });
  const row = {
    "Page / Profile Name": page.name,
    "Handle / ID": page.handle,
    "Facebook URL": page.url,
    "Profile Picture": page.profilePic ?? "",
    "Cover Photo": page.coverPic ?? "",
    Category: page.category ?? "",
    "About / Intro": page.about ?? "",
    "Is Verified": page.verified ? "Yes" : "No",
    "Total Followers": page.followers ?? "",
    "Total Page Likes": page.likes ?? "",
    "Content Type": page.contentType ?? "posts",
    "Captured At": page.retrieval?.capturedAt ?? "",
    "From Cached Snapshot": page.retrieval ? (page.retrieval.fromCache ? "Yes" : "No") : "",
    "Requested Count": page.retrieval?.requested ?? s?.requestedPosts ?? "",
    "Stop Reason": page.retrieval?.stopReason ?? "",
    "Scraped Posts Count": s?.scrapedPosts ?? page.posts.length,
    "Comments Count (Reported)": allKnown(reportedCommentCounts) ? sum(reportedCommentCounts) : "",
    "Scraped Text Comments Count": allKnown(scrapedTextCommentCounts) ? sum(scrapedTextCommentCounts) : "",
    "Actual Text Comments Count (Verified)": allKnown(actualTextCommentCounts) ? sum(actualTextCommentCounts) : "",
    "Total Likes Across Scraped Posts": metricsAvailable ? s?.totalLikesScraped ?? "" : "",
    "Total Shares Across Scraped Posts": metricsAvailable ? s?.totalSharesScraped ?? "" : "",
    "Engagement Rate / Metric": metricsAvailable ? s?.engagementRate ?? "" : "",
    Email: page.email ?? "",
    Phone: page.phone ?? "",
    Website: page.website ?? "",
    Instagram: page.instagram ?? "",
    "Twitter / X": page.twitter ?? "",
  };

  downloadCsv([row], `facebook_${page.handle}_summary`);
}

export const FB_MEDIA_COLUMNS = [
  "Index", "Page / Profile Name", "Handle / ID", "Profile URL", "Collection", "Captured At",
  "Category", "About / Intro", "Total Followers", "Email", "Phone", "Instagram", "Twitter / X",
  "Post ID", "Post URL", "Content Type", "Message / Caption", "Published Time",
  "Video URL", "Views Count", "Reactions Count", "Like Count", "Love Count", "Care Count",
  "Haha Count", "Wow Count", "Sad Count", "Angry Count", "Shares Count", "Reactions Status",
  "Reaction Counts Approximate", "Reactions Error", "Comments Count (Reported)", "Reported Delta Count", "Comments Scraped Count",
  "Comments Status", "Comments Stop Reason", "Comments Error", "Comments JSON",
  // Rich-media comment nodes are retained as placeholders. Facebook's reported
  // total can still include hidden, deleted, or otherwise unavailable nodes.
  "Comments Retrieved Count", "Comments Text Count", "Comments Actual Text Count (Verified)", "Comments Excluded Non-text Count",
  "Comments Excluded Attachment Count", "Comments Content Scope", "Comments Source View",
  // These are deliberately separate from Facebook's raw badge. A nonblank
  // verified target means two clean scans exposed the same finite public view;
  // it must never overwrite the reported total or hide its audit gap.
  "Comments Accessible Count (Verified)", "Comments Accessibility Status", "Comments Accessibility Evidence",
] as const;

function commentsAccessibilityStatus(post: FbBrowserPost): string {
  const evidence = post.commentsAccessibility;
  if (!evidence) return "";
  const view = evidence.sourceView === "all" ? "All comments" : "Newest";
  if (post.commentsVerifiedAccessibleCount != null) {
    return `Verified after ${evidence.stablePasses} matching ${view} scans`;
  }
  return `Confirmation pending: ${evidence.stablePasses} clean ${view} scan${evidence.stablePasses === 1 ? "" : "s"}`;
}

function commentsAccessibilityEvidence(post: FbBrowserPost): string {
  const evidence = post.commentsAccessibility;
  if (!evidence) return "";
  // Export enough durable proof to continue a second clean scan after a
  // workspace reload, but never an internal attempt identifier.
  return JSON.stringify({
    sourceView: evidence.sourceView,
    stablePasses: evidence.stablePasses,
    reportedCount: evidence.reportedCount,
    lastScanFingerprint: evidence.lastScanFingerprint,
    verifiedAt: evidence.verifiedAt ?? null,
  });
}

/** Shared by native Google Sheets and legacy CSV downloads. No browser work here. */
export function buildFbMediaRows(page: FbBrowserPage): Record<string, unknown>[] {
  const posts = page.posts || [];
  if (!posts.length) return [];
  const profileContext = {
    "Page / Profile Name": page.name,
    "Handle / ID": page.handle,
    "Profile URL": page.url,
    Collection: page.contentType === "reels" ? "Reels" : page.contentType === "posts" ? "Photos" : "Posts",
    "Captured At": page.retrieval?.capturedAt ?? "",
    Category: page.category ?? "",
    "About / Intro": page.about ?? "",
    "Total Followers": page.followers ?? "",
    Email: page.email ?? "",
    Phone: page.phone ?? "",
    Instagram: page.instagram ?? "",
    "Twitter / X": page.twitter ?? "",
  };

  const rows: Record<string, unknown>[] = posts.map((post: FbBrowserPost, idx: number) => {
    const hasComments = post.commentsStatus !== undefined || (post.commentsData?.length ?? 0) > 0;
    const reportedComments = post.commentsReportedCount ?? (post.metricsAvailable === false ? null : post.comments);
    // The collector records the visible Newest tray total as soon as one clean
    // scan has also collected that many entries.  A second matching scan is
    // still retained separately as audit evidence, but must not leave this
    // user-requested operational column blank in the meantime.
    const effectiveReportedDeltaCount = post.commentsReportedDeltaCount ?? post.commentsVerifiedAccessibleCount;
    const reportedDeltaCount = effectiveReportedDeltaCount != null
      ? reportedComments != null
        ? Math.min(reportedComments, Math.max(flattenFbComments(post.commentsData ?? []).length, effectiveReportedDeltaCount))
        : Math.max(flattenFbComments(post.commentsData ?? []).length, effectiveReportedDeltaCount)
      : null;
    const verifiedActualTextCount = post.commentsContentScope === "text_only"
      && post.commentsStatus === "complete"
      && reportedComments != null
      && post.commentsObservedCount === reportedComments
      && post.commentsExcludedNonTextCount != null
      ? Math.max(0, reportedComments - post.commentsExcludedNonTextCount)
      : null;
    const engagement = post.engagement;
    return {
      Index: idx + 1,
      ...profileContext,
      "Post ID": post.postId ?? "",
      "Post URL": post.url ?? "",
      "Content Type": post.mediaType ?? (post.isVideo ? "reel" : "photo"),
      "Message / Caption": post.text ?? "",
      "Published Time": post.publishedTime ?? "",
      "Video URL": post.video ?? "",
      "Views Count": post.views ?? "",
      "Reactions Count": engagement ? engagement.totalReactions ?? "" : post.metricsAvailable === false ? "" : post.likes,
      "Like Count": engagement?.reactions.like ?? "",
      "Love Count": engagement?.reactions.love ?? "",
      "Care Count": engagement?.reactions.care ?? "",
      "Haha Count": engagement?.reactions.haha ?? "",
      "Wow Count": engagement?.reactions.wow ?? "",
      "Sad Count": engagement?.reactions.sad ?? "",
      "Angry Count": engagement?.reactions.angry ?? "",
      "Shares Count": engagement ? engagement.shares ?? "" : post.metricsAvailable === false ? "" : post.shares,
      "Reactions Status": engagement?.status ?? "",
      "Reaction Counts Approximate": engagement?.approximate ?? "",
      "Reactions Error": engagement?.error ?? "",
      "Comments Count (Reported)": hasComments ? reportedComments ?? "" : "",
      "Comments Scraped Count": hasComments ? flattenFbComments(post.commentsData ?? []).length : "",
      "Comments Status": hasComments ? post.commentsStatus ?? "unknown" : "",
      "Comments Stop Reason": hasComments ? post.commentsStopReason ?? "" : "",
      "Comments Error": hasComments ? post.commentsError ?? "" : "",
      "Comments JSON": hasComments ? JSON.stringify(post.commentsData ?? []) : "",
      "Comments Retrieved Count": hasComments ? post.commentsObservedCount ?? "" : "",
      "Comments Text Count": hasComments ? post.commentsTextCount ?? flattenFbComments(post.commentsData ?? []).length : "",
      "Comments Actual Text Count (Verified)": verifiedActualTextCount ?? "",
      "Comments Excluded Non-text Count": hasComments ? post.commentsExcludedNonTextCount ?? "" : "",
      "Comments Excluded Attachment Count": hasComments ? post.commentsExcludedAttachmentCount ?? "" : "",
      "Comments Content Scope": hasComments ? post.commentsContentScope ?? "" : "",
      "Comments Source View": hasComments ? post.commentsSourceView ?? "" : "",
      "Comments Accessible Count (Verified)": hasComments ? post.commentsVerifiedAccessibleCount ?? "" : "",
      "Comments Accessibility Status": hasComments ? commentsAccessibilityStatus(post) : "",
      "Comments Accessibility Evidence": hasComments ? commentsAccessibilityEvidence(post) : "",
      "Reported Delta Count": hasComments ? reportedDeltaCount ?? "" : "",
    };
  });

  return rows.map((row) => Object.fromEntries(FB_MEDIA_COLUMNS.map((column) => [column, row[column] ?? ""])));
}

export async function exportFbPostsCsv(page: FbBrowserPage): Promise<void> {
  await downloadCsv(buildFbMediaRows(page), `facebook_${page.handle}_${page.contentType === "reels" ? "reels" : "posts"}`);
}

export function exportFbCommentsCsv(page: FbBrowserPage): void {
  const posts = page.posts || [];
  const rows: Record<string, unknown>[] = [];

  for (const post of posts) {
    const comments = post.commentsData || [];
    // Every retained node counts, whatever it holds: an emoji-only or GIF-only
    // comment is one Facebook counted too. Carrying the pair on each row makes
    // a shortfall against the reported badge visible in the CSV itself.
    const scraped = flattenFbComments(comments).length;
    for (const c of flattenFbComments(comments)) {
      rows.push({
        "Post ID": post.postId ?? "",
        "Post URL": post.url ?? "",
        "Comments Count (Reported)": post.commentsReportedCount ?? "",
        "Comments Scraped Count": scraped,
        "Comment ID": c.id,
        "Comment Depth": c.depth === 0 ? "Top-level" : "Reply",
        "Commenter Name": c.authorName,
        "Commenter Profile URL": c.authorProfileUrl ?? "",
        "Commenter Avatar URL": c.authorAvatar ?? "",
        "Commenter Badge": c.authorBadge ?? "",
        "Comment Text": c.text,
        "Comment Content Type": c.contentType ?? "text",
        "Comment Content Scope": post.commentsContentScope === "observed_nodes" ? "Observed visible node" : "Text only (legacy)",
        "Likes Count": c.likeCount,
        "Created At": c.createdAt ?? "",
      });
    }
  }

  if (!rows.length) return;
  downloadCsv(rows, `facebook_${page.handle}_comments`);
}

export function exportFbReactorsCsv(page: FbBrowserPage): void {
  const posts = page.posts || [];
  const rows: Record<string, unknown>[] = [];

  for (const post of posts) {
    const reactors = post.reactorsData || [];
    for (const r of reactors) {
      rows.push({
        "Post ID": post.postId ?? "",
        "Post URL": post.url ?? "",
        "User Name": r.name,
        "Profile URL": r.link ?? "",
        "Reaction Type": r.type ?? "like",
      });
    }
  }

  if (!rows.length) return;
  downloadCsv(rows, `facebook_${page.handle}_reactors`);
}

export function postsToRows(posts: FbScrapedPost[]): Record<string, unknown>[] {
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

export function commentsToRows(comments: FbScrapedComment[], postUrl = ""): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const push = (comment: FbScrapedComment, parentId: string) => {
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

export function reactorsToRows(reactors: FbScrapedReactor[]): Record<string, unknown>[] {
  return reactors.map((r) => ({ name: r.name, link: r.link, type: r.type }));
}

export function profileToRows(profile: FbScrapedProfile | FbScrapedGroup | null | undefined): Record<string, unknown>[] {
  if (!profile) return [];
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) row[key] = flattenValue(value);
  return [row];
}
