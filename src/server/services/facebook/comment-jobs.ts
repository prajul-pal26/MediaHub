import { randomUUID } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import type { BrowserContext } from "playwright-core";
import {
  FbBrowserAuthError,
  FbBrowserRateLimitError,
  type FbBrowserComment,
  type FbCommentsSourceView,
  type FbMediaEngagement,
} from "./browser-fetcher";
import { FbScrapeAuthError } from "./scraper-types";
import { FbMediaDetailFetchError } from "./media-comments";
import { createFacebookContext } from "./browser-pool";

export interface MediaCommentItem {
  postId: string;
  url: string;
  contentType: "posts" | "reels";
  /** Internal retry jobs can request only the detail fields that remain partial. */
  includeComments?: boolean;
  includeReactions?: boolean;
  includeMetadata?: boolean;
  /** Read the Newest tray total without waiting through its full pagination chain. */
  panelCountOnly?: boolean;
}

export interface MediaCommentResult {
  comments: FbBrowserComment[];
  status: "complete" | "partial";
  stopReason: string;
  durationMs: number;
  reportedCount?: number | null;
  panelReportedCount?: number | null;
  observedCommentCount?: number;
  textCommentCount?: number;
  excludedNonTextCommentCount?: number;
  excludedAttachmentCommentCount?: number;
  commentsContentScope?: "text_only" | "observed_nodes";
  commentsSourceView?: FbCommentsSourceView;
  commentsStatus?: "complete" | "partial";
  engagement?: FbMediaEngagement;
  metadata?: { text?: string; publishedTime?: string | null; views?: number | null };
  error?: string;
}

export interface MediaCommentProgressItem extends MediaCommentItem {
  status: "pending" | "running" | "complete" | "partial" | "failed" | "cancelled";
  comments: FbBrowserComment[];
  error?: string;
  stopReason?: string;
  durationMs?: number;
  reportedCount?: number | null;
  panelReportedCount?: number | null;
  observedCommentCount?: number;
  textCommentCount?: number;
  excludedNonTextCommentCount?: number;
  excludedAttachmentCommentCount?: number;
  commentsContentScope?: "text_only" | "observed_nodes";
  commentsSourceView?: FbCommentsSourceView;
  commentsStatus?: "complete" | "partial";
  engagement?: FbMediaEngagement;
  metadata?: MediaCommentResult["metadata"];
  /** Automatic in-run attempts spent on a retriable detail-stage failure. */
  detailAttempts?: number;
  /** One bounded retry after Facebook temporarily rate-limits a clean item. */
  rateLimitAttempts?: number;
  /** Identifies one actual browser execution, not a progress snapshot. */
  attemptId?: string;
  /** Logical browser-pool assignment exposed to the progress UI while active. */
  workerSlot?: number;
  workerStage?: MediaCommentWorkerStage;
  workerStartedAt?: number;
}

/** Internal marker so an already force-released browser operation cannot
 * decrement the global pool a second time when it eventually unwinds. */
type RunningMediaCommentItem = MediaCommentProgressItem & { workerSlotReleased?: boolean };

export type MediaCommentWorkerStage = "opening" | "captions" | "reactions" | "comments" | "saving";

export interface MediaCommentWorkerSlot {
  slot: number;
  /** Busy means this shared process-wide slot belongs to another user job. */
  state: "idle" | "running" | "busy";
  contentType?: MediaCommentItem["contentType"];
  postId?: string;
  stage?: MediaCommentWorkerStage;
  startedAt?: number;
}

export interface MediaCommentProgress {
  status: "running" | "completed" | "cancelled";
  total: number;
  /** Number of settled items; failed and cancelled items also settle. */
  completed: number;
  /** Currently running browser pages. This is separate from settled items. */
  active: number;
  failed: number;
  /** Items partial for any reason: comments, reactions or metadata. */
  partial: number;
  /**
   * Split of `partial`, because the two mean different things to the user.
   * An item whose comments finished but whose reaction breakdown Facebook
   * withheld is not a partial comment result, and reporting it as one made
   * finished runs look broken.
   */
  partialComments: number;
  partialDetails: number;
  /** Observed comments and replies retained so far, including rich-media placeholders. */
  commentCount: number;
  /** Visible comment nodes observed before storage limits. They may still be below Facebook's raw total. */
  observedCommentCount?: number;
  excludedNonTextCommentCount?: number;
  excludedAttachmentCommentCount?: number;
  durationMs: number;
  items: MediaCommentProgressItem[];
  includeComments: boolean;
  includeReactions: boolean;
  includeMetadata: boolean;
  /** The requested cap and the currently active browser-page budget. */
  workers?: { requested: number; capacity: number; active: number; pacedStartMs: number; slots: MediaCommentWorkerSlot[] };
  sheetSave?: { status: "saving" | "saved" | "failed"; result?: MediaSheetSaveResult; error?: string };
  error?: string;
  stopReason?: string;
}

/** The progress banner and retry metadata must use the same delta basis.
 * Prefer the Newest-panel count; only rows without that measurement fall back
 * to Facebook's front-page badge. */
function hasIncompleteCommentDelta(item: MediaCommentProgressItem): boolean {
  const basis = item.panelReportedCount ?? item.reportedCount;
  if (basis == null) return (item.commentsStatus ?? item.status) === "partial";
  return item.comments.length < basis;
}

export interface MediaSheetSaveResult {
  url: string;
  folderUrl: string;
  fileId: string;
  updatedAt: string;
}

interface CompletionOptions {
  /** Candidate-local persistence; never writes Google Sheets. */
  onProgress?: (progress: MediaCommentProgress) => Promise<unknown>;
  onComplete?: (progress: MediaCommentProgress) => Promise<MediaSheetSaveResult>;
  onAuthenticationFailure?: () => Promise<void>;
}

type Owner = { orgId: string; userId: string };
type Fetcher = (
  item: MediaCommentItem,
  cookies: string,
  options: { limit: number; withReplies: boolean; includeComments: boolean; includeReactions: boolean; includeMetadata: boolean; panelCountOnly: boolean; signal: AbortSignal; context?: BrowserContext; onStage?: (stage: Exclude<MediaCommentWorkerStage, "saving">) => void },
) => Promise<MediaCommentResult>;

type WorkerLease = { jobId: string; orgId: string; userId: string; item: MediaCommentProgressItem };

type Job = Owner & {
  id: string;
  status: MediaCommentProgress["status"];
  items: MediaCommentProgressItem[];
  cookies: string;
  limit: number;
  withReplies: boolean;
  includeComments: boolean;
  includeReactions: boolean;
  includeMetadata: boolean;
  controller: AbortController;
  started: number;
  ended?: number;
  retainedAt?: number;
  active: number;
  bytes: number;
  commentCount: number;
  observedCommentCount: number;
  excludedNonTextCommentCount: number;
  excludedAttachmentCommentCount: number;
  timer: ReturnType<typeof setTimeout>;
  error?: string;
  stopReason?: string;
  onProgress?: CompletionOptions["onProgress"];
  onComplete?: CompletionOptions["onComplete"];
  onAuthenticationFailure?: CompletionOptions["onAuthenticationFailure"];
  /** Serialized checkpoint chain prevents older snapshots overwriting newer ones. */
  checkpointChain: Promise<void>;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  completionDispatched: boolean;
  sheetSave?: MediaCommentProgress["sheetSave"];
  ownerLeaseId?: string;
  lastOwnerHeartbeat?: number;
  leaseTimer?: ReturnType<typeof setInterval>;
  /** No new item starts for this job until Facebook's short cooling period ends. */
  cooldownUntil?: number;
};

type ContextPool = { idle: BrowserContext[]; all: Set<BrowserContext>; completedItems: Map<BrowserContext, number> };

/** A browser operation may ignore context closure while Facebook is mid-load. */
class MediaCommentWorkerAborted extends Error {
  constructor() { super("The media details worker was cancelled."); this.name = "MediaCommentWorkerAborted"; }
}

/** A single Facebook page must never be able to hold the whole batch open. */
class MediaCommentWorkerTimedOut extends Error {
  constructor() { super("The media details worker exceeded its item time limit."); this.name = "MediaCommentWorkerTimedOut"; }
}

/**
 * Never let a third-party browser promise keep the job slot after cancellation.
 * The underlying operation may finish later, but its Promise remains observed
 * by Promise.race and cannot change the already-terminal job state.
 */
function raceWorkerAbort<T>(signal: AbortSignal, work: Promise<T>, graceMs = 0): Promise<T> {
  if (signal.aborted) return Promise.reject(new MediaCommentWorkerAborted());
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (graceMs > 0) timer = setTimeout(() => reject(new MediaCommentWorkerAborted()), graceMs);
      else reject(new MediaCommentWorkerAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => { signal.removeEventListener("abort", onAbort); if (timer) clearTimeout(timer); };
  });
  return Promise.race([work, aborted]).finally(remove);
}

/**
 * The extractor has its own pagination deadline, but a browser protocol call
 * can occasionally stop resolving before that code regains control. Bound the
 * enclosing worker as well, so one malformed or indefinitely loading Facebook
 * view is recorded as retryable instead of holding the job until its one-hour
 * batch timeout.
 */
function raceWorkerTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MediaCommentWorkerTimedOut()), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timedOut]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The heartbeat rides on the client's progress poll, and browsers throttle a
 * hidden tab's timers hard — Chrome drops them to roughly once a minute after
 * a few minutes out of view. A grace shorter than that throttling interval
 * reports a merely backgrounded tab as a closed page and destroys the run, so
 * this has to clear the worst-case throttled poll by a wide margin.
 */
const OWNER_LEASE_GRACE_MS = 180_000;
const OWNER_LEASE_CHECK_MS = 2_500;
/**
 * Avoid a one-tick Chromium startup stampede without making a 12-worker run
 * appear sequential during its first several seconds. The pool is full in
 * about a second instead of three, while starts remain gently staggered.
 */
const CONTEXT_START_PACE_MS = 100;
/** Recycle authenticated contexts before Facebook renderer state can build up. */
const CONTEXT_MAX_ITEMS = 10;
/** Avoid turning one temporary Facebook throttle into a cancelled candidate run. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
/** Save local candidate progress in compact batches without blocking workers. */
const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 750;
/** The extractor can legitimately spend up to ten minutes on a very large thread. */
const DEFAULT_COMMENT_ITEM_TIMEOUT_MS = 12 * 60_000;

export class MediaCommentJobError extends Error {
  constructor(
    public readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "TOO_MANY_REQUESTS",
    message: string,
  ) { super(message); }
}

/** Inputs are canonical media addresses, never a general-purpose browser URL. */
export function canonicalCommentItem(item: MediaCommentItem): MediaCommentItem {
  const invalid = () => new MediaCommentJobError("BAD_REQUEST", "The Facebook media link must match its photo or reel ID.");
  if (!/^\d{1,40}$/.test(item.postId) || !["posts", "reels"].includes(item.contentType)) throw invalid();
  let url: URL;
  try { url = new URL(item.url); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) throw invalid();
  const id = item.contentType === "reels"
    ? /^\/reel\/(\d+)\/?$/.exec(url.pathname)?.[1]
    : /^\/photo(?:\.php|\/)?$/.test(url.pathname) ? url.searchParams.get("fbid") : null;
  if (id !== item.postId) throw invalid();
  return {
    postId: item.postId,
    contentType: item.contentType,
    url: item.contentType === "reels"
      ? `https://www.facebook.com/reel/${id}/`
      : `https://www.facebook.com/photo.php?fbid=${id}`,
    ...(typeof item.includeComments === "boolean" ? { includeComments: item.includeComments } : {}),
    ...(typeof item.includeReactions === "boolean" ? { includeReactions: item.includeReactions } : {}),
    ...(typeof item.includeMetadata === "boolean" ? { includeMetadata: item.includeMetadata } : {}),
    ...(typeof item.panelCountOnly === "boolean" ? { panelCountOnly: item.panelCountOnly } : {}),
  };
}

/**
 * Ceiling for an explicit FB_COMMENT_WORKERS override. The working number is
 * derived below from the host's actual CPU and memory rather than fixed: the
 * old flat 6 predated the scraper optimisations, when each detail page was
 * doing far more layout and polling work per pass.
 */
export const MAX_COMMENT_WORKERS = 12;
/**
 * A comment thread is substantially heavier than a simple media page: Facebook
 * keeps a virtualized feed, reply controls and live loaders resident. The old
 * 400 MiB estimate admitted twelve contexts in the 8 GiB Docker allocation,
 * which saturated CPU/memory and made every concurrent thread slower (and more
 * likely to time out) than a smaller pool. Budget conservatively so the
 * default is twelve workers on this machine. Contexts are deliberately not
 * reused between items below, so this is a stable active-work budget rather
 * than a growing cache of old Facebook renderer processes. An operator can
 * still explicitly choose a lower value through FB_COMMENT_WORKERS.
 */
const WORKER_MEMORY_BYTES = 400 * 1024 ** 2;
/** Held back for the Next server, the shared Chromium base and the OS. */
const RESERVED_MEMORY_BYTES = 3 * 1024 ** 3;

/** One process-wide pool, including simultaneous jobs from different organizations. */
export function commentWorkerCount(): number {
  // Each worker owns one detail page and is cleaned up with the shared browser
  // when a job settles. An explicit setting still wins, so a hot or shared
  // machine can be dialled straight back down.
  const configured = Number(process.env.FB_COMMENT_WORKERS);
  if (Number.isInteger(configured) && configured > 0) return Math.min(MAX_COMMENT_WORKERS, configured);
  // Memory is the binding constraint: a context that cannot allocate crashes
  // its page and fails the item, which is far worse than running fewer pages.
  const constrained = process.constrainedMemory?.() ?? 0;
  const memoryBytes = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  const byMemory = Math.floor(Math.max(0, memoryBytes - RESERVED_MEMORY_BYTES) / WORKER_MEMORY_BYTES);
  // Leave cores for the Node event loop that drives every page.
  const byCpu = availableParallelism() - 2;
  return Math.max(2, Math.min(MAX_COMMENT_WORKERS, byMemory, byCpu));
}

function countComments(comments: FbBrowserComment[]): number {
  let count = 0;
  const pending = [...comments];
  while (pending.length) {
    const comment = pending.pop()!;
    count += 1;
    if (comment.replies) pending.push(...comment.replies);
  }
  return count;
}

interface StoreOptions {
  fetcher?: Fetcher;
  concurrency?: number;
  ttlMs?: number;
  maxJobs?: number;
  maxJobComments?: number;
  maxStoredBytes?: number;
  maxJobDurationMs?: number;
  ownerLeaseGraceMs?: number;
  ownerLeaseCheckMs?: number;
  /** Let an abort-aware fetcher return its collected partial data before force-release. */
  workerAbortGraceMs?: number;
  /** Hard ceiling for one media detail item, independent of the batch timeout. */
  itemTimeoutMs?: number;
  /** Tests and custom fetchers can opt out of browser-context pooling. */
  poolBrowserContexts?: boolean;
  /** Short job-local pause after Facebook returns a temporary rate limit. */
  rateLimitCooldownMs?: number;
  /** Debounce local candidate workspace checkpoints while a job is active. */
  checkpointDebounceMs?: number;
}

/**
 * Long-running scraping is detached from the mutation response, but never from
 * its cancellation signal or owner. This local standalone server retains jobs
 * for one hour; a process restart explicitly invalidates their IDs.
 */
export class FacebookCommentJobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly fetcher: Fetcher;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxJobComments: number;
  private readonly maxStoredBytes: number;
  private readonly maxJobDurationMs: number;
  private readonly requestedConcurrency: number;
  private readonly poolBrowserContexts: boolean;
  private readonly ownerLeaseGraceMs: number;
  private readonly ownerLeaseCheckMs: number;
  private readonly workerAbortGraceMs: number;
  private readonly itemTimeoutMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly checkpointDebounceMs: number;
  private readonly contextPools = new Map<string, ContextPool>();
  private active = 0;
  private cursor = 0;
  private scheduled = false;
  /** A stable visual identity for every shared browser-page slot. */
  private readonly workerSlots: Array<WorkerLease | null>;

  constructor(options: StoreOptions = {}) {
    this.fetcher = options.fetcher ?? (async (...args) => {
      const { fetchFacebookMediaComments } = await import("./media-comments");
      return fetchFacebookMediaComments(...args);
    });
    this.requestedConcurrency = Math.max(1, Math.min(MAX_COMMENT_WORKERS, options.concurrency ?? commentWorkerCount()));
    this.concurrency = this.requestedConcurrency;
    this.workerSlots = Array.from({ length: this.concurrency }, () => null);
    // Reuse a logged-in context for a small bounded batch. Creating one per
    // item wastes setup time, while unlimited reuse makes Facebook's virtual
    // feed retain renderer processes across a long run. releaseContext recycles
    // each one after CONTEXT_MAX_ITEMS, so both speed and memory remain stable.
    this.poolBrowserContexts = options.poolBrowserContexts ?? !options.fetcher;
    this.ownerLeaseGraceMs = options.ownerLeaseGraceMs ?? OWNER_LEASE_GRACE_MS;
    this.ownerLeaseCheckMs = options.ownerLeaseCheckMs ?? OWNER_LEASE_CHECK_MS;
    this.workerAbortGraceMs = options.workerAbortGraceMs ?? 5_000;
    this.itemTimeoutMs = Math.max(1, options.itemTimeoutMs ?? DEFAULT_COMMENT_ITEM_TIMEOUT_MS);
    this.rateLimitCooldownMs = Math.max(1, options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    this.checkpointDebounceMs = Math.max(1, options.checkpointDebounceMs ?? DEFAULT_CHECKPOINT_DEBOUNCE_MS);
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.maxJobs = options.maxJobs ?? 10;
    this.maxJobComments = options.maxJobComments ?? 100_000;
    this.maxStoredBytes = options.maxStoredBytes ?? 128 * 1024 ** 2;
    this.maxJobDurationMs = options.maxJobDurationMs ?? 60 * 60_000;
  }

  start(owner: Owner, cookies: string, input: { items: MediaCommentItem[]; limit: number; withReplies: boolean; includeComments?: boolean; includeReactions?: boolean; includeMetadata?: boolean; ownerLeaseId?: string; appendToActive?: boolean }, completion: CompletionOptions = {}): { jobId: string; replacedJobIds: string[]; appendedItems: number; ownerLeaseId?: string } {
    if (!owner.orgId || !owner.userId || !cookies) throw new MediaCommentJobError("BAD_REQUEST", "An organization, user and Facebook session are required.");
    if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 5000 || !input.items.length || input.items.length > 2000) {
      throw new MediaCommentJobError("BAD_REQUEST", "Choose 1 to 2000 media items and a comment limit from 0 to 5000.");
    }
    const includeComments = input.includeComments ?? true;
    const includeReactions = input.includeReactions ?? false;
    const includeMetadata = input.includeMetadata ?? true;
    if (!includeComments && !includeReactions && !includeMetadata) throw new MediaCommentJobError("BAD_REQUEST", "Select comments, reactions or metadata to retrieve media details.");
    const unique = new Map<string, MediaCommentItem>();
    for (const item of input.items) {
      const normalized = canonicalCommentItem(item);
      unique.set(`${normalized.contentType}:${normalized.postId}`, normalized);
    }
    this.prune();
    this.expireOwnerLeases();
    if (input.appendToActive) {
      const active = [...this.jobs.values()].find((job) =>
        job.orgId === owner.orgId && job.userId === owner.userId && job.status === "running" && !job.controller.signal.aborted,
      );
      if (active) {
        // A second retry click must extend the existing candidate run, not
        // cancel it. Keep an item that is pending/running/settled only once:
        // a duplicate click then becomes harmless rather than duplicating a
        // browser fetch or making workspace merge evidence ambiguous.
        const known = new Set(active.items.map((item) => `${item.contentType}:${item.postId}`));
        const additions = [...unique.values()].filter((item) => !known.has(`${item.contentType}:${item.postId}`));
        if (additions.length) {
          active.items.push(...additions.map((item) => ({ ...item, status: "pending" as const, comments: [] })));
          active.includeComments ||= includeComments;
          active.includeReactions ||= includeReactions;
          active.includeMetadata ||= includeMetadata;
          active.limit = Math.max(active.limit, input.limit);
          active.withReplies ||= input.withReplies;
          active.lastOwnerHeartbeat = Date.now();
          this.queueCheckpoint(active, true);
          this.schedule();
        }
        return { jobId: active.id, replacedJobIds: [], appendedItems: additions.length, ownerLeaseId: active.ownerLeaseId };
      }
    }
    const replacedJobIds = this.supersedeActiveJobs(owner);
    this.makeRoom();
    const id = randomUUID();
    const timer = setTimeout(() => {
      const job = this.jobs.get(id);
      if (job?.status === "running") this.forceStop(job, "timeout", "The media details run reached its time limit. Completed results are preserved.");
    }, this.maxJobDurationMs);
    timer.unref?.();
    const now = Date.now();
    const job: Job = {
      ...owner, id, cookies, limit: input.limit, withReplies: input.withReplies, includeComments, includeReactions, includeMetadata,
      status: "running", items: [...unique.values()].map((item) => ({ ...item, status: "pending", comments: [] })),
      controller: new AbortController(), started: now, active: 0, bytes: 0, commentCount: 0, observedCommentCount: 0, excludedNonTextCommentCount: 0, excludedAttachmentCommentCount: 0, timer,
      onProgress: completion.onProgress, onComplete: completion.onComplete, onAuthenticationFailure: completion.onAuthenticationFailure,
      checkpointChain: Promise.resolve(), completionDispatched: false,
      ownerLeaseId: input.ownerLeaseId, lastOwnerHeartbeat: input.ownerLeaseId ? now : undefined,
    };
    if (job.ownerLeaseId) {
      job.leaseTimer = setInterval(() => this.expireOwnerLeases(), this.ownerLeaseCheckMs);
      job.leaseTimer.unref?.();
    }
    this.jobs.set(id, job);
    this.schedule();
    return { jobId: id, replacedJobIds, appendedItems: unique.size, ownerLeaseId: job.ownerLeaseId };
  }

  progress(owner: Owner, jobId: string, options: { includeItems?: boolean; ownerLeaseId?: string } = {}): MediaCommentProgress {
    this.prune();
    const job = this.owned(owner, jobId);
    if (job.status === "running" && job.ownerLeaseId && job.ownerLeaseId === options.ownerLeaseId) job.lastOwnerHeartbeat = Date.now();
    return this.snapshot(job, options.includeItems ?? true);
  }

  private snapshot(job: Job, includeItems = true): MediaCommentProgress {
    const slots: MediaCommentWorkerSlot[] = this.workerSlots.map((lease, index) => {
      if (!lease) return { slot: index + 1, state: "idle" };
      if (lease.jobId !== job.id) return { slot: index + 1, state: "busy" };
      return {
        slot: index + 1,
        state: "running",
        contentType: lease.item.contentType,
        postId: lease.item.postId,
        stage: lease.item.workerStage ?? "opening",
        startedAt: lease.item.workerStartedAt,
      };
    });
    return structuredClone({
      status: job.status,
      total: job.items.length,
      completed: job.items.filter((item) => item.status !== "pending" && item.status !== "running").length,
      active: job.active,
      failed: job.items.filter((item) => item.status === "failed").length,
      partial: job.items.filter((item) => item.status === "partial").length,
      partialComments: job.includeComments
        ? job.items.filter(hasIncompleteCommentDelta).length : 0,
      partialDetails: job.items.filter((item) => item.status === "partial"
        && (!job.includeComments || (item.commentsStatus ?? item.status) !== "partial")).length,
      commentCount: job.commentCount,
      observedCommentCount: job.observedCommentCount,
      excludedNonTextCommentCount: job.excludedNonTextCommentCount,
      excludedAttachmentCommentCount: job.excludedAttachmentCommentCount,
      durationMs: (job.ended ?? Date.now()) - job.started,
      // Browser polling only needs counts while a run is active. Sending every
      // accumulated comment tree each second grows with the run and causes the
      // client to repeatedly deserialize and render the whole collection.
      items: includeItems ? job.items : [],
      includeComments: job.includeComments,
      includeReactions: job.includeReactions,
      includeMetadata: job.includeMetadata,
      workers: { requested: this.requestedConcurrency, capacity: this.concurrency, active: job.active, pacedStartMs: CONTEXT_START_PACE_MS, slots },
      sheetSave: job.sheetSave,
      error: job.error,
      stopReason: job.stopReason,
    });
  }

  cancel(owner: Owner, jobId: string): { ok: true } {
    this.prune();
    const job = this.owned(owner, jobId);
    if (job.status === "running" || job.active > 0) this.forceStop(job, "cancelled", "Stopped by the user. Completed results are preserved.");
    return { ok: true };
  }

  /** Stops only the current user's job in this organization. The next fetch
   * may begin immediately; the cancelled job's terminal Sheet save continues
   * independently and carries only data collected before this transition. */
  supersede(owner: Owner): { replacedJobIds: string[] } {
    this.prune();
    const replacedJobIds = this.supersedeActiveJobs(owner);
    return { replacedJobIds };
  }

  /** Lets a remounted page reclaim its own running details job. This renews
   * only that user's owner lease; it never reveals another user's activity. */
  currentForOwner(owner: Owner): { jobId: string; ownerLeaseId?: string; progress: MediaCommentProgress } | null {
    this.prune();
    const job = [...this.jobs.values()].find((entry) =>
      entry.orgId === owner.orgId && entry.userId === owner.userId && (entry.status === "running" || entry.active > 0),
    );
    if (!job) return null;
    if (job.ownerLeaseId) job.lastOwnerHeartbeat = Date.now();
    return { jobId: job.id, ownerLeaseId: job.ownerLeaseId, progress: this.snapshot(job, false) };
  }

  hasActive(owner: Owner): boolean {
    this.prune();
    return [...this.jobs.values()].some((job) => job.orgId === owner.orgId && job.userId === owner.userId && (job.status === "running" || job.active > 0));
  }

  private owned(owner: Owner, jobId: string): Job {
    const job = this.jobs.get(jobId);
    // Do not disclose another user's job or distinguish it from an expired ID.
    if (!job || job.orgId !== owner.orgId || job.userId !== owner.userId) {
      throw new MediaCommentJobError("NOT_FOUND", "This media details run is unavailable or expired, or the server restarted. Start a new run.");
    }
    return job;
  }

  private remove(job: Job) {
    clearTimeout(job.timer);
    if (job.leaseTimer) clearInterval(job.leaseTimer);
    if (job.checkpointTimer) clearTimeout(job.checkpointTimer);
    this.disposeContexts(job);
    job.cookies = "";
    job.onProgress = undefined;
    job.onAuthenticationFailure = undefined;
    this.jobs.delete(job.id);
  }

  private prune() {
    this.expireOwnerLeases();
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!job.active && job.sheetSave?.status !== "saving" && job.ended !== undefined && (job.retainedAt ?? job.ended) + this.ttlMs <= now) this.remove(job);
    }
  }

  private makeRoom() {
    for (const job of this.jobs.values()) {
      if (this.jobs.size < this.maxJobs) break;
      if (job.status !== "running" && !job.active && job.sheetSave?.status !== "saving") this.remove(job);
    }
    if (this.jobs.size >= this.maxJobs) throw new MediaCommentJobError("TOO_MANY_REQUESTS", "The media details queue is full. Wait for an existing run to finish.");
  }

  /** Atomically replace this user's currently active job without exposing or
   * changing another user's work in the same organization. */
  private supersedeActiveJobs(owner: Owner): string[] {
    const activeJobs = [...this.jobs.values()].filter((job) =>
      job.orgId === owner.orgId && job.userId === owner.userId && (job.status === "running" || job.active > 0),
    );
    for (const job of activeJobs) {
      this.forceStop(job, "superseded", "Details retrieval was replaced by a newer fetch. Completed results are preserved.");
    }
    return activeJobs.map((job) => job.id);
  }

  /** A page refresh/close stops progress polling. Do not leave its job holding
   * an organization slot forever; terminal Sheet saving still runs after the
   * active pages have unwound. */
  private expireOwnerLeases() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || !job.ownerLeaseId || !job.lastOwnerHeartbeat) continue;
      if (now - job.lastOwnerHeartbeat > this.ownerLeaseGraceMs) {
        this.forceStop(job, "owner_disconnected", "Details retrieval stopped because its browser page was closed or refreshed. Completed results are preserved.");
      }
    }
  }

  private poolFor(job: Job): ContextPool {
    let pool = this.contextPools.get(job.id);
    if (!pool) {
      pool = { idle: [], all: new Set(), completedItems: new Map() };
      this.contextPools.set(job.id, pool);
    }
    return pool;
  }

  /** Contexts stay within one job and are recycled after a bounded item batch. */
  private async acquireContext(job: Job): Promise<BrowserContext | undefined> {
    if (!this.poolBrowserContexts) return undefined;
    const pool = this.poolFor(job);
    const idle = pool.idle.pop();
    if (idle) return idle;
    const context = await createFacebookContext(job.cookies, { blockMedia: true });
    if (job.controller.signal.aborted) {
      await context.close().catch(() => {});
      return undefined;
    }
    pool.all.add(context);
    pool.completedItems.set(context, 0);
    return context;
  }

  private releaseContext(job: Job, context: BrowserContext) {
    const pool = this.contextPools.get(job.id);
    if (!pool || job.controller.signal.aborted || job.status !== "running") {
      pool?.all.delete(context);
      pool?.completedItems.delete(context);
      void context.close().catch(() => {});
      return;
    }
    const completedItems = (pool.completedItems.get(context) ?? 0) + 1;
    if (completedItems >= CONTEXT_MAX_ITEMS) {
      pool.all.delete(context);
      pool.completedItems.delete(context);
      void context.close().catch(() => {});
      return;
    }
    pool.completedItems.set(context, completedItems);
    pool.idle.push(context);
  }

  /** Remove a context that was interrupted mid-item so it is never reused. */
  private discardContext(job: Job, context: BrowserContext) {
    const pool = this.contextPools.get(job.id);
    if (pool) {
      pool.all.delete(context);
      pool.completedItems.delete(context);
      pool.idle = pool.idle.filter((idle) => idle !== context);
    }
    void context.close().catch(() => {});
  }

  private disposeContexts(job: Job) {
    const pool = this.contextPools.get(job.id);
    if (!pool) return;
    this.contextPools.delete(job.id);
    for (const context of pool.all) void context.close().catch(() => {});
    pool.idle.length = 0;
    pool.all.clear();
    pool.completedItems.clear();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.expireOwnerLeases();
      if (this.active >= this.concurrency) return;
      const now = Date.now();
      const ready = [...this.jobs.values()].filter((job) => job.status === "running" && !job.controller.signal.aborted
        && (!job.cooldownUntil || job.cooldownUntil <= now)
        && job.items.some((item) => item.status === "pending"));
      if (!ready.length) return;
      // Round-robin across organizations and pace only fresh-context creation.
      const job = ready[this.cursor++ % ready.length];
      const item = job.items.find((entry) => entry.status === "pending")!;
      item.status = "running";
      this.claimWorkerSlot(job, item);
      void this.run(job, item);
      const idleContext = this.contextPools.get(job.id)?.idle.length;
      if (this.active < this.concurrency) {
        this.scheduled = true;
        const delay = this.poolBrowserContexts && !idleContext ? CONTEXT_START_PACE_MS : 0;
        setTimeout(() => { this.scheduled = false; this.schedule(); }, delay).unref?.();
      }
    });
  }

  private stop(job: Job, reason: string, message: string) {
    if (reason === 'authentication' && job.onAuthenticationFailure) {
      const notify = job.onAuthenticationFailure;
      job.onAuthenticationFailure = undefined;
      void notify().catch(() => {});
    }
    // Keep polling while active pages close so their collected partial comments
    // reach the client before it observes the terminal cancelled status.
    job.status = job.active ? "running" : "cancelled";
    job.stopReason = reason;
    job.error = message;
    if (!job.active) job.ended ??= Date.now();
    clearTimeout(job.timer);
    if (job.leaseTimer) clearInterval(job.leaseTimer);
    for (const item of job.items) {
      if (item.status === "pending") {
        item.status = "cancelled";
        item.stopReason = reason;
        item.error = message;
      }
    }
    job.controller.abort();
    if (!job.active) job.cookies = "";
    this.finishIfSettled(job);
    this.schedule();
  }

  /** Browser operations can remain unresolved after their context closes.
   * Release their accounting synchronously, and make their later finally block
   * a no-op, so neither an owner timeout nor a replacement can hold the pool. */
  private forceStop(job: Job, reason: string, message: string) {
    this.stop(job, reason, message);
    for (const item of job.items) {
      if (item.status === "running") {
        item.status = "cancelled";
        item.stopReason = reason;
        item.error = message;
        this.releaseWorkerSlot(job, item);
      }
    }
    this.disposeContexts(job);
    job.status = "cancelled";
    job.ended ??= Date.now();
    job.cookies = "";
    this.finishIfSettled(job);
    this.releaseBrowserWhenIdle();
  }

  private claimWorkerSlot(job: Job, item: MediaCommentProgressItem) {
    const worker = item as RunningMediaCommentItem;
    const slotIndex = this.workerSlots.findIndex((slot) => slot === null);
    if (slotIndex < 0) throw new MediaCommentJobError("CONFLICT", "No browser worker slot is available.");
    worker.workerSlotReleased = false;
    worker.workerSlot = slotIndex + 1;
    worker.workerStage = "opening";
    worker.workerStartedAt = Date.now();
    this.workerSlots[slotIndex] = { jobId: job.id, orgId: job.orgId, userId: job.userId, item };
    this.active += 1;
    job.active += 1;
  }

  private releaseWorkerSlot(job: Job, item: MediaCommentProgressItem) {
    const worker = item as RunningMediaCommentItem;
    if (worker.workerSlotReleased) return;
    worker.workerSlotReleased = true;
    const slotIndex = (worker.workerSlot ?? 0) - 1;
    if (slotIndex >= 0 && this.workerSlots[slotIndex]?.item === item) this.workerSlots[slotIndex] = null;
    this.active = Math.max(0, this.active - 1);
    job.active = Math.max(0, job.active - 1);
  }

  private finishIfSettled(job: Job) {
    if (job.active || job.items.some((item) => item.status === "pending" || item.status === "running")) return;
    // Flush the most recent local snapshot before terminal completion. This
    // protects completed items if the app loses power while a larger retry is
    // still running, without turning intermediate work into a Sheet write.
    this.queueCheckpoint(job, true);
    // Publish the saving flag in the same synchronous transition as the terminal
    // job status, so a polling client cannot mistake it for an unsaved result.
    const callback = !job.completionDispatched ? job.onComplete : undefined;
    if (callback) job.sheetSave = { status: "saving" };
    if (job.status === "running") job.status = job.controller.signal.aborted ? "cancelled" : "completed";
    job.ended ??= Date.now();
    job.retainedAt ??= job.ended;
    clearTimeout(job.timer);
    if (job.leaseTimer) clearInterval(job.leaseTimer);
    job.cookies = "";
    job.completionDispatched = true;
    job.onAuthenticationFailure = undefined;
    job.onComplete = undefined;
    this.disposeContexts(job);
    this.releaseBrowserWhenIdle();
    if (!callback) return;
    const snapshot = this.snapshot(job);
    void Promise.resolve().then(async () => {
      await job.checkpointChain;
      return callback(snapshot);
    }).then((result) => {
      // Only return the explicitly agreed save fields, never arbitrary values
      // that a connection helper might accidentally include in its response.
      const saved = { url: result.url, folderUrl: result.folderUrl, fileId: result.fileId, updatedAt: result.updatedAt };
      if (Object.values(saved).some((value) => typeof value !== "string" || !value)) throw new Error("Invalid save result");
      job.sheetSave = { status: "saved", result: saved };
      job.retainedAt = Date.now();
    }).catch(() => {
      job.sheetSave = { status: "failed", error: "Saving the retrieved results failed. The retrieved data is preserved for a manual retry." };
      job.retainedAt = Date.now();
    });
  }

  /** Close task-owned Chromium/Xvfb as soon as every details job is settled. */
  private releaseBrowserWhenIdle() {
    if (this.active || [...this.jobs.values()].some((entry) => entry.status === "running")) return;
    void import("./browser-pool").then(({ resetSharedBrowser }) => {
      // A new job may have arrived while the module import resolved.
      if (this.active || [...this.jobs.values()].some((entry) => entry.status === "running")) return;
      return resetSharedBrowser();
    }).catch(() => {});
  }

  private retain(job: Job, comments: FbBrowserComment[], detailsBytes = 0): { comments: FbBrowserComment[]; limited: boolean; detailsRetained: boolean } {
    let availableBytes = this.maxStoredBytes - [...this.jobs.values()].reduce((sum, stored) => sum + stored.bytes, 0);
    // Evict old completed snapshots before truncating a currently running result.
    const incomingBytes = Buffer.byteLength(JSON.stringify(comments)) + detailsBytes;
    for (const stored of this.jobs.values()) {
      if (incomingBytes <= availableBytes) break;
      if (stored !== job && stored.status !== "running" && !stored.active && stored.sheetSave?.status !== "saving") {
        availableBytes += stored.bytes;
        this.remove(stored);
      }
    }
    const detailsRetained = detailsBytes <= availableBytes;
    if (detailsRetained) {
      job.bytes += detailsBytes;
      availableBytes -= detailsBytes;
    }
    const retained: FbBrowserComment[] = [];
    for (const comment of comments) {
      const count = countComments([comment]);
      const bytes = Buffer.byteLength(JSON.stringify(comment));
      if (job.commentCount + count > this.maxJobComments || bytes > availableBytes) break;
      retained.push(comment);
      job.commentCount += count;
      job.bytes += bytes;
      availableBytes -= bytes;
    }
    return { comments: retained, limited: retained.length < comments.length || !detailsRetained, detailsRetained };
  }

  /** Pause only this candidate. Authentication remains terminal, but a
   * temporary Facebook throttle should not discard the rest of its queue. */
  private pauseForRateLimit(job: Job) {
    const until = Date.now() + this.rateLimitCooldownMs;
    job.cooldownUntil = Math.max(job.cooldownUntil ?? 0, until);
    const delay = Math.max(1, job.cooldownUntil - Date.now());
    setTimeout(() => this.schedule(), delay).unref?.();
  }

  /** Queue a serialized, local-only candidate workspace checkpoint. A failed
   * checkpoint does not interrupt scraping; the terminal completion still
   * makes one final attempt with the complete retained snapshot. */
  private queueCheckpoint(job: Job, immediate = false) {
    if (!job.onProgress || job.completionDispatched) return;
    const dispatch = () => {
      job.checkpointTimer = undefined;
      const callback = job.onProgress;
      if (!callback) return;
      const snapshot = this.snapshot(job);
      job.checkpointChain = job.checkpointChain
        .catch(() => {})
        .then(() => callback(snapshot))
        .then(() => undefined)
        .catch(() => {});
    };
    if (immediate) {
      if (job.checkpointTimer) clearTimeout(job.checkpointTimer);
      dispatch();
      return;
    }
    if (!job.checkpointTimer) {
      job.checkpointTimer = setTimeout(dispatch, this.checkpointDebounceMs);
      job.checkpointTimer.unref?.();
    }
  }

  private async run(job: Job, item: MediaCommentProgressItem) {
    const started = Date.now();
    // A job can publish the same settled item through both an incremental
    // checkpoint and its terminal snapshot. Evidence consumers must be able
    // to tell that those are one browser execution, while an automatic retry
    // gets a genuinely new ID on its next pass through this method.
    item.attemptId = randomUUID();
    // Set when a retriable detail-stage failure returns the item to pending.
    let retryScheduled = false;
    const includeComments = item.includeComments ?? job.includeComments;
    const includeReactions = item.includeReactions ?? job.includeReactions;
    const includeMetadata = item.includeMetadata ?? job.includeMetadata;
    let context: BrowserContext | undefined;
    try {
      context = await raceWorkerAbort(job.controller.signal, this.acquireContext(job));
      if (job.controller.signal.aborted) {
        item.status = "cancelled";
        item.stopReason = job.stopReason ?? "cancelled";
        return;
      }
      const result = await raceWorkerAbort(job.controller.signal, raceWorkerTimeout(this.fetcher(
        { postId: item.postId, url: item.url, contentType: item.contentType },
        job.cookies,
        {
          limit: job.limit, withReplies: job.withReplies, includeComments, includeReactions, includeMetadata,
          panelCountOnly: item.panelCountOnly === true, signal: job.controller.signal, context,
          onStage: (stage) => {
            if (item.status !== "running" || job.controller.signal.aborted) return;
            item.workerStage = stage;
            this.queueCheckpoint(job);
          },
        },
      ), this.itemTimeoutMs), this.workerAbortGraceMs);
      // A force-stop may have terminally saved the job while an uncooperative
      // browser promise was unwinding. Do not mutate that completed snapshot.
      if (job.controller.signal.aborted) {
        item.status = "cancelled";
        item.stopReason = job.stopReason ?? "cancelled";
        return;
      }
      const details = { engagement: includeReactions ? result.engagement : undefined, metadata: includeMetadata ? result.metadata : undefined };
      item.workerStage = "saving";
      const detailsBytes = details.engagement || details.metadata ? Buffer.byteLength(JSON.stringify(details)) : 0;
      const comments = includeComments ? result.comments : [];
      const retained = this.retain(job, comments, detailsBytes);
      item.comments = retained.comments;
      item.durationMs = result.durationMs;
      item.error = result.error;
      item.reportedCount = includeComments ? result.reportedCount : undefined;
      item.panelReportedCount = includeComments ? result.panelReportedCount : undefined;
      item.observedCommentCount = includeComments ? result.observedCommentCount : undefined;
      item.textCommentCount = includeComments ? result.textCommentCount : undefined;
      item.excludedNonTextCommentCount = includeComments ? result.excludedNonTextCommentCount : undefined;
      item.excludedAttachmentCommentCount = includeComments ? result.excludedAttachmentCommentCount : undefined;
      item.commentsContentScope = includeComments ? result.commentsContentScope : undefined;
      item.commentsSourceView = includeComments ? result.commentsSourceView : undefined;
      if (includeComments) {
        job.observedCommentCount += result.observedCommentCount ?? 0;
        job.excludedNonTextCommentCount += result.excludedNonTextCommentCount ?? 0;
        job.excludedAttachmentCommentCount += result.excludedAttachmentCommentCount ?? 0;
      }
      if (retained.detailsRetained) {
        item.engagement = details.engagement;
        item.metadata = details.metadata;
      }
      if (includeComments) {
        // Reaction availability must not change a successful comment result.
        // Legacy comments-only engines used the overall status for comments.
        item.commentsStatus = retained.comments.length < comments.length ? "partial"
          : result.commentsStatus ?? (!includeReactions ? result.status : undefined);
      }
      if (job.controller.signal.aborted) {
        // The engine may return collected partial data while unwinding an abort.
        item.status = "cancelled";
        item.stopReason = job.stopReason ?? "cancelled";
      } else {
        item.status = retained.limited ? "partial" : result.status;
        item.stopReason = retained.limited ? "storage_limit" : result.stopReason;
        if (result.stopReason === "authentication" || result.stopReason === "rate_limit") {
          item.stopReason = result.stopReason;
          item.status = item.comments.length || item.metadata || item.engagement ? "partial" : "failed";
          item.error = result.stopReason === "authentication"
            ? "Facebook requires a new sign-in or session check. Collected details are preserved."
            : "Facebook temporarily limited this session. Collected details are preserved; wait before retrying.";
          if (result.stopReason === "authentication") this.forceStop(job, result.stopReason, item.error);
          else this.pauseForRateLimit(job);
        } else if (retained.limited) {
          item.error = "The retained-details limit was reached. Export these results and run a smaller batch.";
          this.forceStop(job, "storage_limit", item.error);
        }
      }
    } catch (error) {
      if (job.controller.signal.aborted) {
        item.status = "cancelled";
        item.stopReason = job.stopReason ?? "cancelled";
      } else if (error instanceof MediaCommentWorkerTimedOut) {
        // Retain comments from prior attempts in the workspace, but do not
        // retry this same hung page inside the run. Closing its context
        // releases any renderer that stopped responding and lets the rest of
        // the selected range settle normally.
        if (context) {
          this.discardContext(job, context);
          context = undefined;
        }
        item.status = "partial";
        item.stopReason = "time_budget";
        item.commentsStatus = includeComments ? "partial" : undefined;
        item.error = "Facebook did not finish this media thread in time. Earlier saved comments are preserved; retry this item later.";
      } else if (error instanceof FbBrowserAuthError || error instanceof FbScrapeAuthError) {
        item.status = "failed";
        item.stopReason = "authentication";
        item.error = "Facebook requires a new sign-in or session check. Refresh the saved session before retrying.";
        this.forceStop(job, "authentication", item.error);
      } else if (error instanceof FbBrowserRateLimitError) {
        const attempts = (item.rateLimitAttempts ?? 0) + 1;
        item.rateLimitAttempts = attempts;
        if (attempts === 1) {
          // A clean request did not return any comments to preserve, so retry
          // it once after the shared cooldown instead of cancelling every
          // other Photo and Reel in this candidate.
          item.status = "pending";
          item.stopReason = undefined;
          item.error = undefined;
          retryScheduled = true;
        } else {
          item.status = "failed";
          item.stopReason = "rate_limit";
          item.error = "Facebook temporarily limited this session. Wait before retrying; the saved session was not invalidated.";
        }
        this.pauseForRateLimit(job);
      } else if (error instanceof FbMediaDetailFetchError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "FB_MEDIA_DETAIL_FETCH")) {
        const detailError = error as FbMediaDetailFetchError;
        // A detail-stage failure is a slow or half-rendered page, not a refusal.
        // It already had a "retry" affordance the user had to click by hand, so
        // spend one automatic attempt here instead: the item goes back to
        // pending and a fresh browser context picks it up.
        const attempts = (item.detailAttempts ?? 0) + 1;
        item.detailAttempts = attempts;
        if (attempts === 1 && !job.controller.signal.aborted) {
          item.status = "pending";
          item.stopReason = undefined;
          item.error = undefined;
          retryScheduled = true;
        } else {
          item.status = "failed";
          item.stopReason = detailError.stage;
          item.error = detailError.message;
        }
      } else {
        // Raw browser errors can contain request details. Return a stable public error.
        item.status = "failed";
        item.stopReason = "fetch_error";
        item.error = includeComments && !includeReactions
          ? "Facebook comments could not be retrieved for this item. Retry it in a new run."
          : "Facebook media details could not be retrieved for this item. Retry it in a new run.";
      }
      if (!retryScheduled) item.durationMs = Date.now() - started;
    } finally {
      if (context) this.releaseContext(job, context);
      this.releaseWorkerSlot(job, item);
      this.queueCheckpoint(job);
      this.finishIfSettled(job);
      this.schedule();
    }
  }
}

// Next's standalone Node server keeps the same store across requests and route
// module reloads. It deliberately does not pretend to survive a server restart.
const processState = globalThis as typeof globalThis & { mediaHubFacebookCommentJobs?: FacebookCommentJobStore };
export const facebookCommentJobs = processState.mediaHubFacebookCommentJobs ??= new FacebookCommentJobStore();
