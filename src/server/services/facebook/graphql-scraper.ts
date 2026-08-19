/**
 * Facebook comment scraping over the internal GraphQL endpoint.
 *
 * www.facebook.com talks to `/api/graphql/` with a Relay-style POST: a session
 * cookie, an `fb_dtsg` CSRF token harvested from any logged-in HTML page, and a
 * persisted-query `doc_id` identifying the query. Comments come back as clean
 * JSON with a cursor for the next page — far richer than DOM scraping and much
 * cheaper than driving Chromium.
 *
 * The catch: `doc_id` values are minted per Facebook deploy and rotate every few
 * weeks. They are therefore configurable via env, and every failure path falls
 * back to the browser scraper rather than hard-erroring. Approach informed by
 * the `facebook_post_comment_scraper` project.
 *
 * NOTE: against Meta ToS; use a throwaway account.
 */
import {
  assertUsableCookies,
  FbScrapeAuthError,
  FbScrapeRateLimitError,
  normalizeCookies,
  type FbScrapedComment,
} from "./scraper-types";
import { fbNavigationHeaders, fbXhrHeaders, isFacebookRejection } from "./headers";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Persisted-query ids. These rotate with Facebook deploys — override without a
 * redeploy via env when they go stale.
 */
const DOC_IDS = {
  comments: process.env.FB_GRAPHQL_COMMENTS_DOC_ID || "",
  replies: process.env.FB_GRAPHQL_REPLIES_DOC_ID || "",
};

export function graphqlConfigured(): boolean {
  return Boolean(DOC_IDS.comments);
}

/** Session material needed for any authenticated GraphQL call. */
export interface FbGraphqlSession {
  cookie: string;
  fbDtsg: string;
  userId: string;
  /** Revision of the JS bundle; Facebook rejects wildly stale values. */
  rev: string | null;
  lsd: string | null;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (err: any) {
    throw new Error(
      err?.name === "AbortError" ? "Facebook GraphQL request timed out" : `Network error: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Harvest `fb_dtsg` (and friends) by loading a logged-in HTML page. The token is
 * embedded in the bootstrap JSON under a couple of different shapes depending on
 * which bundle Facebook serves, so several patterns are tried.
 */
export async function establishGraphqlSession(cookiesRaw: string): Promise<FbGraphqlSession> {
  const { cookie, cUser } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);
  if (!cUser) throw new FbScrapeAuthError("Could not read c_user from the cookie bundle");

  const res = await timedFetch("https://www.facebook.com/", {
    headers: fbNavigationHeaders(cookie),
    redirect: "follow",
  });

  if (/\/login|\/checkpoint/i.test(res.url)) {
    throw new FbScrapeAuthError("Facebook redirected to login/checkpoint — session invalid or flagged");
  }
  const html = await res.text();

  // A bare 400 + tiny error page means Facebook refused the REQUEST, not the
  // session. Reporting that as "session dead" sent us chasing valid cookies for
  // days, so it now gets its own message.
  if (isFacebookRejection(res.status, html)) {
    throw new Error(
      "Facebook refused the request (HTTP 400) before checking the session — this is a request-shape " +
        "problem, not bad cookies. Ensure Sec-Fetch-*/sec-ch-ua headers are being sent.",
    );
  }

  const fbDtsg =
    /"DTSGInitialData",\s*\[\],\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /name="fb_dtsg"\s+value="([^"]+)"/.exec(html)?.[1] ??
    null;

  if (!fbDtsg) {
    throw new FbScrapeAuthError(
      "Could not harvest an fb_dtsg token — the session is probably logged out or checkpointed",
    );
  }

  return {
    cookie,
    fbDtsg,
    userId: cUser,
    rev: /"client_revision"\s*:\s*(\d+)/.exec(html)?.[1] ?? /"__spin_r"\s*:\s*(\d+)/.exec(html)?.[1] ?? null,
    lsd: /"LSD",\s*\[\],\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? null,
  };
}

/** POST a persisted query and return the parsed `data` payload. */
async function graphqlCall(
  session: FbGraphqlSession,
  friendlyName: string,
  docId: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const form = new URLSearchParams({
    av: session.userId,
    __user: session.userId,
    __a: "1",
    __comet_req: "15",
    fb_dtsg: session.fbDtsg,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: friendlyName,
    server_timestamps: "true",
    doc_id: docId,
    variables: JSON.stringify(variables),
  });
  if (session.rev) form.set("__rev", session.rev);
  if (session.lsd) form.set("lsd", session.lsd);

  const res = await timedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: fbXhrHeaders(session.cookie, {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-Friendly-Name": friendlyName,
      "X-FB-LSD": session.lsd ?? "",
    }),
    body: form.toString(),
  });

  if (res.status === 429) throw new FbScrapeRateLimitError("Facebook rate-limited the GraphQL endpoint");
  const raw = await res.text();

  // Facebook may stream several JSON objects, one per line; the first carries data.
  const firstLine = raw.replace(/^for\s*\(;;\);/, "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!firstLine) throw new Error("GraphQL returned an unreadable response");

  let json: any;
  try {
    json = JSON.parse(firstLine);
  } catch {
    throw new Error("GraphQL returned malformed JSON");
  }

  if (json?.errors?.length) {
    const message = json.errors[0]?.message ?? "GraphQL error";
    if (/login|session|authoriz/i.test(message)) throw new FbScrapeAuthError(message);
    throw new Error(message);
  }
  if (json?.error === 1357001 || /Not logged in/i.test(json?.errorSummary ?? "")) {
    throw new FbScrapeAuthError("Facebook says this session is not logged in");
  }
  return json?.data ?? null;
}

/**
 * Facebook nests comment connections under a few different keys depending on
 * the surface. Rather than hard-coding one path, walk the payload for the first
 * object that looks like a comment connection.
 */
function findCommentConnection(node: any): any | null {
  const queue: any[] = [node];
  let steps = 0;
  while (queue.length && steps < 4000) {
    const current = queue.shift();
    steps += 1;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current.edges) && current.edges.some((e: any) => e?.node?.body || e?.node?.legacy_fbid)) {
      return current;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

function mapComment(node: any, depth: number): FbScrapedComment | null {
  if (!node) return null;
  const author = node.author ?? node.comment_parent?.author ?? {};
  const text = node.body?.text ?? node.preferred_body?.text ?? "";
  const commentId = String(node.legacy_fbid ?? node.id ?? "");
  if (!commentId && !text) return null;

  const attachment =
    node.attachments?.[0]?.media?.image?.uri ??
    node.attachments?.[0]?.style_type_renderer?.attachment?.media?.image?.uri ??
    null;

  const createdSeconds = Number(node.created_time);

  return {
    commentId,
    commentUrl: node.url ?? node.feedback?.url ?? null,
    commenterId: author.id ? String(author.id) : null,
    commenterName: author.name ?? "",
    commenterUrl: author.url ?? (author.id ? `https://www.facebook.com/${author.id}` : null),
    commenterMeta: node.author_badge_renderers?.[0]?.badge_text ?? null,
    commentText: text,
    commentTime: Number.isFinite(createdSeconds) && createdSeconds > 0 ? new Date(createdSeconds * 1000).toISOString() : null,
    commentImage: attachment,
    commentReactionCount:
      Number(node.feedback?.reactors?.count_reduced ?? node.feedback?.reactors?.count ?? 0) || 0,
    replies: [],
    depth,
    source: "graphql",
  };
}

export interface GraphqlCommentsOptions {
  limit?: number;
  withReplies?: boolean;
  maxRepliesPerComment?: number;
  /** RANKED_UNFILTERED (all) | RANKED_THREADED (top) | RECENT_ACTIVITY */
  ordering?: "RANKED_UNFILTERED" | "RANKED_THREADED" | "RECENT_ACTIVITY";
}

/**
 * Page through a post's comments. `postNodeId` is the post's GraphQL node id or
 * numeric post id. Returns as many comments as the limit allows.
 */
export async function scrapeCommentsViaGraphql(
  postNodeId: string,
  cookiesRaw: string,
  options: GraphqlCommentsOptions = {},
): Promise<FbScrapedComment[]> {
  const { limit = 50, withReplies = false, maxRepliesPerComment = 10, ordering = "RANKED_UNFILTERED" } = options;
  if (!DOC_IDS.comments) {
    throw new Error(
      "GraphQL comment scraping needs FB_GRAPHQL_COMMENTS_DOC_ID — set it, or use the browser method.",
    );
  }

  const session = await establishGraphqlSession(cookiesRaw);
  const collected: FbScrapedComment[] = [];
  const seen = new Set<string>();

  let cursor: string | null = null;
  let guard = 0;

  while (collected.length < limit && guard < 20) {
    guard += 1;
    const batch = Math.min(50, limit - collected.length);
    const data = await graphqlCall(session, "CommentsListComponentsPaginationQuery", DOC_IDS.comments, {
      commentsAfterCount: -1,
      commentsAfterCursor: cursor,
      commentsBeforeCount: null,
      commentsBeforeCursor: null,
      commentsIntentToken: ordering,
      feedLocation: "PERMALINK",
      focusCommentID: null,
      scale: 1,
      useDefaultActor: false,
      id: postNodeId,
      first: batch,
    });

    const connection = findCommentConnection(data);
    const edges: any[] = connection?.edges ?? [];
    if (!edges.length) break;

    for (const edge of edges) {
      if (collected.length >= limit) break;
      const comment = mapComment(edge?.node, 0);
      if (!comment) continue;
      const key = comment.commentId || `${comment.commenterName}:${comment.commentText.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (withReplies && DOC_IDS.replies && edge.node?.feedback?.expansion_info?.expansion_token) {
        try {
          const replyData = await graphqlCall(session, "Depth1CommentsListPaginationQuery", DOC_IDS.replies, {
            clientKey: null,
            expansionToken: edge.node.feedback.expansion_info.expansion_token,
            repliesAfterCount: -1,
            repliesAfterCursor: null,
            repliesBeforeCount: null,
            repliesBeforeCursor: null,
            scale: 1,
            id: edge.node.id,
            first: maxRepliesPerComment,
          });
          const replyConnection = findCommentConnection(replyData);
          comment.replies = (replyConnection?.edges ?? [])
            .map((e: any) => mapComment(e?.node, 1))
            .filter((c: FbScrapedComment | null): c is FbScrapedComment => !!c)
            .slice(0, maxRepliesPerComment);
        } catch {
          /* replies are best-effort */
        }
      }

      collected.push(comment);
    }

    const pageInfo = connection?.page_info;
    if (!pageInfo?.has_next_page || !pageInfo?.end_cursor) break;
    cursor = pageInfo.end_cursor;
  }

  return collected;
}
