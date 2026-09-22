/**
 * Instagram comment harvesting.
 *
 * The endpoint is `www.instagram.com/api/v1/media/{id}/comments/`, but it only
 * returns JSON when the request carries an **Instagram Android app**
 * User-Agent. With a desktop-browser UA the same URL serves the SPA HTML shell
 * instead — silently, with HTTP 200 — which is the single most confusing
 * failure mode here. Everything else in this codebase talks to Instagram with
 * the desktop UA, so this module deliberately overrides it.
 *
 * Pagination is cursor-based on `next_min_id` and returns ~15 comments a page,
 * so a post with 10k comments costs ~670 requests. Instagram rate-limits per
 * ACCOUNT, not per IP or process — running several harvests concurrently on one
 * session gets that session checkpointed rather than finishing sooner. Callers
 * should stay sequential and let the built-in pacing do its job.
 *
 * NOTE: scraping violates Instagram's ToS; use a throwaway account.
 */
import { normalizeSession, InstaAuthError, InstaRateLimitError, igProxyDispatcher } from "./fetcher";

/** The Android app UA is load-bearing — see the module docstring. */
const APP_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";
const REQUEST_TIMEOUT_MS = 20_000;

/** Base pacing between comment pages. Instagram tolerates roughly this. */
const BASE_DELAY_MS = 1_400;
const MAX_BACKOFF_MS = 60_000;

export interface InstaComment {
  id: string;
  text: string;
  createdAt: string | null;
  likeCount: number;
  /** 0 = top-level, 1 = reply. */
  depth: number;
  parentId: string | null;
  userId: string | null;
  username: string;
  fullName: string;
  profilePic: string | null;
  isVerified: boolean;
  /** Replies Instagram says exist on this comment (may exceed those returned). */
  replyCount: number;
  /** Non-text comment payload, retained in the JSON workspace for audit. */
  attachmentKind: "media" | "voice" | "visual" | null;
}

export interface CommentHarvestResult {
  mediaId: string;
  comments: InstaComment[];
  /** Count Instagram reports for the post — compare against comments.length. */
  reportedTotal: number | null;
  pagesFetched: number;
  requestCount: number;
  /** True when Instagram still had more but a cap stopped us. */
  truncated: boolean;
  elapsedMs: number;
}

function headersFor(sessionRaw: string): Record<string, string> {
  const s = normalizeSession(sessionRaw);
  const h: Record<string, string> = {
    "User-Agent": APP_UA,
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: s.cookie,
  };
  if (s.csrftoken) h["x-csrftoken"] = s.csrftoken;
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mapComment(raw: any, depth: number, parentId: string | null): InstaComment | null {
  const id = String(raw?.pk ?? raw?.id ?? "");
  if (!id) return null;
  const createdAt =
    typeof raw?.created_at === "number"
      ? new Date(raw.created_at * 1000).toISOString()
      : typeof raw?.created_at_utc === "number"
        ? new Date(raw.created_at_utc * 1000).toISOString()
        : null;
  return {
    id,
    text: raw?.text ?? "",
    createdAt,
    likeCount: Number(raw?.comment_like_count ?? raw?.like_count ?? 0) || 0,
    depth,
    parentId,
    userId: raw?.user?.pk != null ? String(raw.user.pk) : null,
    username: raw?.user?.username ?? "",
    fullName: raw?.user?.full_name ?? "",
    profilePic: raw?.user?.profile_pic_url ?? null,
    isVerified: Boolean(raw?.user?.is_verified),
    replyCount: Number(raw?.child_comment_count ?? 0) || 0,
    attachmentKind: raw?.media_share ? "media" : raw?.voice_media ? "voice" : raw?.visual_media ? "visual" : null,
  };
}

/**
 * Fetch the replies hanging off one parent comment.
 *
 * This matters for accuracy, not completeness-for-its-own-sake: Instagram's
 * `comment_count` counts the WHOLE thread, replies included, while the
 * top-level connection returns only parents. On a conversational post that is
 * most of the apparent shortfall — one measured post reported 46 comments and
 * returned 23 parents carrying exactly 23 replies.
 *
 * `preview_child_comments` on the parent is usually empty, so replies have to
 * be requested explicitly per parent. That costs one request per parent that
 * has any, which is why callers opt in.
 */
export async function fetchChildComments(
  mediaId: string,
  parentCommentId: string,
  sessionRaw: string,
  options: { max?: number; delayMs?: number } = {},
): Promise<InstaComment[]> {
  const { max = 200, delayMs = 300 } = options;
  const headers = headersFor(sessionRaw);
  const out: InstaComment[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let guard = 0;

  while (out.length < max && guard < 25) {
    guard += 1;
    const url = new URL(
      `https://www.instagram.com/api/v1/media/${mediaId}/comments/${parentCommentId}/child_comments/`,
    );
    if (cursor) url.searchParams.set("max_id", cursor);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
        cache: "no-store",
        ...(igProxyDispatcher() ? ({ dispatcher: igProxyDispatcher() } as any) : {}),
      });
    } catch {
      break; // replies are best-effort; never fail the parent harvest
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) throw new InstaRateLimitError("Rate limited fetching replies");
    if (res.status === 401 || res.status === 403) {
      throw new InstaAuthError(`Instagram rejected the session (HTTP ${res.status})`);
    }

    const text = await res.text();
    if (text.trimStart().startsWith("<")) break;

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      break;
    }

    const batch: any[] = json?.child_comments ?? json?.comments ?? [];
    let added = 0;
    for (const raw of batch) {
      const c = mapComment(raw, 1, parentCommentId);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      added += 1;
      if (out.length >= max) break;
    }

    const hasMore =
      Boolean(json?.has_more_head_child_comments) || Boolean(json?.has_more_tail_child_comments);
    const next = json?.next_max_id ?? json?.next_min_id ?? null;
    const nextCursor = next == null ? null : typeof next === "string" ? next : JSON.stringify(next);
    if (!hasMore || !nextCursor || nextCursor === cursor || added === 0) break;
    cursor = nextCursor;
    await sleep(delayMs);
  }

  return out;
}

export interface HarvestOptions {
  /** Stop after this many comments. Omit for everything Instagram will give. */
  max?: number;
  /** Include replies previewed inline on each comment. */
  includeReplies?: boolean;
  /** Override pacing between pages. */
  delayMs?: number;
  /** Called after each page — use for progress output. */
  onProgress?: (soFar: number, reportedTotal: number | null, page: number) => void;
  /** Abort cooperatively. */
  signal?: AbortSignal;
}

/**
 * Fetch a post's comments, paging until exhausted or `max` is reached.
 * Backs off exponentially on 429/rate-limit rather than giving up, since a
 * long harvest will normally hit at least one throttle.
 */
export async function fetchMediaComments(
  mediaId: string,
  sessionRaw: string,
  options: HarvestOptions = {},
): Promise<CommentHarvestResult> {
  const { max = Infinity, includeReplies = true, delayMs = BASE_DELAY_MS, onProgress, signal } = options;
  if (!sessionRaw) throw new InstaAuthError("A session is required to read comments");

  const headers = headersFor(sessionRaw);
  const comments: InstaComment[] = [];
  const seen = new Set<string>();

  let minId: string | null = null;
  let reportedTotal: number | null = null;
  /** Parents whose replies need a separate request; drained after paging. */
  const pendingReplyParents: string[] = [];
  let pagesFetched = 0;
  let requestCount = 0;
  let truncated = false;
  let backoff = delayMs;
  const startedAt = Date.now();

  while (comments.length < max) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }

    const url = new URL(`https://www.instagram.com/api/v1/media/${mediaId}/comments/`);
    url.searchParams.set("can_support_threading", "true");
    url.searchParams.set("permalink_enabled", "false");
    if (minId) url.searchParams.set("min_id", minId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
        cache: "no-store",
        // Route through the residential proxy when one is configured, matching
        // the rest of the Instagram stack.
        ...(igProxyDispatcher() ? ({ dispatcher: igProxyDispatcher() } as any) : {}),
      });
      requestCount += 1;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError" && signal?.aborted) {
        truncated = true;
        break;
      }
      // Network blip — back off and retry the same cursor.
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      if (backoff >= MAX_BACKOFF_MS) throw new Error(`Network failure fetching comments: ${err?.message}`);
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      if (backoff >= MAX_BACKOFF_MS) {
        throw new InstaRateLimitError("Instagram rate limit persisted past maximum backoff");
      }
      await sleep(backoff);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new InstaAuthError(`Instagram rejected the session (HTTP ${res.status})`);
    }

    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      // The desktop-UA failure mode; if it happens here the UA contract broke.
      throw new Error(
        "Instagram returned HTML instead of JSON — the comments endpoint contract changed (check the app User-Agent)",
      );
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Instagram returned malformed JSON for comments");
    }

    if (json?.require_login || json?.message === "login_required") {
      throw new InstaAuthError("Instagram requires login — the session is dead");
    }
    if (typeof json?.message === "string" && /wait|try again/i.test(json.message)) {
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      if (backoff >= MAX_BACKOFF_MS) throw new InstaRateLimitError(json.message);
      await sleep(backoff);
      continue;
    }

    pagesFetched += 1;
    backoff = delayMs; // healthy response — reset pacing
    if (reportedTotal == null && typeof json?.comment_count === "number") {
      reportedTotal = json.comment_count;
    }

    const batch: any[] = Array.isArray(json?.comments) ? json.comments : [];
    let added = 0;
    for (const raw of batch) {
      const c = mapComment(raw, 0, null);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      comments.push(c);
      added += 1;

      if (includeReplies) {
        // The inline preview is nearly always empty, so take it when present
        // and otherwise ask for the thread explicitly.
        const preview = Array.isArray(raw?.preview_child_comments) ? raw.preview_child_comments : [];
        for (const child of preview) {
          const reply = mapComment(child, 1, c.id);
          if (!reply || seen.has(reply.id)) continue;
          seen.add(reply.id);
          comments.push(reply);
        }
        if (c.replyCount > preview.length) {
          pendingReplyParents.push(c.id);
        }
      }
      if (comments.length >= max) break;
    }

    onProgress?.(comments.length, reportedTotal, pagesFetched);

    // Both flags matter and must be OR'd: Instagram commonly returns
    // has_more_comments=false alongside has_more_headload_comments=true, and a
    // `??` here would take the literal false and stop after one page.
    const hasMore = Boolean(json?.has_more_comments) || Boolean(json?.has_more_headload_comments);

    // `next_min_id` is an OBJECT — {cached_comments_cursor, bifilter_token} —
    // and must be passed back JSON-encoded, not coerced with toString().
    const rawCursor = json?.next_min_id ?? json?.next_max_id ?? null;
    const nextCursor =
      rawCursor == null
        ? null
        : typeof rawCursor === "string"
          ? rawCursor
          : JSON.stringify(rawCursor);

    if (comments.length >= max) {
      truncated = hasMore;
      break;
    }
    // No cursor movement, or nothing new, means the well is dry.
    if (!hasMore || !nextCursor || nextCursor === minId || added === 0) break;

    minId = nextCursor;
    await sleep(delayMs);
  }

  // Replies are fetched after paging, so the parent walk isn't interleaved with
  // per-comment round trips. One request per parent that actually has replies.
  if (includeReplies && pendingReplyParents.length && !signal?.aborted) {
    for (const parentId of pendingReplyParents) {
      if (signal?.aborted || comments.length >= max) break;
      try {
        const replies = await fetchChildComments(mediaId, parentId, sessionRaw, {
          max: Math.max(0, max - comments.length),
          delayMs: Math.min(delayMs, 400),
        });
        requestCount += 1;
        for (const reply of replies) {
          if (seen.has(reply.id)) continue;
          seen.add(reply.id);
          comments.push(reply);
        }
        onProgress?.(comments.length, reportedTotal, pagesFetched);
      } catch (err) {
        if (err instanceof InstaAuthError) throw err;
        // A single unreachable thread must not sink the whole post.
      }
      await sleep(Math.min(delayMs, 400));
    }
  }

  return {
    mediaId,
    comments,
    reportedTotal,
    pagesFetched,
    requestCount,
    truncated,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Shared adaptive pacing across concurrent workers.
 *
 * Measurement showed concurrency across different posts scales near-linearly
 * (5 workers ≈ 4.7x throughput), so the limiter is not a simple global
 * per-account cap. But a throttle, when it comes, applies to the ACCOUNT — so
 * one worker being slowed is a signal for every worker. The governor holds one
 * delay for the whole fleet: any throttle multiplies it, sustained clean
 * responses decay it back down.
 */
export class CommentRateGovernor {
  private delayMs: number;
  private cleanStreak = 0;
  throttleCount = 0;

  constructor(
    private readonly floorMs = 250,
    private readonly ceilingMs = 30_000,
    startMs = 400,
  ) {
    this.delayMs = startMs;
  }

  get current(): number {
    return this.delayMs;
  }

  /** Call after every successful page. */
  reportSuccess(): void {
    this.cleanStreak += 1;
    // Ease off only after a solid run, so we don't oscillate.
    if (this.cleanStreak >= 25 && this.delayMs > this.floorMs) {
      this.delayMs = Math.max(this.floorMs, Math.round(this.delayMs * 0.8));
      this.cleanStreak = 0;
    }
  }

  /** Call on 429 / "please wait" / HTML shell. */
  reportThrottle(): number {
    this.throttleCount += 1;
    this.cleanStreak = 0;
    this.delayMs = Math.min(this.ceilingMs, Math.max(this.floorMs, this.delayMs * 3));
    return this.delayMs;
  }

  async wait(): Promise<void> {
    await sleep(this.delayMs);
  }
}

export interface BulkHarvestProgress {
  mediaId: string;
  fetched: number;
  reportedTotal: number | null;
  done: boolean;
}

export interface BulkHarvestOptions {
  /** Parallel workers. Measured sweet spot is ~5; higher raises ban risk. */
  concurrency?: number;
  /** Per-post cap. */
  maxPerPost?: number;
  includeReplies?: boolean;
  governor?: CommentRateGovernor;
  onProgress?: (p: BulkHarvestProgress) => void;
  /** Persist one settled post before another one is claimed. This makes a
   * long harvest restart-safe instead of retaining every comment only in RAM
   * until the whole selection ends. */
  onResult?: (result: CommentHarvestResult & { error?: string }) => Promise<void> | void;
  signal?: AbortSignal;
}

/**
 * Harvest comments for many posts concurrently, sharing one rate governor.
 * Returns per-post results; a failed post yields its error rather than
 * aborting the whole run.
 */
export async function harvestManyPosts(
  mediaIds: string[],
  sessionRaw: string,
  options: BulkHarvestOptions = {},
): Promise<{
  results: (CommentHarvestResult & { error?: string })[];
  totalComments: number;
  throttleCount: number;
  elapsedMs: number;
}> {
  const {
    concurrency = 5,
    maxPerPost = Infinity,
    includeReplies = true,
    governor = new CommentRateGovernor(),
    onProgress,
    onResult,
    signal,
  } = options;

  const startedAt = Date.now();
  const queue = [...mediaIds];
  const results: (CommentHarvestResult & { error?: string })[] = [];

  const worker = async () => {
    for (;;) {
      const mediaId = queue.shift();
      if (!mediaId || signal?.aborted) return;
      try {
        const r = await fetchMediaComments(mediaId, sessionRaw, {
          max: maxPerPost,
          includeReplies,
          signal,
          // Pace from the shared governor so a throttle anywhere slows everyone.
          delayMs: governor.current,
          onProgress: (fetched, reportedTotal) => {
            governor.reportSuccess();
            onProgress?.({ mediaId, fetched, reportedTotal, done: false });
          },
        });
        results.push(r);
        await onResult?.(r);
        onProgress?.({ mediaId, fetched: r.comments.length, reportedTotal: r.reportedTotal, done: true });
      } catch (err: any) {
        if (err instanceof InstaRateLimitError) {
          const backoff = governor.reportThrottle();
          // Put it back and let a later pass retry at the slower rate.
          queue.push(mediaId);
          await sleep(backoff);
          continue;
        }
        if (err instanceof InstaAuthError) throw err;
        const failed = {
          mediaId,
          comments: [],
          reportedTotal: null,
          pagesFetched: 0,
          requestCount: 0,
          truncated: true,
          elapsedMs: 0,
          error: err?.message ?? "harvest failed",
        };
        results.push(failed);
        await onResult?.(failed);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return {
    results,
    totalComments: results.reduce((a, r) => a + r.comments.length, 0),
    throttleCount: governor.throttleCount,
    elapsedMs: Date.now() - startedAt,
  };
}
