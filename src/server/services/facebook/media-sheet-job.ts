import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { summarizeFbComments, type FbBrowserPage, type FbBrowserPost, type FbCommentsAccessibility } from "./browser-fetcher";
import { canonicalCommentItem, type MediaCommentItem, type MediaCommentProgress, type MediaCommentProgressItem } from "./comment-jobs";
import { flattenFbComments } from "@/lib/fb-export";
import { mergeSavedComments, prepareMediaSheet, saveMediaSheet, type ExportProfile, type MediaSheetResult } from "./media-drive-export";

type SheetInput = { brandId: string; runId: string; pages: FbBrowserPage[] };
const mediaKey = (item: MediaCommentItem) => `${item.contentType}:${item.postId}:${canonicalCommentItem(item).url}`;

/** A stable ID fingerprint makes two separate exhaustive scans comparable
 * without retaining another copy of their comment trees in the workspace. */
function commentScanFingerprint(comments: NonNullable<FbBrowserPost["commentsData"]>): string {
  const ids = flattenFbComments(comments).map((comment) => comment.id).filter(Boolean).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

/**
 * Facebook's raw badge may include nodes the current session cannot see.
 * Only a clean, finite All/Newest pass below that badge can be evidence of
 * such a remainder. Timeouts, filters, rate limits, storage limits, empty
 * lists, and a truncated worker result must all leave the raw gap actionable.
 */
function isCleanAvailabilityPass(
  item: MediaCommentProgressItem,
  reportedCount: number | null | undefined,
  scannedCount: number,
): item is MediaCommentProgressItem & { attemptId: string; commentsSourceView: "all" | "newest" } {
  if (!item.attemptId || item.reportedCount == null || reportedCount == null || reportedCount <= 0 || scannedCount <= 0 || scannedCount >= reportedCount) return false;
  if (item.commentsSourceView !== "all" && item.commentsSourceView !== "newest") return false;
  if (item.stopReason !== "some-comments-unavailable" || item.error) return false;
  if ((item.commentsStatus ?? item.status) !== "partial") return false;
  // A storage budget, a limited requested result, or an interrupted worker can
  // retain fewer nodes than it observed. Never certify availability from that.
  return item.observedCommentCount === scannedCount;
}

function nextCommentsAccessibility(
  post: FbBrowserPost,
  item: MediaCommentProgressItem,
  reportedCount: number | null | undefined,
  mergedCount: number,
): Pick<FbBrowserPost, "commentsAccessibility" | "commentsVerifiedAccessibleCount"> {
  const current = post.commentsAccessibility;
  // `onProgress` and `onComplete` intentionally replay the same settled
  // result. It is one scan, not two confirmations.
  if (item.attemptId && current?.lastAttemptId === item.attemptId) {
    return {
      commentsAccessibility: current,
      commentsVerifiedAccessibleCount: post.commentsVerifiedAccessibleCount,
    };
  }

  const scannedCount = flattenFbComments(item.comments).length;
  if (!isCleanAvailabilityPass(item, reportedCount, scannedCount)) {
    // Any real later pass that cannot prove an exhaustive public view means a
    // previously adjusted target is no longer safe. The raw badge remains.
    return { commentsAccessibility: undefined, commentsVerifiedAccessibleCount: undefined };
  }

  const fingerprint = commentScanFingerprint(item.comments);
  const sameScan = current?.sourceView === item.commentsSourceView
    && current.reportedCount === reportedCount
    && current.lastScanFingerprint === fingerprint;
  const stablePasses = sameScan ? current.stablePasses + 1 : 1;
  const accessibility: FbCommentsAccessibility = {
    sourceView: item.commentsSourceView,
    stablePasses,
    reportedCount: reportedCount as number,
    lastScanFingerprint: fingerprint,
    lastAttemptId: item.attemptId,
    ...(stablePasses >= 2 ? { verifiedAt: new Date().toISOString() } : {}),
  };
  // The derived target is exactly the durable union already collected, never
  // an inferred Facebook total. It only allows an additional retrievable-gap
  // metric to reach zero; the raw reported gap stays visible and retryable.
  return {
    commentsAccessibility: accessibility,
    commentsVerifiedAccessibleCount: stablePasses >= 2 ? Math.min(mergedCount, reportedCount as number) : undefined,
  };
}

/** Only the selected media may receive details from this authorized job. */
export function validateSheetJobItems(pages: FbBrowserPage[], items: MediaCommentItem[]): void {
  prepareMediaSheet(pages);
  const expected = new Set(items.map(mediaKey));
  const actual = new Set(pages.flatMap((page) => page.posts.map((post) => mediaKey({
    postId: post.postId!, url: post.url!, contentType: page.contentType!,
  }))));
  if (actual.size !== expected.size || [...actual].some((key) => !expected.has(key))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The Sheet must contain exactly the photos and reels selected for this details run." });
  }
}

/** Called on the server after every worker settles, including cancelled runs. */
export function enrichMediaSheetPages(pages: FbBrowserPage[], progress: MediaCommentProgress): FbBrowserPage[] {
  const details = new Map(progress.items.map((item) => [mediaKey(item), item]));
  return pages.map((page) => ({ ...page, posts: page.posts.map((post) => {
    const item = details.get(mediaKey({ postId: post.postId!, url: post.url!, contentType: page.contentType! }));
    if (!item) return post;
    // A partial retry can mix comments-only and reactions-only items. The job
    // flags describe the union, while the item flags protect complete fields
    // on the other kind of row from being replaced by an empty result.
    const includeComments = item.includeComments ?? progress.includeComments;
    const includeReactions = item.includeReactions ?? progress.includeReactions;
    // A retry is additive evidence. The Sheet merge has always kept comments
    // from earlier attempts, but the local candidate workspace used to replace
    // its tree with the latest (often partial) attempt. That could make a later
    // retry appear to lose comments and increase the displayed delta again.
    const mergedComments = includeComments
      ? mergeSavedComments(post.commentsData ?? [], item.comments).comments
      : post.commentsData;
    const mergedCount = flattenFbComments(mergedComments ?? []).length;
    const mergedBreakdown = summarizeFbComments(mergedComments ?? []);
    const mergedTextCount = flattenFbComments(mergedComments ?? [])
      .filter((comment) => (comment.contentType ?? "text") === "text").length;
    const reportedCount = item.reportedCount ?? post.commentsReportedCount;
    const commentsStatus = !includeComments ? undefined
      : reportedCount != null && mergedCount >= reportedCount ? "complete" as const
      // A browser can exhaust its visible view before Facebook's numeric badge
      // is reached. Never let that item-level "complete" label hide a real
      // reported-versus-saved gap from retry controls or metadata.
      : reportedCount != null ? "partial" as const
      // Do not downgrade a completed count-unavailable legacy row merely
      // because a later partial pass did not expose a new badge.
      : item.reportedCount == null && post.commentsStatus === "complete" ? "complete" as const
      : item.commentsStatus ?? item.status;
    const availability = includeComments
      ? nextCommentsAccessibility(post, item, reportedCount, mergedCount)
      : {};
    // Keep an explicit effective report-count basis alongside the raw Facebook
    // badge. A visible Newest-panel total is useful even when the page later
    // proves partial: it answers the user's "of N comments" question without
    // overwriting the raw badge. Authentication and rate-limit failures are
    // excluded because they can interrupt the tray before its state settles.
    const panelCount = item.panelReportedCount != null
      && item.panelReportedCount >= 0
      && item.commentsSourceView === "newest"
      && item.stopReason !== "authentication"
      && item.stopReason !== "rate_limit"
      ? item.panelReportedCount
      : undefined;
    // Keep the exact Newest-panel total as the operational delta basis. A
    // retry replaces it when Facebook exposes a fresh panel value, but a
    // temporary panel failure must not erase the last valid value. Do not
    // clamp it to the raw badge or saved comment count: those are separate
    // measurements and their difference is precisely what the UI reports.
    const reportedDeltaCount = panelCount
      ?? availability.commentsVerifiedAccessibleCount
      ?? post.commentsReportedDeltaCount;
    return {
      ...post,
      ...(includeComments ? {
        commentsData: mergedComments,
        commentsBreakdown: mergedBreakdown,
        commentsStatus,
        commentsStopReason: item.stopReason,
        commentsError: item.error,
        commentsDurationMs: item.durationMs,
        commentsReportedCount: reportedCount,
        commentsObservedCount: Math.max(mergedCount, item.observedCommentCount ?? 0, post.commentsObservedCount ?? 0),
        ...availability,
        commentsReportedDeltaCount: reportedDeltaCount,
        commentsTextCount: mergedTextCount,
        commentsExcludedNonTextCount: item.excludedNonTextCommentCount ?? post.commentsExcludedNonTextCount,
        commentsExcludedAttachmentCount: item.excludedAttachmentCommentCount ?? post.commentsExcludedAttachmentCount,
        commentsContentScope: item.commentsContentScope ?? post.commentsContentScope,
        commentsSourceView: item.commentsSourceView ?? post.commentsSourceView,
      } : {}),
      ...(includeReactions ? { engagement: item.engagement ?? post.engagement ?? {
        status: "partial" as const, totalReactions: null, shares: null, reactions: {},
        error: item.error ?? "Reaction and share counts were not returned.",
      } } : {}),
      text: item.metadata?.text ?? post.text,
      publishedTime: item.metadata?.publishedTime ?? post.publishedTime,
      views: item.metadata?.views ?? post.views,
    };
  }) }));
}

export function createMediaSheetCompletion(
  profile: ExportProfile,
  input: SheetInput,
  dependencies: {
    save?: (profile: ExportProfile, input: SheetInput) => Promise<MediaSheetResult>;
    wait?: (ms: number) => Promise<void>;
  } = {},
): (progress: MediaCommentProgress) => Promise<MediaSheetResult> {
  const save = dependencies.save ?? saveMediaSheet;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (progress) => {
    const completed = { ...input, pages: enrichMediaSheetPages(input.pages, progress) };
    for (let attempt = 0; ; attempt++) {
      try { return await save(profile, completed); }
      catch (error) {
        // The initial UI snapshot can still hold the brand's save lock when a
        // small details job finishes. Retry that lock only, using the same UUID.
        if (!(error instanceof TRPCError) || error.code !== "CONFLICT" || !error.message.includes("save in progress") || attempt >= 19) throw error;
        await wait(Math.min(4000, 500 * (attempt + 1)));
      }
    }
  };
}
