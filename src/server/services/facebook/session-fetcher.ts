/**
 * Facebook PAGE fetcher via a logged-in USER SESSION (cookies) — bypasses the
 * Graph API's Page-Public-Content-Access gate, the same way the Instagram
 * `sessionid` unlocks web_profile_info.
 *
 * Two methods, tried in order:
 *   1. Extract a first-party EAAG access token from a Meta business surface,
 *      then call graph.facebook.com (clean JSON, best data).
 *   2. Fallback: parse m.facebook.com mobile HTML (basic profile + posts).
 *
 * NOTE: scraping against Meta ToS. Cookies (esp. `xs`) rotate and can trigger
 * checkpoints. Use a throwaway account. Errors are surfaced, session marked dead
 * only on a definitive auth failure.
 */

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15";
const GRAPH_VERSION = "v21.0";

export class FbAuthError extends Error {}
export class FbRateLimitError extends Error {}

export interface FbPost {
  id: string;
  message: string;
  createdTime: string | null;
  permalink: string | null;
  picture: string | null;
  likes: number;
  comments: number;
  shares: number;
}

export interface FbPageData {
  id: string;
  name: string;
  username: string | null;
  category: string | null;
  about: string | null;
  picture: string | null;
  link: string | null;
  verified: boolean;
  followers: number | null;
  likes: number | null;
  posts: FbPost[];
  source: "graph" | "mobile";
  postsError?: string;
}

/** Accept either an object or a raw "c_user=..; xs=.." cookie string → Cookie header + c_user. */
export function normalizeFbCookies(raw: string): { cookie: string; cUser: string | null } {
  const s = raw.trim();
  let cookie = s;
  // If it's JSON-ish, try to build a cookie string.
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as Record<string, string>;
      cookie = Object.entries(obj)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    } catch {
      /* fall through, treat as raw */
    }
  }
  cookie = cookie.replace(/\s*;\s*/g, "; ").trim();
  const cUser = /c_user=(\d+)/.exec(cookie)?.[1] ?? null;
  return { cookie, cUser };
}

function baseHeaders(cookie: string): Record<string, string> {
  return {
    "User-Agent": DESKTOP_UA,
    Accept: "text/html,application/xhtml+xml,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookie,
  };
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store", redirect: "manual" });
  } finally {
    clearTimeout(timeout);
  }
}

/** METHOD 1a — harvest a first-party EAAG/EAAB token from a business surface. */
async function extractFbToken(cookie: string): Promise<string | null> {
  const surfaces = [
    "https://business.facebook.com/business_locations",
    "https://business.facebook.com/latest/home",
    "https://www.facebook.com/adsmanager/manage/campaigns",
    "https://business.facebook.com/content_management",
  ];
  const patterns = [
    /(EAAG\w{20,})/,
    /(EAAB\w{20,})/,
    /"accessToken":"(EAA[A-Za-z0-9]{20,})"/,
    /access_token=(EAA[A-Za-z0-9]{20,})/,
  ];
  for (const url of surfaces) {
    let res: Response;
    try {
      res = await timedFetch(url, { headers: baseHeaders(cookie) });
    } catch {
      continue;
    }
    // A redirect to /login means the session is invalid.
    const loc = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400 && /login|checkpoint/i.test(loc)) {
      throw new FbAuthError("Facebook session redirected to login — cookies invalid/expired");
    }
    if (!res.ok && res.status !== 200) continue;
    const html = await res.text().catch(() => "");
    if (/checkpoint/i.test(html) && /c_user/i.test(cookie) === false) {
      throw new FbAuthError("Facebook checkpoint — approve the login, then retry");
    }
    for (const re of patterns) {
      const m = re.exec(html);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/** METHOD 1b — Graph API call using the harvested first-party token. */
async function fetchViaGraph(idOrUsername: string, token: string): Promise<FbPageData> {
  const fields = [
    "id",
    "name",
    "username",
    "category",
    "about",
    "fan_count",
    "followers_count",
    "link",
    "verification_status",
    "picture.width(720){url}",
    "posts.limit(12){message,created_time,permalink_url,full_picture,reactions.summary(total_count),comments.summary(total_count),shares}",
  ].join(",");
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(idOrUsername)}` +
    `?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;

  const res = await timedFetch(url, { headers: { "User-Agent": DESKTOP_UA }, redirect: "follow" });
  const json: any = await res.json().catch(() => null);
  if (!json || json.error) {
    const msg = json?.error?.message ?? `Graph HTTP ${res.status}`;
    if (json?.error?.code === 190) throw new FbAuthError("Facebook token expired — refresh your session");
    throw new Error(msg);
  }

  const posts: FbPost[] = Array.isArray(json?.posts?.data)
    ? json.posts.data.map((p: any) => ({
        id: p?.id ?? "",
        message: p?.message ?? "",
        createdTime: p?.created_time ?? null,
        permalink: p?.permalink_url ?? null,
        picture: p?.full_picture ?? null,
        likes: Number(p?.reactions?.summary?.total_count) || 0,
        comments: Number(p?.comments?.summary?.total_count) || 0,
        shares: Number(p?.shares?.count) || 0,
      }))
    : [];

  const followers = Number(json?.followers_count ?? json?.fan_count);
  return {
    id: String(json?.id ?? ""),
    name: json?.name ?? idOrUsername,
    username: json?.username ?? null,
    category: json?.category ?? null,
    about: json?.about ?? null,
    picture: json?.picture?.data?.url ?? null,
    link: json?.link ?? null,
    verified: (json?.verification_status ?? "not_verified") !== "not_verified",
    followers: Number.isFinite(followers) ? followers : null,
    likes: Number.isFinite(Number(json?.fan_count)) ? Number(json.fan_count) : null,
    posts,
    source: "graph",
  };
}

/** METHOD 3 — m.facebook.com mobile HTML fallback (basic profile). */
async function fetchViaMobile(idOrUsername: string, cookie: string): Promise<FbPageData> {
  const url = `https://m.facebook.com/${encodeURIComponent(idOrUsername)}`;
  const res = await timedFetch(url, { headers: baseHeaders(cookie), redirect: "follow" });
  const html = await res.text().catch(() => "");
  if (/log in|login/i.test(html) && !/data-sigil/i.test(html)) {
    throw new FbAuthError("Facebook redirected to login — cookies invalid/expired");
  }
  const name =
    /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]?.split(" | ")[0]?.trim() ?? idOrUsername;
  const id = /"entity_id":"?(\d+)"?/.exec(html)?.[1] ?? /profile_id=(\d+)/.exec(html)?.[1] ?? "";
  const followersRaw = /([\d.,]+[KMB]?)\s*(?:followers|people follow)/i.exec(html)?.[1];
  const followers = followersRaw ? parseCompact(followersRaw) : null;
  const picture = /"profile_picture":\{"uri":"([^"]+)"/.exec(html)?.[1]?.replace(/\\\//g, "/") ?? null;

  return {
    id,
    name,
    username: /^[a-zA-Z0-9.]+$/.test(idOrUsername) ? idOrUsername : null,
    category: null,
    about: null,
    picture,
    link: `https://www.facebook.com/${idOrUsername}`,
    verified: /verified/i.test(html),
    followers,
    likes: null,
    posts: [],
    source: "mobile",
    postsError: "Post-level data needs the Graph token path — mobile fallback returns profile only.",
  };
}

function parseCompact(s: string): number | null {
  const m = /([\d.,]+)\s*([KMB]?)/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = m[2]?.toUpperCase() === "B" ? 1e9 : m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

/**
 * Main entry — fetch a page's data using the user's Facebook session cookies.
 * Tries the first-party-token → Graph path first, falls back to mobile HTML.
 */
export async function fetchFacebookPageWithSession(
  idOrUsernameRaw: string,
  cookiesRaw: string,
): Promise<FbPageData> {
  const idOrUsername = idOrUsernameRaw.trim().replace(/^@/, "").replace(/\/+$/, "");
  if (!idOrUsername) throw new Error("Empty page id/username");
  const { cookie, cUser } = normalizeFbCookies(cookiesRaw);
  if (!cUser || !/xs=/.test(cookie)) {
    throw new FbAuthError("Facebook cookies must include c_user and xs");
  }

  // Method 1: first-party token → Graph API
  let token: string | null = null;
  try {
    token = await extractFbToken(cookie);
  } catch (err) {
    if (err instanceof FbAuthError) throw err;
  }
  if (token) {
    try {
      return await fetchViaGraph(idOrUsername, token);
    } catch (err) {
      if (err instanceof FbAuthError) throw err;
      // fall through to mobile
    }
  }

  // Method 3: mobile HTML fallback
  return await fetchViaMobile(idOrUsername, cookie);
}
