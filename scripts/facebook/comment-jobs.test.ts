import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalCommentItem,
  FacebookCommentJobStore,
  MediaCommentJobError,
  type MediaCommentItem,
  type MediaCommentResult,
} from "../../src/server/services/facebook/comment-jobs";
import { FbBrowserAuthError, FbBrowserRateLimitError, type FbBrowserComment } from "../../src/server/services/facebook/browser-fetcher";

const owner = { orgId: "org-a", userId: "user-a" };
const item = (id: number): MediaCommentItem => ({ postId: `${id}`, contentType: "posts", url: `https://www.facebook.com/photo.php?fbid=${id}` });
const comment = (id: number): FbBrowserComment => ({ id: `${id}`, authorName: "Example", text: `Comment ${id}`, likeCount: 0, replyCount: 0, depth: 0 });
const result = (id = 1): MediaCommentResult => ({ comments: [comment(id)], status: "complete", stopReason: "end", durationMs: 1 });

async function settle(store: FacebookCommentJobStore, jobId: string, identity = owner) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const progress = store.progress(identity, jobId);
    if (progress.status !== "running") return progress;
    await delay(5);
  }
  throw new Error("Fake comment job did not settle");
}

test("comment URLs reject foreign hosts, credentials, ID/type mismatches and non-media routes", () => {
  assert.deepEqual(canonicalCommentItem({ ...item(123), url: "https://m.facebook.com/photo/?fbid=123&tracking=x" }), item(123));
  assert.equal(canonicalCommentItem({ postId: "123", contentType: "reels", url: "https://facebook.com/reel/123/?ref=x" }).url, "https://www.facebook.com/reel/123/");
  for (const url of [
    "http://www.facebook.com/photo.php?fbid=123",
    "https://facebook.com.evil.test/photo.php?fbid=123",
    "https://user:password@facebook.com/photo.php?fbid=123",
    "https://www.facebook.com:8443/photo.php?fbid=123",
    "https://www.facebook.com/login?fbid=123",
    "https://www.facebook.com/photo.php?fbid=456",
    "https://www.facebook.com/reel/123/",
  ]) assert.throws(() => canonicalCommentItem({ ...item(123), url }), MediaCommentJobError);
});

test("owner checks cover both organization and user; exported progress contains no session", async () => {
  const store = new FacebookCommentJobStore({ fetcher: async () => result(), concurrency: 1 });
  const { jobId } = store.start(owner, "private-cookie", { items: [item(1)], limit: 25, withReplies: true });
  for (const wrong of [{ orgId: "org-b", userId: owner.userId }, { orgId: owner.orgId, userId: "user-b" }]) {
    for (const action of [() => store.progress(wrong, jobId), () => store.cancel(wrong, jobId)]) {
      assert.throws(action, (error: unknown) => error instanceof MediaCommentJobError && error.code === "NOT_FOUND");
    }
  }
  const done = await settle(store, jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.completed, 1);
  assert.equal(JSON.stringify(done).includes("private-cookie"), false);
  done.items[0].comments[0].text = "mutated client copy";
  assert.equal(store.progress(owner, jobId).items[0].comments[0].text, "Comment 1");
});

test("the global pool is bounded across organizations and only one active job is accepted per org", async () => {
  let active = 0;
  let peak = 0;
  const store = new FacebookCommentJobStore({ concurrency: 2, fetcher: async () => {
    peak = Math.max(peak, ++active);
    await delay(8);
    active--;
    return result();
  } });
  const first = store.start(owner, "cookie", { items: [item(1), item(2), item(2), item(3)], limit: 0, withReplies: true });
  assert.throws(() => store.start({ ...owner, userId: "other-user" }, "cookie", { items: [item(4)], limit: 0, withReplies: true }),
    (error: unknown) => error instanceof MediaCommentJobError && error.code === "CONFLICT");
  const otherOwner = { orgId: "org-b", userId: "user-b" };
  const second = store.start(otherOwner, "cookie-b", { items: [item(4), item(5), item(6)], limit: 0, withReplies: true });
  const [a, b] = await Promise.all([settle(store, first.jobId), settle(store, second.jobId, otherOwner)]);
  assert.equal(peak, 2);
  assert.equal(a.total, 3);
  assert.equal(a.completed + b.completed, 6);
  assert.equal(active, 0);
});

test("a configured 12-worker job fills all twelve slots concurrently", async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 12, fetcher: async (_item, _cookies, options) => {
    options.onStage?.("comments");
    peak = Math.max(peak, ++active);
    await hold;
    active--;
    return result();
  } });
  const items = Array.from({ length: 24 }, (_, index) => item(index + 1));
  const job = store.start(owner, "cookie", { items, limit: 0, withReplies: true });
  for (let attempt = 0; attempt < 50 && store.progress(owner, job.jobId).active < 12; attempt++) await delay(2);
  const activeProgress = store.progress(owner, job.jobId);
  assert.equal(activeProgress.active, 12);
  assert.equal(activeProgress.workers?.slots.length, 12);
  assert.deepEqual(activeProgress.workers?.slots.map((slot) => slot.slot), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(activeProgress.workers?.slots.filter((slot) => slot.state === "running").length, 12);
  assert.ok(activeProgress.workers?.slots.every((slot) => slot.stage === "comments"));
  assert.equal(peak, 12);
  release();
  const done = await settle(store, job.jobId);
  assert.equal(done.completed, 24);
  assert.equal(active, 0);
});

test("the next queued item takes the slot released by a settled worker", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (entry, _cookies, options) => {
    options.onStage?.("comments");
    if (entry.postId === "1") {
      firstStarted();
      await firstHold;
    } else {
      secondStarted();
      await secondHold;
    }
    return result(Number(entry.postId));
  } });
  const job = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 0, withReplies: true });
  await firstReady;
  assert.equal(store.progress(owner, job.jobId).workers?.slots[0]?.postId, "1");
  releaseFirst();
  await secondReady;
  const assigned = store.progress(owner, job.jobId).workers?.slots[0];
  assert.equal(assigned?.slot, 1);
  assert.equal(assigned?.postId, "2");
  assert.equal(assigned?.stage, "comments");
  releaseSecond();
  assert.equal((await settle(store, job.jobId)).completed, 2);
});

test("a second retry selection joins its owner's active queue without cancelling it", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (entry) => {
    if (entry.postId === "1") { firstStarted(); await hold; }
    return result(Number(entry.postId));
  } });
  const first = store.start(owner, "cookie", { items: [item(1)], limit: 0, withReplies: true, ownerLeaseId: "00000000-0000-4000-8000-000000000001" });
  await started;
  const added = store.start(owner, "cookie", { items: [item(2)], limit: 0, withReplies: true, appendToActive: true, ownerLeaseId: "00000000-0000-4000-8000-000000000002" });
  assert.equal(added.jobId, first.jobId);
  assert.equal(added.replacedJobIds.length, 0);
  assert.equal(added.appendedItems, 1);
  assert.equal(added.ownerLeaseId, first.ownerLeaseId);
  assert.equal(store.progress(owner, first.jobId).total, 2);
  release();
  assert.equal((await settle(store, first.jobId)).completed, 2);
});

test("one stalled Facebook item settles as retryable without blocking the remaining queue", async () => {
  const never = new Promise<MediaCommentResult>(() => {});
  const store = new FacebookCommentJobStore({
    concurrency: 1,
    itemTimeoutMs: 15,
    fetcher: async (entry) => entry.postId === "1" ? never : result(Number(entry.postId)),
  });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 0, withReplies: true });
  const done = await settle(store, jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.completed, 2);
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].stopReason, "time_budget");
  assert.equal(done.items[0].commentsStatus, "partial");
  assert.equal(done.items[1].status, "complete");
});

test("cancellation stops queued work and retains collected data while active workers unwind", async () => {
  let calls = 0;
  let activeStarted!: () => void;
  const started = new Promise<void>((resolve) => { activeStarted = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    calls++;
    if (calls === 1) return result(1);
    activeStarted();
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    await delay(5);
    return { ...result(2), status: "partial", stopReason: "cancelled" };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2), item(3)], limit: 25, withReplies: true });
  await started;
  assert.deepEqual(store.cancel(owner, jobId), { ok: true });
  assert.equal(store.progress(owner, jobId).status, "running", "do not stop client polling before partial data is returned");
  const done = await settle(store, jobId);
  assert.equal(calls, 2);
  assert.equal(done.status, "cancelled");
  assert.equal(done.completed, 3);
  assert.deepEqual(done.items.map((entry) => entry.status), ["complete", "cancelled", "cancelled"]);
  assert.deepEqual(done.items.map((entry) => entry.comments.length), [1, 1, 0]);
});

test("authentication stops a candidate, while a temporary rate limit cools down and retries the clean item", async () => {
  let authCalls = 0;
  const authStore = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => { authCalls++; throw new FbBrowserAuthError("private error"); } });
  const auth = authStore.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true });
  const authDone = await settle(authStore, auth.jobId);
  assert.equal(authCalls, 1);
  assert.equal(authDone.status, "cancelled");
  assert.equal(authDone.failed, 1);
  assert.equal(authDone.stopReason, "authentication");
  assert.deepEqual(authDone.items.map((entry) => entry.status), ["failed", "cancelled"]);

  let rateCalls = 0;
  const rateStore = new FacebookCommentJobStore({ concurrency: 1, rateLimitCooldownMs: 1, fetcher: async () => {
    rateCalls++;
    if (rateCalls === 1) throw new FbBrowserRateLimitError("private error");
    return result(rateCalls);
  } });
  const rate = rateStore.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true });
  const rateDone = await settle(rateStore, rate.jobId);
  assert.equal(rateCalls, 3);
  assert.equal(rateDone.status, "completed");
  assert.equal(rateDone.failed, 0);
  assert.deepEqual(rateDone.items.map((entry) => entry.status), ["complete", "complete"]);
  assert.equal(JSON.stringify(rateDone).includes("private error"), false);
});

test("individual failures remain visible while other media continue", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (entry) => {
    if (entry.postId === "1") throw new Error("raw cookie or network details");
    return result();
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true });
  const done = await settle(store, jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.failed, 1);
  assert.equal(done.items[1].comments.length, 1);
  assert.equal(JSON.stringify(done).includes("raw cookie"), false);
});

test("local progress checkpoints are serialized and finish before the terminal save", async () => {
  const order: string[] = [];
  const store = new FacebookCommentJobStore({ concurrency: 1, checkpointDebounceMs: 1, fetcher: async (entry) => result(Number(entry.postId)) });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true }, {
    onProgress: async (progress) => { order.push(`checkpoint:${progress.completed}`); },
    onComplete: async () => {
      order.push("complete");
      return { url: "workspace://candidate", folderUrl: "workspace://candidate", fileId: "candidate", updatedAt: "now" };
    },
  });
  const done = await settle(store, jobId);
  const saved = await saveSettled(store, jobId);
  assert.equal(done.status, "completed");
  assert.equal(saved.sheetSave?.status, "saved");
  assert(order.some((entry) => entry.startsWith("checkpoint:")));
  assert.equal(order.at(-1), "complete");
});

test("comment retention limits stop a run explicitly and retain the available partial rows", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, maxJobComments: 2, fetcher: async () => ({ ...result(), comments: [comment(1), comment(2), comment(3)] }) });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 0, withReplies: true });
  const done = await settle(store, jobId);
  assert.equal(done.status, "cancelled");
  assert.equal(done.stopReason, "storage_limit");
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].comments.length, 2);
  assert.equal(done.items[1].status, "cancelled");
});

test("old jobs expire and bounded stores evict completed jobs without reporting success", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, maxJobs: 1, ttlMs: 15, fetcher: async () => result() });
  const input = { items: [item(1)], limit: 25, withReplies: true };
  const first = store.start(owner, "cookie", input);
  await settle(store, first.jobId);
  const second = store.start(owner, "cookie", input);
  assert.throws(() => store.progress(owner, first.jobId), (error: unknown) => error instanceof MediaCommentJobError && error.code === "NOT_FOUND");
  await settle(store, second.jobId);
  await delay(20);
  assert.throws(() => store.progress(owner, second.jobId), (error: unknown) => error instanceof MediaCommentJobError && error.code === "NOT_FOUND");
});

test("detail flags default to comments and metadata and are forwarded explicitly to the engine", async () => {
  let flags: { includeComments: boolean; includeReactions: boolean; includeMetadata: boolean } | undefined;
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    flags = { includeComments: options.includeComments, includeReactions: options.includeReactions, includeMetadata: options.includeMetadata };
    return result();
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1)], limit: 25, withReplies: true });
  const done = await settle(store, jobId);
  assert.deepEqual(flags, { includeComments: true, includeReactions: false, includeMetadata: true });
  assert.equal(done.includeComments, true);
  assert.equal(done.includeReactions, false);
  assert.equal(done.includeMetadata, true);
  assert.equal(done.items[0].commentsStatus, "complete", "legacy comments-only status remains supported");
});

test("reaction-only jobs preserve engagement and unknown counts without claiming comments were fetched", async () => {
  const engagement = { status: "partial" as const, totalReactions: 100, reactions: { like: 80, love: 20 }, shares: null, approximate: true, error: "Shares unavailable" };
  const metadata = { text: "Example caption", publishedTime: null, views: 2000 };
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    assert.equal(options.includeComments, false);
    assert.equal(options.includeReactions, true);
    return { ...result(), status: "partial", commentsStatus: "complete", reportedCount: 55, engagement, metadata };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1)], limit: 25, withReplies: true, includeComments: false, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(done.includeComments, false);
  assert.equal(done.includeReactions, true);
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].commentsStatus, undefined);
  assert.equal(done.items[0].reportedCount, undefined);
  assert.deepEqual(done.items[0].comments, []);
  assert.deepEqual(done.items[0].engagement, engagement);
  assert.deepEqual(done.items[0].metadata, metadata);
  done.items[0].engagement!.reactions.like = 999;
  assert.equal(store.progress(owner, jobId).items[0].engagement!.reactions.like, 80);
});

test("partial engagement never downgrades a separately complete comments result", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    assert.equal(options.includeComments, true);
    assert.equal(options.includeReactions, true);
    return {
      ...result(), status: "partial", commentsStatus: "complete", reportedCount: 1,
      engagement: { status: "partial", totalReactions: null, reactions: {}, shares: null },
    };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1)], limit: 25, withReplies: true, includeComments: true, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].commentsStatus, "complete");
  assert.equal(done.items[0].engagement!.status, "partial");
  assert.equal(done.items[0].comments.length, 1);
  assert.equal(done.items[0].reportedCount, 1);
});

test("a run requires at least one detail option and reaction failures are not labelled comments failures", async () => {
  let calls = 0;
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => { calls++; throw new Error("browser error"); } });
  const input = { items: [item(1)], limit: 25, withReplies: true, includeComments: false, includeReactions: false, includeMetadata: false };
  assert.throws(() => store.start(owner, "cookie", input), (error: unknown) => error instanceof MediaCommentJobError && error.code === "BAD_REQUEST");
  assert.equal(calls, 0);
  const { jobId } = store.start(owner, "cookie", { ...input, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(done.failed, 1);
  assert.equal(done.items[0].commentsStatus, undefined);
  assert.match(done.items[0].error!, /media details could not/);
});

test("metadata and engagement participate in the retained-result memory bound", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, maxStoredBytes: 200, fetcher: async () => ({
    ...result(), comments: [], metadata: { text: "x".repeat(500) },
    engagement: { status: "complete", totalReactions: 100, reactions: { like: 100 }, shares: 0 },
  }) });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 0, withReplies: true, includeComments: false, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(done.status, "cancelled");
  assert.equal(done.stopReason, "storage_limit");
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].commentsStatus, undefined);
  assert.equal(done.items[0].metadata, undefined);
  assert.equal(done.items[1].status, "cancelled");
});

test("metadata-only jobs remain valid with comments and reactions disabled", async () => {
  const metadata = { text: "Photo caption", publishedTime: null, views: null };
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    assert.equal(options.includeComments, false);
    assert.equal(options.includeReactions, false);
    assert.equal(options.includeMetadata, true);
    return { ...result(), metadata };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1)], limit: 25, withReplies: true, includeComments: false, includeReactions: false });
  const done = await settle(store, jobId);
  assert.equal(done.includeMetadata, true);
  assert.equal(done.items[0].status, "complete");
  assert.deepEqual(done.items[0].metadata, metadata);
  assert.deepEqual(done.items[0].comments, []);
  assert.equal(done.items[0].commentsStatus, undefined);
  assert.equal(done.items[0].engagement, undefined);
});

test("disabling metadata passes false and does not retain an accidental engine metadata result", async () => {
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookie, options) => {
    assert.equal(options.includeMetadata, false);
    return { ...result(), metadata: { text: "Should not be included" } };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1)], limit: 25, withReplies: true, includeMetadata: false });
  const done = await settle(store, jobId);
  assert.equal(done.includeMetadata, false);
  assert.equal(done.items[0].commentsStatus, "complete");
  assert.equal(done.items[0].metadata, undefined);
});

test("a rate-limited partial result is retained while the rest of the queue resumes after cooldown", async () => {
  let calls = 0;
  const store = new FacebookCommentJobStore({ concurrency: 1, rateLimitCooldownMs: 1, fetcher: async () => {
    calls++;
    if (calls === 1) return { ...result(), status: "partial" as const, stopReason: "rate_limit", commentsStatus: "partial" as const, metadata: { text: "Already collected caption" }, engagement: { status: "complete" as const, totalReactions: 5, reactions: { like: 5 }, shares: 1 } };
    return result();
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(calls, 2);
  assert.equal(done.status, "completed");
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].comments.length, 1);
  assert.equal(done.items[0].metadata!.text, "Already collected caption");
  assert.equal(done.items[0].engagement!.totalReactions, 5);
  assert.equal(done.items[1].status, "complete");
});

test("an authentication partial result retains details but stops queued media", async () => {
  let calls = 0;
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => {
    calls++;
    return { ...result(), status: "partial" as const, stopReason: "authentication", commentsStatus: "partial" as const, metadata: { text: "Already collected caption" }, engagement: { status: "complete" as const, totalReactions: 5, reactions: { like: 5 }, shares: 1 } };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true, includeReactions: true });
  const done = await settle(store, jobId);
  assert.equal(calls, 1);
  assert.equal(done.status, "cancelled");
  assert.equal(done.stopReason, "authentication");
  assert.equal(done.items[0].status, "partial");
  assert.equal(done.items[0].comments.length, 1);
  assert.equal(done.items[1].status, "cancelled");
});

const savedSheet = { url: "https://docs.google.com/spreadsheets/d/example/edit", folderUrl: "https://drive.google.com/drive/folders/example", fileId: "example", updatedAt: "2026-09-06T12:00:00Z" };
async function saveSettled(store: FacebookCommentJobStore, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const progress = store.progress(owner, jobId);
    if (progress.sheetSave?.status !== "saving") return progress;
    await delay(5);
  }
  throw new Error("Fake completion save did not settle");
}

test("completion saves exactly once and exposes saving atomically with the terminal result", async () => {
  let saves = 0;
  let release!: (value: typeof savedSheet) => void;
  const saved = new Promise<typeof savedSheet>((resolve) => { release = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => result() });
  const { jobId } = store.start(owner, "private-cookie", { items: [item(1)], limit: 25, withReplies: true }, {
    onComplete: async (progress) => {
      saves++;
      assert.equal(progress.status, "completed");
      assert.equal(progress.completed, 1);
      assert.equal(progress.sheetSave?.status, "saving");
      assert.equal(JSON.stringify(progress).includes("private-cookie"), false);
      progress.items[0].comments[0].text = "Callback mutation is isolated";
      return saved;
    },
  });
  const done = await settle(store, jobId);
  assert.equal(done.sheetSave?.status, "saving");
  assert.equal(done.items[0].comments[0].text, "Comment 1");
  store.cancel(owner, jobId);
  store.progress(owner, jobId);
  assert.equal(saves, 1);
  release(savedSheet);
  assert.deepEqual((await saveSettled(store, jobId)).sheetSave, { status: "saved", result: savedSheet });
  assert.equal(saves, 1);
});

test("completion waits for active cancellation to return partial rows before saving", async () => {
  let saves = 0;
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async (_item, _cookies, options) => {
    started();
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    await delay(10);
    return { ...result(), status: "partial", stopReason: "cancelled" };
  } });
  const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true }, {
    onComplete: async (progress) => {
      saves++;
      assert.equal(progress.status, "cancelled");
      assert.equal(progress.completed, 2);
      assert.equal(progress.items[0].comments.length, 1);
      assert.equal(progress.items[1].status, "cancelled");
      return savedSheet;
    },
  });
  await active;
  store.cancel(owner, jobId);
  assert.equal(saves, 0);
  await settle(store, jobId);
  assert.equal((await saveSettled(store, jobId)).sheetSave?.status, "saved");
  assert.equal(saves, 1);
});

test("fatal and immediately cancelled jobs invoke completion once; save failures stay explicit and safe", async () => {
  for (const cancelBeforeStart of [false, true]) {
    let saves = 0;
    const store = new FacebookCommentJobStore({ concurrency: 1, fetcher: async () => { throw new FbBrowserAuthError("private-auth-error"); } });
    const { jobId } = store.start(owner, "cookie", { items: [item(1), item(2)], limit: 25, withReplies: true }, {
      onComplete: async (progress) => {
        saves++;
        assert.equal(progress.status, "cancelled");
        throw new Error("private-drive-token");
      },
    });
    if (cancelBeforeStart) store.cancel(owner, jobId);
    await settle(store, jobId);
    const done = await saveSettled(store, jobId);
    assert.equal(saves, 1);
    assert.equal(done.sheetSave?.status, "failed");
    assert.equal(JSON.stringify(done).includes("private-"), false);
  }
});

test("pending saves survive result expiry and are not evicted to accept a new job", async () => {
  let release!: (value: typeof savedSheet) => void;
  const saved = new Promise<typeof savedSheet>((resolve) => { release = resolve; });
  const store = new FacebookCommentJobStore({ concurrency: 1, maxJobs: 1, ttlMs: 10, fetcher: async () => result() });
  const input = { items: [item(1)], limit: 25, withReplies: true };
  const { jobId } = store.start(owner, "cookie", input, { onComplete: async () => saved });
  await settle(store, jobId);
  await delay(20);
  assert.equal(store.progress(owner, jobId).sheetSave?.status, "saving");
  assert.throws(() => store.start(owner, "cookie", input), (error: unknown) => error instanceof MediaCommentJobError && error.code === "TOO_MANY_REQUESTS");
  release(savedSheet);
  assert.equal((await saveSettled(store, jobId)).sheetSave?.status, "saved");
});
