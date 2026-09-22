import type { FbBrowserPost } from "@/server/services/facebook/browser-fetcher";

export type CommentRetryDisposition = "retry" | "cancelled" | "filtered" | "review" | "complete";

// Only retry failures with a concrete browser stage or an interrupted comment
// load. Generic legacy errors do not carry enough evidence to safely replay.
const RETRYABLE_COMMENT_REASONS = new Set([
  "opening-media",
  "checking-access",
  "reading-metadata",
  "reading-reactions",
  "loading-comments",
  "loading-interrupted",
  "loading-stalled",
  "time-budget",
]);

export function commentRetryDisposition(post: Pick<FbBrowserPost, "commentsStatus" | "commentsStopReason">): CommentRetryDisposition {
  const status = post.commentsStatus;
  const reason = post.commentsStopReason;
  if (!status || status === "complete") return "complete";
  if (status === "cancelled" || reason === "cancelled") return "cancelled";
  if (reason === "filtered-comments" || reason === "some-comments-unavailable") return "filtered";
  if ((status === "partial" || status === "failed") && reason && RETRYABLE_COMMENT_REASONS.has(reason)) return "retry";
  return "review";
}

export type CommentRetrySummary = Record<CommentRetryDisposition, number>;

export function summarizeCommentRetries(posts: readonly Pick<FbBrowserPost, "commentsStatus" | "commentsStopReason">[]): CommentRetrySummary {
  const summary: CommentRetrySummary = { retry: 0, cancelled: 0, filtered: 0, review: 0, complete: 0 };
  for (const post of posts) summary[commentRetryDisposition(post)] += 1;
  return summary;
}
