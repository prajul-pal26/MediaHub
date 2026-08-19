/**
 * Facebook Page fetcher (official Graph API).
 *
 * Unlike Instagram, Facebook has NO anonymous public JSON endpoint, so this
 * uses the Graph API with an access token. The token can be:
 *   - a Page/User access token the caller pastes, or
 *   - the org's configured FB app access token ("{app_id}|{app_secret}").
 *
 * IMPORTANT: The Graph API only returns data for Pages the token is allowed to
 * see. Reading arbitrary public Pages requires Meta "Page Public Content
 * Access" (App Review). Without it, lookups of Pages you don't own will fail
 * with a Graph error — which is surfaced verbatim.
 */

const GRAPH = "https://graph.facebook.com/v19.0";

export interface FbPagePost {
  id: string;
  message: string;
  createdTime: string | null;
  permalink: string | null;
  likes: number;
  comments: number;
  shares: number;
}

export interface FbPage {
  id: string;
  name: string;
  username: string | null;
  category: string | null;
  about: string | null;
  link: string | null;
  website: string | null;
  picture: string | null;
  fanCount: number;
  followersCount: number;
  verified: boolean;
  engagementRate: number | null;
  recentPosts: FbPagePost[];
  /** set when posts couldn't be read (e.g. no Page Public Content Access) */
  postsError?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}?${qs}`, {
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err: any) {
    throw new Error(
      err?.name === "AbortError" ? "Facebook request timed out" : `Network error: ${err?.message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const msg = json?.error?.message ?? `Graph API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export async function fetchFacebookPage(
  idOrUsernameRaw: string,
  accessToken: string,
): Promise<FbPage> {
  const idOrUsername = idOrUsernameRaw.trim().replace(/^@/, "");
  if (!idOrUsername) throw new Error("Empty page id/username");
  if (!accessToken) throw new Error("No Facebook access token available");

  const page = await graphGet(idOrUsername, {
    fields:
      "id,name,username,fan_count,followers_count,about,category,link,website,verification_status,picture.type(large)",
    access_token: accessToken,
  });

  // Try to pull recent posts (may fail without Page Public Content Access / ownership)
  let recentPosts: FbPagePost[] = [];
  let postsError: string | undefined;
  try {
    const feed = await graphGet(`${page.id}/posts`, {
      fields:
        "id,message,created_time,permalink_url,likes.summary(true),comments.summary(true),shares",
      limit: "8",
      access_token: accessToken,
    });
    recentPosts = (feed?.data ?? []).map((p: any) => ({
      id: p?.id ?? "",
      message: p?.message ?? "",
      createdTime: p?.created_time ?? null,
      permalink: p?.permalink_url ?? null,
      likes: num(p?.likes?.summary?.total_count),
      comments: num(p?.comments?.summary?.total_count),
      shares: num(p?.shares?.count),
    }));
  } catch (err: any) {
    postsError = err?.message ?? "Could not read posts";
  }

  const followersCount = num(page?.followers_count) || num(page?.fan_count);
  let engagementRate: number | null = null;
  if (followersCount > 0 && recentPosts.length > 0) {
    const total = recentPosts.reduce((s, p) => s + p.likes + p.comments + p.shares, 0);
    engagementRate = Math.round((total / recentPosts.length / followersCount) * 10000) / 100;
  }

  return {
    id: String(page?.id ?? ""),
    name: page?.name ?? idOrUsername,
    username: page?.username ?? null,
    category: page?.category ?? null,
    about: page?.about ?? null,
    link: page?.link ?? null,
    website: page?.website ?? null,
    picture: page?.picture?.data?.url ?? null,
    fanCount: num(page?.fan_count),
    followersCount,
    verified: (page?.verification_status ?? "not_verified") !== "not_verified",
    engagementRate,
    recentPosts,
    postsError,
  };
}
