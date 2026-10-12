import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import type { FbBrowserPage } from "../../src/server/services/facebook/browser-fetcher";
import { flattenFbComments } from "../../src/lib/fb-export";
import { FacebookCommentJobStore, type MediaCommentProgress } from "../../src/server/services/facebook/comment-jobs";
import { createMediaSheetCompletion, enrichMediaSheetPages, validateSheetJobItems } from "../../src/server/services/facebook/media-sheet-job";

const owner = { orgId: "org", userId: "user" };
const profile = { role: "agency_admin", org_id: "org", brand_id: null };
const item = { postId: "123", url: "https://www.facebook.com/photo.php?fbid=123", contentType: "posts" as const };
function pages(): FbBrowserPage[] {
  return [{ handle: "owner", name: "Owner", url: "https://www.facebook.com/owner/", contentType: "posts",
    profilePic: null, followers: null, likes: null, category: null, about: null, verified: false,
    instagram: null, twitter: null, email: "office@example.test", phone: null, website: null,
    posts: [{ ...item, text: "", likes: 0, comments: 0, shares: 0, metricsAvailable: false }],
  }];
}
function progress(): MediaCommentProgress {
  return { status: "cancelled", total: 1, completed: 1, active: 0, failed: 0, partial: 1, partialComments: 1, partialDetails: 0, commentCount: 2, durationMs: 10,
    includeComments: true, includeReactions: true, includeMetadata: true,
    items: [{ ...item, status: "partial", stopReason: "time-budget", commentsStatus: "partial",
      metadata: { text: "Full caption", views: 0 },
      engagement: { status: "partial", totalReactions: 8, reactions: {}, shares: 0 },
      comments: [{ id: "c1", text: "Comment", authorName: "Reader", likeCount: 0, replyCount: 1, depth: 0,
        replies: [{ id: "c2", parentId: "c1", text: "Reply", authorName: "Owner", likeCount: 0, replyCount: 0, depth: 1 }] }],
    }],
  };
}
const saved = { fileId: "sheet", url: "https://docs.google.com/spreadsheets/d/sheet/edit", folderUrl: "https://drive.google.com/drive/folders/folder", updatedAt: "2026-09-06" };

test("server export rejects a different media set before accepting a background job", () => {
  validateSheetJobItems(pages(), [item]);
  assert.throws(() => validateSheetJobItems(pages(), [{ ...item, postId: "456", url: "https://www.facebook.com/photo.php?fbid=456" }]));
  assert.throws(() => validateSheetJobItems(pages(), [{ ...item, contentType: "reels", url: "https://www.facebook.com/reel/123/" }]));
});

test("server final snapshot retains partial replies, caption and measured zero without guessing likes", () => {
  const source = pages();
  const result = enrichMediaSheetPages(source, progress());
  const post = result[0].posts[0];
  assert.equal(post.commentsData?.[0].replies?.[0].parentId, "c1");
  assert.equal(post.commentsStatus, "partial");
  assert.equal(post.commentsStopReason, "time-budget");
  assert.deepEqual(post.commentsBreakdown, {
    totalCount: 2,
    topLevelCount: 1,
    visibleTopLevelCount: 1,
    hiddenTopLevelCount: 0,
    replyCount: 1,
    hiddenReplyCount: 0,
    hiddenCount: 0,
  });
  assert.equal(post.text, "Full caption");
  assert.equal(post.views, 0);
  assert.equal(post.engagement?.shares, 0);
  assert.equal(post.engagement?.reactions.like, undefined);
  assert.equal(source[0].posts[0].commentsData, undefined);
  const metadataOnly = enrichMediaSheetPages(source, { ...progress(), includeComments: false, includeReactions: false });
  assert.equal(metadataOnly[0].posts[0].commentsStatus, undefined);
  assert.equal(metadataOnly[0].posts[0].engagement, undefined);
});

test("a later local retry unions comments instead of replacing earlier evidence", () => {
  const source = pages();
  source[0].posts[0].commentsData = [{
    id: "older", text: "Earlier comment", authorName: "Earlier reader", likeCount: 0, replyCount: 0, depth: 0, replies: [],
  }];
  source[0].posts[0].commentsReportedCount = 3;
  source[0].posts[0].commentsStatus = "partial";
  const retry = progress();
  retry.items[0].reportedCount = 3;
  const post = enrichMediaSheetPages(source, retry)[0].posts[0];
  assert.equal(flattenFbComments(post.commentsData ?? []).length, 3);
  assert.equal(post.commentsStatus, "complete");
  assert.equal(post.commentsObservedCount, 3);
});

test("a visible-view completion below a verified reported count remains partial and retryable", () => {
  const source = pages();
  source[0].posts[0].commentsReportedCount = 9;
  source[0].posts[0].commentsStatus = "complete";
  const visibleOnly = progress();
  visibleOnly.items[0].reportedCount = 9;
  visibleOnly.items[0].commentsStatus = "complete";
  visibleOnly.items[0].status = "complete";
  visibleOnly.items[0].stopReason = "visible-comments-exhausted";
  const post = enrichMediaSheetPages(source, visibleOnly)[0].posts[0];
  assert.equal(flattenFbComments(post.commentsData ?? []).length, 2);
  assert.equal(post.commentsStatus, "partial");
  assert.equal(post.commentsStopReason, "visible-comments-exhausted");
});

test("a clean Newest panel total becomes the delta basis even when pagination remains partial", () => {
  const source = pages();
  source[0].posts[0].commentsReportedCount = 9;
  const partial = progress();
  Object.assign(partial.items[0], {
    reportedCount: 9,
    panelReportedCount: 5,
    observedCommentCount: 2,
    commentsSourceView: "newest" as const,
    stopReason: "some-comments-unavailable",
  });
  let post = enrichMediaSheetPages(source, partial)[0].posts[0];
  assert.equal(post.commentsReportedCount, 9);
  assert.equal(post.commentsReportedDeltaCount, 5);
  assert.equal(post.commentsStatus, "partial");

  const noGridBadge = pages();
  const noBadgeProgress = progress();
  Object.assign(noBadgeProgress.items[0], {
    reportedCount: undefined,
    panelReportedCount: 5,
    observedCommentCount: 2,
    commentsSourceView: "newest" as const,
    stopReason: "some-comments-unavailable",
  });
  post = enrichMediaSheetPages(noGridBadge, noBadgeProgress)[0].posts[0];
  assert.equal(post.commentsReportedCount, undefined);
  assert.equal(post.commentsReportedDeltaCount, 5);
});

function cleanUnavailableProgress(attemptId: string, ids: string[], reported = 5): MediaCommentProgress {
  const comments = ids.map((id) => ({
    id, text: `Comment ${id}`, authorName: "Reader", likeCount: 0, replyCount: 0, depth: 0, replies: [],
  }));
  return {
    status: "completed", total: 1, completed: 1, active: 0, failed: 0, partial: 1, partialComments: 1, partialDetails: 0,
    commentCount: comments.length, observedCommentCount: comments.length, durationMs: 10,
    includeComments: true, includeReactions: false, includeMetadata: false,
    items: [{ ...item, status: "partial", comments, commentsStatus: "partial", stopReason: "some-comments-unavailable",
      reportedCount: reported, observedCommentCount: comments.length, commentsSourceView: "newest", attemptId }],
  };
}

test("only two distinct clean matching public scans verify a retrievable target without changing Facebook's raw count", () => {
  const source = pages();
  source[0].posts[0].commentsReportedCount = 5;
  const first = enrichMediaSheetPages(source, cleanUnavailableProgress("00000000-0000-4000-8000-000000000001", ["c1", "c2"]));
  let post = first[0].posts[0];
  assert.equal(post.commentsReportedCount, 5);
  assert.equal(post.commentsStatus, "partial");
  assert.equal(post.commentsVerifiedAccessibleCount, undefined);
  assert.equal(post.commentsAccessibility?.stablePasses, 1);

  // A checkpoint and terminal completion can replay the same browser pass.
  const duplicate = enrichMediaSheetPages(first, cleanUnavailableProgress("00000000-0000-4000-8000-000000000001", ["c1", "c2"]));
  post = duplicate[0].posts[0];
  assert.equal(post.commentsAccessibility?.stablePasses, 1);
  assert.equal(post.commentsVerifiedAccessibleCount, undefined);

  const verified = enrichMediaSheetPages(duplicate, cleanUnavailableProgress("00000000-0000-4000-8000-000000000002", ["c1", "c2"]));
  post = verified[0].posts[0];
  assert.equal(post.commentsReportedCount, 5);
  assert.equal(post.commentsAccessibility?.stablePasses, 2);
  assert.equal(post.commentsVerifiedAccessibleCount, 2);

  // New public IDs invalidate the prior classification rather than silently
  // lowering the raw Facebook total.
  const changed = enrichMediaSheetPages(verified, cleanUnavailableProgress("00000000-0000-4000-8000-000000000003", ["c1", "c2", "c3"]));
  post = changed[0].posts[0];
  assert.equal(post.commentsReportedCount, 5);
  assert.equal(post.commentsVerifiedAccessibleCount, undefined);
  assert.equal(post.commentsAccessibility?.stablePasses, 1);
});

test("a timeout or filtered view clears a previously verified retrievable target", () => {
  const source = pages();
  source[0].posts[0].commentsReportedCount = 5;
  const once = enrichMediaSheetPages(source, cleanUnavailableProgress("00000000-0000-4000-8000-000000000011", ["c1", "c2"]));
  const verified = enrichMediaSheetPages(once, cleanUnavailableProgress("00000000-0000-4000-8000-000000000012", ["c1", "c2"]));
  const timeout = cleanUnavailableProgress("00000000-0000-4000-8000-000000000013", ["c1", "c2"]);
  timeout.items[0].stopReason = "time-budget";
  const post = enrichMediaSheetPages(verified, timeout)[0].posts[0];
  assert.equal(post.commentsReportedCount, 5);
  assert.equal(post.commentsVerifiedAccessibleCount, undefined);
  assert.equal(post.commentsAccessibility, undefined);
});

test("final save waits for the initial brand save lock using the same run and full snapshot", async () => {
  const input = { brandId: "brand", runId: "run", pages: pages() };
  const calls: typeof input[] = [];
  const complete = createMediaSheetCompletion(profile, input, {
    wait: async () => {},
    save: async (_profile, data) => {
      calls.push(data);
      if (calls.length < 3) throw new TRPCError({ code: "CONFLICT", message: "This brand already has a Sheet save in progress. Retry shortly." });
      return saved;
    },
  });
  assert.deepEqual(await complete(progress()), saved);
  assert.equal(calls.length, 3);
  assert(calls.every((call) => call.runId === "run" && call.pages[0].posts[0].commentsData?.[0].replies?.length === 1));
  let attempts = 0;
  const fail = createMediaSheetCompletion(profile, input, { save: async () => { attempts++; throw new TRPCError({ code: "FORBIDDEN" }); } });
  await assert.rejects(fail(progress()));
  assert.equal(attempts, 1);
});

test("a completed job saves its details without any client progress request", async () => {
  let notify!: () => void;
  const written = new Promise<void>((resolve) => { notify = resolve; });
  let calls = 0;
  const complete = createMediaSheetCompletion(profile, { brandId: "brand", runId: "run", pages: pages() }, {
    save: async (_profile, data) => {
      assert.equal(data.pages[0].posts[0].commentsData?.[0].replies?.length, 1);
      calls++;
      notify();
      return saved;
    },
  });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => ({
    comments: progress().items[0].comments, commentsStatus: "complete", status: "complete", stopReason: "visible-comments-exhausted", durationMs: 10,
  }) });
  const job = store.start(owner, "fake-fixture-session", { items: [item], limit: 0, withReplies: true }, { onComplete: complete });
  await written;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(store.progress(owner, job.jobId).sheetSave?.status, "saved");
});
