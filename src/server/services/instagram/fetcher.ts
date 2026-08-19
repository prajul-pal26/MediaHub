/**
 * Instagram public-profile fetcher.
 *
 * Reimplements (in TypeScript) the anonymous profile-fetch method used by
 * InstaGPy — hits Instagram's `web_profile_info` endpoint with a mobile
 * user-agent + the public web app id. Optionally accepts a `sessionid`
 * cookie (from a logged-in Instagram account) to reach data that anonymous
 * requests can't (e.g. some rate-limited / restricted responses).
 *
 * NOTE: This scrapes Instagram's private web API. It works today but is
 * against Instagram's ToS, is rate-limited, and can break at any time.
 * Use a throwaway account's session id — never a personal one.
 */

const IG_APP_ID = "936619743392459";
const MOBILE_UA =
  "Instagram 12.0.0.16.90 (iPhone9,4; iOS 10_3_3; en_US; en-US; scale=2.61; gamut=wide; 1080x1920) AppleWebKit/420+";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PROFILE_ENDPOINT =
  "https://www.instagram.com/api/v1/users/web_profile_info/?username=";
const LOGIN_PAGE = "https://www.instagram.com/accounts/login/";
const LOGIN_ENDPOINT = "https://www.instagram.com/accounts/login/ajax/";

export interface InstaLoginResult {
  ok: boolean;
  sessionId?: string;
  username?: string;
  /** machine-readable status for the UI: success | bad_password | user_not_found | two_factor | checkpoint | rate_limited | error */
  status:
    | "success"
    | "bad_password"
    | "user_not_found"
    | "two_factor"
    | "checkpoint"
    | "rate_limited"
    | "error";
  message: string;
}

function readSetCookie(res: Response, name: string): string | null {
  // Node 18+/undici exposes getSetCookie(); fall back to the combined header.
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const cookies: string[] =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  for (const c of cookies) {
    const m = new RegExp(`${name}=([^;]+)`).exec(c);
    if (m) return m[1];
  }
  return null;
}

/**
 * Log into Instagram with username + password and return a fresh sessionid.
 * Replicates InstaGPy's web login (enc_password + csrftoken). Instagram often
 * blocks logins from datacenter IPs or requires 2FA/checkpoint — those are
 * surfaced via `status` so the UI can explain. Use a THROWAWAY account.
 */
export async function loginInstagram(
  usernameRaw: string,
  password: string,
): Promise<InstaLoginResult> {
  const username = usernameRaw.trim().replace(/^@/, "");
  if (!username || !password) {
    return { ok: false, status: "error", message: "Username and password are required" };
  }

  // 1. Hit the login page to obtain a csrftoken cookie.
  let csrf: string | null = null;
  try {
    const pre = await fetch(LOGIN_PAGE, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "*/*" },
      cache: "no-store",
    });
    csrf = readSetCookie(pre, "csrftoken");
  } catch (err: any) {
    return { ok: false, status: "error", message: `Could not reach Instagram: ${err?.message}` };
  }
  if (!csrf) csrf = "missing"; // Instagram still accepts the POST; token is echoed back

  // 2. Build the enc_password (0 = plaintext transport marker used by the web client).
  const time = Math.floor(Date.now() / 1000);
  const encPassword = `#PWD_INSTAGRAM_BROWSER:0:${time}:${password}`;

  // 3. Submit the login.
  let res: Response;
  try {
    res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": DESKTOP_UA,
        "x-csrftoken": csrf,
        "x-ig-app-id": IG_APP_ID,
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/x-www-form-urlencoded",
        Referer: LOGIN_PAGE,
        Cookie: `csrftoken=${csrf}`,
      },
      body: new URLSearchParams({
        username,
        enc_password: encPassword,
        queryParams: "{}",
        optIntoOneTap: "false",
      }).toString(),
      cache: "no-store",
    });
  } catch (err: any) {
    return { ok: false, status: "error", message: `Login request failed: ${err?.message}` };
  }

  if (res.status === 429) {
    return { ok: false, status: "rate_limited", message: "Instagram rate-limited the login (429). Wait and retry." };
  }

  const json: any = await res.json().catch(() => null);
  if (!json) {
    return {
      ok: false,
      status: res.status === 403 ? "rate_limited" : "error",
      message: `Instagram returned HTTP ${res.status} (often means the IP is blocked for login).`,
    };
  }

  if (json.authenticated === true) {
    const sessionId = readSetCookie(res, "sessionid");
    if (!sessionId) {
      return { ok: false, status: "error", message: "Logged in but no session cookie was returned." };
    }
    return { ok: true, sessionId, username, status: "success", message: "Logged in successfully" };
  }
  if (json.two_factor_required) {
    return { ok: false, status: "two_factor", message: "This account has 2FA enabled — not supported here. Use an account without 2FA or paste a session id." };
  }
  if (json.message === "checkpoint_required" || json.checkpoint_url) {
    return { ok: false, status: "checkpoint", message: "Instagram flagged this login (checkpoint). Approve it in the app, then retry." };
  }
  if (json.user === false) {
    return { ok: false, status: "user_not_found", message: `User "@${username}" not found.` };
  }
  if (json.authenticated === false) {
    return { ok: false, status: "bad_password", message: "Incorrect password." };
  }
  return { ok: false, status: "error", message: json.message ? String(json.message) : "Login failed." };
}

export interface InstaPost {
  shortcode: string;
  url: string;
  thumbnail: string | null;
  videoUrl: string | null;
  isVideo: boolean;
  likes: number;
  comments: number;
  caption: string;
  takenAt: number | null;
}

export interface InstaProfile {
  id: string;
  username: string;
  fullName: string;
  bio: string;
  profilePic: string | null;
  externalUrl: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  isBusiness: boolean;
  category: string | null;
  followers: number;
  following: number;
  postsCount: number;
  /** approx engagement rate over the returned recent posts (%) — null if not computable */
  engagementRate: number | null;
  recentPosts: InstaPost[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parsePosts(user: any): InstaPost[] {
  const edges = user?.edge_owner_to_timeline_media?.edges;
  if (!Array.isArray(edges)) return [];
  return edges.map((e: any) => {
    const n = e?.node ?? {};
    const likes = num(n?.edge_liked_by?.count ?? n?.edge_media_preview_like?.count);
    const comments = num(n?.edge_media_to_comment?.count);
    const caption =
      n?.edge_media_to_caption?.edges?.[0]?.node?.text ?? "";
    return {
      shortcode: n?.shortcode ?? "",
      url: n?.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : "",
      thumbnail: n?.thumbnail_src ?? n?.display_url ?? null,
      videoUrl: n?.is_video ? (n?.video_url ?? null) : null,
      isVideo: Boolean(n?.is_video),
      likes,
      comments,
      caption,
      takenAt: typeof n?.taken_at_timestamp === "number" ? n.taken_at_timestamp : null,
    };
  });
}

export interface InstaFriend {
  id: string;
  username: string;
  fullName: string;
  isPrivate: boolean;
  isVerified: boolean;
  profilePic: string | null;
}

export interface InstaFriendsResult {
  users: InstaFriend[];
  total: number;
  truncated: boolean;
}

export class InstaAuthError extends Error {}
/** Transient (rate limit / checkpoint) — the session is NOT dead, just back off. */
export class InstaRateLimitError extends Error {}

/**
 * Normalize whatever the user saved (a bare `sessionid` value OR a full cookie
 * string copied from the browser) into a complete, legitimate-looking cookie
 * header + csrftoken. Sending sessionid together with csrftoken + ds_user_id is
 * what real browser/app requests do — sending sessionid alone is a strong
 * bot signal that gets the session killed quickly.
 */
export function normalizeSession(raw: string): { cookie: string; csrftoken: string | null } {
  const s = raw.trim();
  const looksLikeCookieString = /(^|;\s*)[a-zA-Z_]+=/.test(s) && s.includes("=");

  if (looksLikeCookieString) {
    let cookie = s.replace(/\s*;\s*/g, "; ").trim();
    const csrf = /csrftoken=([^;]+)/.exec(cookie)?.[1] ?? null;
    if (!/(^|;\s*)ds_user_id=/.test(cookie)) {
      const sess = /sessionid=([^;]+)/.exec(cookie)?.[1];
      if (sess) {
        const uid = decodeURIComponent(sess).split(":")[0];
        if (uid && /^\d+$/.test(uid)) cookie += `; ds_user_id=${uid}`;
      }
    }
    return { cookie, csrftoken: csrf };
  }

  // Bare sessionid value — derive ds_user_id from its first segment.
  const uid = decodeURIComponent(s).split(":")[0];
  let cookie = `sessionid=${s}`;
  if (uid && /^\d+$/.test(uid)) cookie += `; ds_user_id=${uid}`;
  return { cookie, csrftoken: null };
}

/**
 * Build headers that mimic a real Instagram web XHR for private API calls.
 * The Sec-Fetch-* headers are REQUIRED: Node's fetch otherwise triggers a
 * "SecFetch Policy violation" (HTTP 400) on i.instagram.com endpoints.
 */
function igApiHeaders(session: { cookie: string; csrftoken: string | null }): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": DESKTOP_UA,
    "x-ig-app-id": IG_APP_ID,
    "x-requested-with": "XMLHttpRequest",
    "x-ig-www-claim": "0",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Referer: "https://www.instagram.com/",
    Cookie: session.cookie,
  };
  if (session.csrftoken) h["x-csrftoken"] = session.csrftoken;
  return h;
}

/** Randomized human-like delay (ms) to avoid velocity-based blocking. */
function jitter(baseMin: number, baseMax: number): number {
  return Math.floor(baseMin + Math.random() * (baseMax - baseMin));
}

/**
 * Optional rotating proxy (e.g. Webshare) for Instagram requests. When set, each
 * request can come from a different IP, so IG can't accumulate a per-IP rate
 * limit — the single biggest lever for pulling large follower lists. Configured
 * via the INSTA_PROXY env var (http://user:pass@host:port).
 */
let _proxyResolved = false;
let _proxyDispatcher: any = null;
export function igProxyDispatcher(): any {
  if (_proxyResolved) return _proxyDispatcher;
  _proxyResolved = true;
  // ONLY a dedicated INSTA_PROXY is used — and it must be a RESIDENTIAL/mobile
  // proxy. Datacenter proxies (e.g. the e-court one) are hard-blocked by
  // Instagram (instant 429), so we never route IG through them.
  const raw = (process.env.INSTA_PROXY || "").trim().replace(/\/+$/, "");
  if (raw) {
    try {
      // Resolve undici at runtime (hidden from the bundler's static analysis so
      // it isn't bundled). undici powers fetch and provides ProxyAgent.
      // eslint-disable-next-line no-eval
      const nodeRequire = eval("require") as NodeRequire;
      const { ProxyAgent } = nodeRequire("undici");
      _proxyDispatcher = new ProxyAgent(raw);
    } catch {
      _proxyDispatcher = null;
    }
  }
  return _proxyDispatcher;
}

/**
 * Fetch a user's followers or following list (IDs + usernames).
 * Requires a valid sessionid. Paginates up to `maxCount` (hard-capped to avoid
 * bans). Throws InstaAuthError when the session is invalid/expired so the caller
 * can mark it dead. Rotates across sessions + (optionally) a rotating proxy.
 */
export async function fetchUserFriends(
  userId: string,
  type: "followers" | "following",
  sessionRaw: string | string[],
  maxCount = 200,
  onDead?: (session: string) => void,
): Promise<InstaFriendsResult> {
  // Uses Instagram's GraphQL endpoint (the one the web app actually uses to load
  // the followers modal). It returns a real pagination cursor (end_cursor),
  // unlike api/v1/friendships which truncates a big account's followers to ~45
  // with NO cursor. On throttle/logout we rotate to another session & resume.
  const rawList = (Array.isArray(sessionRaw) ? sessionRaw : [sessionRaw]).filter(Boolean);
  if (!rawList.length)
    throw new InstaAuthError("A valid session is required to read followers/following");
  const norm = rawList.map((r) => normalizeSession(r));
  const dead = new Set<number>(); // sessions IG logged out
  let sIdx = 0;
  const nextLive = (): number => {
    for (let k = 1; k <= norm.length; k++) {
      const i = (sIdx + k) % norm.length;
      if (!dead.has(i)) return i;
    }
    return -1;
  };

  // GraphQL query hashes + edge keys for followers vs following.
  const QUERY_HASH =
    type === "followers"
      ? "c76146de99bb02f6415203be841dd25a"
      : "d04b0a864b4b54837c0d870b0e77e076";
  const EDGE = type === "followers" ? "edge_followed_by" : "edge_follow";

  const cap = Math.min(Math.max(maxCount, 1), 5000);
  const users: InstaFriend[] = [];
  let after: string | null = null; // GraphQL end_cursor
  let truncated = false;
  let requests = 0;
  let throttleStreak = 0; // consecutive throttles across sessions → all blocked
  let pagesOnSession = 0; // pages the CURRENT session has pulled (drives pacing)

  // Rotate to another live session and retry the SAME cursor. Returns false when
  // no other session is available (all throttled/dead this round).
  const rotate = async (): Promise<boolean> => {
    if (norm.length < 2 || throttleStreak >= norm.length) return false;
    const n = nextLive();
    if (n === -1 || n === sIdx) return false;
    sIdx = n;
    throttleStreak++;
    pagesOnSession = 0; // fresh session — start gentle again
    await new Promise((r) => setTimeout(r, jitter(5000, 10000)));
    return true;
  };

  const dispatcher = igProxyDispatcher();
  while (users.length < cap && requests < 200) {
    requests++;
    const headers = { ...igApiHeaders(norm[sIdx]), Referer: "https://www.instagram.com/" };
    const vars = JSON.stringify({
      id: userId,
      include_reel: false,
      fetch_mutual: false,
      first: 50,
      ...(after ? { after } : {}),
    });
    const url =
      `https://www.instagram.com/graphql/query/?query_hash=${QUERY_HASH}` +
      `&variables=${encodeURIComponent(vars)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers,
        signal: controller.signal,
        cache: "no-store",
        ...(dispatcher ? { dispatcher } : {}),
      } as any);
    } finally {
      clearTimeout(timeout);
    }

    // 429 / 403 = rate limited → rotate to a fresh session and resume.
    if (res.status === 429 || res.status === 403) {
      if (await rotate()) continue;
      truncated = users.length > 0 || Boolean(after);
      if (users.length === 0)
        throw new InstaRateLimitError("Rate limited by Instagram — wait a while before retrying");
      break;
    }

    // Logged out / redirected to login → mark dead, switch session, resume.
    if (res.status === 401 || res.status === 302) {
      dead.add(sIdx);
      onDead?.(rawList[sIdx]);
      const n = nextLive();
      if (n !== -1) {
        sIdx = n;
        continue;
      }
      if (users.length === 0) throw new InstaAuthError("Session logged out");
      truncated = true;
      break;
    }
    if (!res.ok) {
      if (await rotate()) continue;
      break;
    }

    const json: any = await res.json().catch(() => null);
    const edge = json?.data?.user?.[EDGE];

    if (!edge) {
      // No edge → login required, rate-limited, or restricted.
      const msg = String(json?.message ?? "").toLowerCase();
      if (msg.includes("login") || json?.require_login) {
        dead.add(sIdx);
        onDead?.(rawList[sIdx]);
        const n = nextLive();
        if (n !== -1) {
          sIdx = n;
          continue;
        }
        if (users.length === 0) throw new InstaAuthError("Session invalidated by Instagram");
        truncated = true;
        break;
      }
      if (await rotate()) continue;
      if (users.length === 0)
        throw new InstaRateLimitError("Instagram returned no data — retry later");
      truncated = true;
      break;
    }

    const edges: any[] = Array.isArray(edge.edges) ? edge.edges : [];
    for (const e of edges) {
      const u = e?.node ?? {};
      users.push({
        id: String(u?.id ?? u?.pk ?? ""),
        username: u?.username ?? "",
        fullName: u?.full_name ?? "",
        isPrivate: Boolean(u?.is_private),
        isVerified: Boolean(u?.is_verified),
        profilePic: u?.profile_pic_url ?? null,
      });
    }
    throttleStreak = 0; // a good page resets the "all blocked" guard
    pagesOnSession++;

    // Spread the per-account rate limit: hand the NEXT page to a different live
    // session (round-robin). The follower cursor is account-based, not session-
    // based, so any session can continue the chain. More sessions → more total
    // pages/hour before Instagram throttles (≈ N× the sustained throughput).
    const liveCount = norm.length - dead.size;
    if (liveCount > 1) {
      const n = nextLive();
      if (n !== -1) {
        sIdx = n;
        pagesOnSession = 0; // this session is "fresh" again → keep pacing brisk
      }
    }

    const pageInfo = edge.page_info;
    after = pageInfo?.has_next_page && pageInfo?.end_cursor ? String(pageInfo.end_cursor) : null;
    if (users.length >= cap) {
      truncated = Boolean(after);
      break;
    }
    if (!after) break;

    // Light pacing — the GraphQL endpoint tolerates a brisk pace (proven: 200
    // pulled in 10s with no throttle). Stay quick, ramp only gently, and rest
    // briefly every ~30 pages so very large pulls don't trip a velocity block.
    if (pagesOnSession > 0 && pagesOnSession % 30 === 0) {
      await new Promise((r) => setTimeout(r, jitter(6000, 10000)));
    } else {
      const lo = Math.min(900 + pagesOnSession * 40, 2400);
      const hi = Math.min(1700 + pagesOnSession * 70, 3400);
      await new Promise((r) => setTimeout(r, jitter(lo, hi)));
    }
  }
  if (users.length >= cap && after) truncated = true;

  return { users: users.slice(0, cap), total: users.length, truncated };
}

// ─── Full content feed (posts, reels, carousels) with download URLs ───

export interface InstaCarouselChild {
  displayUrl: string | null;
  videoUrl: string | null;
  isVideo: boolean;
}

export interface InstaMediaItem {
  id: string;
  shortcode: string;
  url: string;
  kind: "post" | "video" | "reel" | "carousel";
  displayUrl: string | null;
  videoUrl: string | null;
  likes: number;
  comments: number;
  views: number | null;
  caption: string;
  takenAt: number | null;
  carousel: InstaCarouselChild[];
  /** Posting account, when the payload carries it (hashtag search does). */
  ownerUsername?: string | null;
}

export interface InstaFeedResult {
  items: InstaMediaItem[];
  truncated: boolean;
}

function bestImage(node: any): string | null {
  const c = node?.image_versions2?.candidates;
  return Array.isArray(c) && c.length ? c[0].url : null;
}
function bestVideo(node: any): string | null {
  const v = node?.video_versions;
  return Array.isArray(v) && v.length ? v[0].url : null;
}

/**
 * Fetch a user's full content feed — posts, reels, IGTV, carousels — with
 * download URLs and stats. Requires a valid session. Paginated + capped.
 */
export async function fetchUserFeed(
  userId: string,
  sessionRaw: string,
  maxCount = 24,
): Promise<InstaFeedResult> {
  if (!sessionRaw) throw new InstaAuthError("A valid session is required to read the content feed");
  const session = normalizeSession(sessionRaw);
  const headers = igApiHeaders(session);
  const cap = Math.min(Math.max(maxCount, 1), 200);
  const items: InstaMediaItem[] = [];
  let maxId: string | null = null;
  let truncated = false;

  for (let page = 0; page < 20; page++) {
    const url =
      `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/` +
      `?count=24${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429 || res.status === 403) {
      truncated = items.length > 0;
      if (items.length === 0) throw new InstaRateLimitError("Rate limited by Instagram — retry later");
      break;
    }
    const json: any = await res.json().catch(() => null);
    const msg = String(json?.message ?? "").toLowerCase();
    if (msg.includes("wait") || msg.includes("try again")) {
      if (items.length === 0) throw new InstaRateLimitError("Instagram asked to wait — retry later");
      truncated = true;
      break;
    }
    if (res.status === 401 && json?.require_login) throw new InstaAuthError("Session logged out");
    if (res.status === 401) throw new InstaRateLimitError("Temporary block — retry later");
    if (!res.ok) break;

    const batch: any[] = Array.isArray(json?.items) ? json.items : [];
    for (const it of batch) {
      const mt = it?.media_type;
      const isReel = it?.product_type === "clips";
      const kind: InstaMediaItem["kind"] =
        mt === 8 ? "carousel" : isReel ? "reel" : mt === 2 ? "video" : "post";
      const carousel: InstaCarouselChild[] = Array.isArray(it?.carousel_media)
        ? it.carousel_media.map((c: any) => ({
            displayUrl: bestImage(c),
            videoUrl: bestVideo(c),
            isVideo: c?.media_type === 2,
          }))
        : [];
      items.push({
        id: String(it?.pk ?? it?.id ?? ""),
        shortcode: it?.code ?? "",
        url: it?.code
          ? `https://www.instagram.com/${isReel ? "reel" : "p"}/${it.code}/`
          : "",
        kind,
        displayUrl: bestImage(it) ?? carousel[0]?.displayUrl ?? null,
        videoUrl: bestVideo(it),
        likes: typeof it?.like_count === "number" ? it.like_count : 0,
        comments: typeof it?.comment_count === "number" ? it.comment_count : 0,
        views:
          typeof it?.play_count === "number"
            ? it.play_count
            : typeof it?.view_count === "number"
              ? it.view_count
              : typeof it?.ig_play_count === "number"
                ? it.ig_play_count
                : null,
        caption: it?.caption?.text ?? "",
        takenAt: typeof it?.taken_at === "number" ? it.taken_at : null,
        carousel,
      });
    }

    maxId = json?.next_max_id ? String(json.next_max_id) : null;
    if (items.length >= cap) {
      truncated = Boolean(maxId);
      break;
    }
    if (!maxId || !json?.more_available) break;
    await new Promise((r) => setTimeout(r, jitter(1200, 2500)));
  }

  return { items: items.slice(0, cap), truncated };
}

export interface InstaHashtagResult {
  tag: string;
  mediaCount: number | null;
  items: InstaMediaItem[];
  truncated: boolean;
}

/**
 * Fetch the TOP + RECENT media for a hashtag (trending discovery). Each item
 * carries views/likes/comments so the caller can rank by "most viral". Requires
 * a session.
 */
export async function fetchHashtagMedia(
  tagRaw: string,
  sessionRaw: string,
  maxCount = 40,
): Promise<InstaHashtagResult> {
  const tag = tagRaw.trim().replace(/^#/, "").toLowerCase();
  if (!tag) throw new Error("Empty hashtag");
  if (!sessionRaw) throw new InstaAuthError("A session is required for hashtag search");
  const session = normalizeSession(sessionRaw);
  const headers = igApiHeaders(session);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(
      `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`,
      { headers, signal: controller.signal, cache: "no-store" },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 429 || res.status === 403)
    throw new InstaRateLimitError("Rate limited by Instagram — retry later");
  const json: any = await res.json().catch(() => null);
  const msg = String(json?.message ?? "").toLowerCase();
  if (msg.includes("wait") || msg.includes("try again"))
    throw new InstaRateLimitError("Instagram asked to wait — retry later");
  if (res.status === 401 || json?.require_login || json?.message === "login_required")
    throw new InstaAuthError("Session invalid/expired");
  if (!res.ok || !json?.data) throw new Error(`Instagram returned HTTP ${res.status} for #${tag}`);

  const d = json.data;
  const nodes: any[] = [];
  for (const bucket of [d.top, d.recent]) {
    const sections = bucket?.sections;
    if (!Array.isArray(sections)) continue;
    for (const sec of sections) {
      const medias = sec?.layout_content?.medias;
      if (Array.isArray(medias)) for (const it of medias) if (it?.media) nodes.push(it.media);
    }
  }

  const seen = new Set<string>();
  const items: InstaMediaItem[] = [];
  for (const it of nodes) {
    const id = String(it?.pk ?? it?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const mt = it?.media_type;
    const isReel = it?.product_type === "clips";
    const kind: InstaMediaItem["kind"] =
      mt === 8 ? "carousel" : isReel ? "reel" : mt === 2 ? "video" : "post";
    const carousel: InstaCarouselChild[] = Array.isArray(it?.carousel_media)
      ? it.carousel_media.map((c: any) => ({
          displayUrl: bestImage(c),
          videoUrl: bestVideo(c),
          isVideo: c?.media_type === 2,
        }))
      : [];
    items.push({
      id,
      shortcode: it?.code ?? "",
      url: it?.code ? `https://www.instagram.com/${isReel ? "reel" : "p"}/${it.code}/` : "",
      kind,
      displayUrl: bestImage(it) ?? carousel[0]?.displayUrl ?? null,
      videoUrl: bestVideo(it),
      likes: typeof it?.like_count === "number" ? it.like_count : 0,
      comments: typeof it?.comment_count === "number" ? it.comment_count : 0,
      views:
        typeof it?.play_count === "number"
          ? it.play_count
          : typeof it?.view_count === "number"
            ? it.view_count
            : typeof it?.ig_play_count === "number"
              ? it.ig_play_count
              : null,
      caption: it?.caption?.text ?? "",
      takenAt: typeof it?.taken_at === "number" ? it.taken_at : null,
      carousel,
      ownerUsername: it?.user?.username ?? it?.owner?.username ?? null,
    });
    if (items.length >= maxCount) break;
  }

  return {
    tag,
    mediaCount: typeof d.media_count === "number" ? d.media_count : null,
    items,
    truncated: nodes.length > items.length,
  };
}

export async function fetchInstagramProfile(
  usernameRaw: string,
  sessionId?: string,
): Promise<InstaProfile> {
  const username = usernameRaw.trim().replace(/^@/, "").toLowerCase();
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    throw new Error(`Invalid Instagram username: "${usernameRaw}"`);
  }

  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    "x-ig-app-id": IG_APP_ID,
    "x-requested-with": "XMLHttpRequest",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Referer: "https://www.instagram.com/",
  };
  if (sessionId && sessionId.trim()) {
    const session = normalizeSession(sessionId);
    headers["Cookie"] = session.cookie;
    if (session.csrftoken) headers["x-csrftoken"] = session.csrftoken;
  }

  const doFetch = async (useAuth: boolean): Promise<Response> => {
    const hdrs: Record<string, string> = { ...headers };
    if (!useAuth) {
      delete hdrs["Cookie"];
      delete hdrs["x-csrftoken"];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      return await fetch(PROFILE_ENDPOINT + encodeURIComponent(username), {
        headers: hdrs,
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const hasAuth = Boolean(headers["Cookie"]);
  let res: Response;
  try {
    res = await doFetch(hasAuth);
    // A bad/expired session must not block public profile data — retry anonymously.
    if ((res.status === 401 || res.status === 403) && hasAuth) {
      res = await doFetch(false);
    }
  } catch (err: any) {
    throw new Error(
      err?.name === "AbortError"
        ? "Instagram request timed out"
        : `Network error contacting Instagram: ${err?.message ?? err}`,
    );
  }

  if (res.status === 404) throw new Error(`User "@${username}" not found`);
  if (res.status === 429)
    throw new Error("Rate limited by Instagram — wait a few minutes and try again");
  if (res.status === 401 || res.status === 403)
    throw new Error("Instagram rate-limited this lookup — wait a few minutes and try again");
  if (!res.ok) throw new Error(`Instagram returned HTTP ${res.status}`);

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error("Instagram returned a non-JSON response (likely a login wall)");
  }

  const user = json?.data?.user;
  if (!user) throw new Error(`No profile data returned for "@${username}"`);

  const recentPosts = parsePosts(user);
  const followers = num(user?.edge_followed_by?.count);

  // approximate engagement rate = avg(likes+comments) / followers * 100
  let engagementRate: number | null = null;
  if (followers > 0 && recentPosts.length > 0) {
    const totalEngagement = recentPosts.reduce((s, p) => s + p.likes + p.comments, 0);
    engagementRate =
      Math.round((totalEngagement / recentPosts.length / followers) * 10000) / 100;
  }

  return {
    id: String(user?.id ?? ""),
    username: user?.username ?? username,
    fullName: user?.full_name ?? "",
    bio: user?.biography ?? "",
    profilePic: user?.profile_pic_url_hd ?? user?.profile_pic_url ?? null,
    externalUrl: user?.external_url ?? null,
    isPrivate: Boolean(user?.is_private),
    isVerified: Boolean(user?.is_verified),
    isBusiness: Boolean(user?.is_business_account),
    category: user?.category_name ?? user?.category ?? null,
    followers,
    following: num(user?.edge_follow?.count),
    postsCount: num(user?.edge_owner_to_timeline_media?.count),
    engagementRate,
    recentPosts,
  };
}
