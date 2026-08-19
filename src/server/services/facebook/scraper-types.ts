/**
 * Shared shapes for the Facebook scraping stack.
 *
 * The field set mirrors the well-known `facebook-scraper` Python library so
 * results are directly comparable / portable, with a few additions of our own
 * (`source`, `fetchedAt`, sentiment on comments).
 */

export class FbScrapeAuthError extends Error {}
export class FbScrapeRateLimitError extends Error {}

/** Where a given record came from — useful when debugging thin results. */
export type FbScrapeSource = "mbasic" | "graphql" | "browser";

export interface FbScrapedPost {
  postId: string;
  /** Full text including any shared-post text. */
  text: string;
  /** Just the author's own text (excludes shared content). */
  postText: string;
  /** Text of the post being shared, when this is a share. */
  sharedText: string;
  time: string | null;
  postUrl: string | null;
  /** Primary image. */
  image: string | null;
  images: string[];
  video: string | null;
  videoId: string | null;
  videoThumbnail: string | null;
  isLive: boolean;
  /** Outbound link attached to the post. */
  link: string | null;
  likes: number;
  comments: number;
  shares: number;
  /** Per-emoji breakdown when available: { like: 12, love: 3, ... } */
  reactions: Record<string, number>;
  reactionCount: number;
  userId: string | null;
  username: string | null;
  sharedPostId: string | null;
  sharedPostUrl: string | null;
  sharedUserId: string | null;
  sharedUsername: string | null;
  /** Present only when comments were requested for this post. */
  commentsFull?: FbScrapedComment[];
  available: boolean;
  fetchedAt: string;
  source: FbScrapeSource;
}

export interface FbScrapedComment {
  commentId: string;
  commentUrl: string | null;
  commenterId: string | null;
  commenterName: string;
  commenterUrl: string | null;
  /** Secondary line under the name (e.g. "Top contributor"). */
  commenterMeta: string | null;
  commentText: string;
  commentTime: string | null;
  commentImage: string | null;
  commentReactionCount: number;
  replies: FbScrapedComment[];
  /** Depth 0 = top-level, 1 = reply. */
  depth: number;
  source: FbScrapeSource;
}

export interface FbScrapedReactor {
  name: string;
  link: string | null;
  /** like | love | haha | wow | sad | angry | care */
  type: string | null;
}

export interface FbScrapedProfile {
  id: string | null;
  name: string;
  username: string | null;
  url: string;
  profilePic: string | null;
  coverPhoto: string | null;
  about: string | null;
  category: string | null;
  verified: boolean;
  followers: number | null;
  likes: number | null;
  friendCount: number | null;
  work: string[];
  education: string[];
  placesLived: string[];
  contactInfo: Record<string, string>;
  websites: string[];
  fetchedAt: string;
  source: FbScrapeSource;
}

export interface FbScrapedGroup {
  id: string;
  name: string;
  url: string;
  type: string | null;
  members: number | null;
  about: string | null;
  admins: { name: string; link: string | null }[];
  fetchedAt: string;
  source: FbScrapeSource;
}

/** Normalized target parsed out of whatever the user pasted. */
export interface FbTarget {
  kind: "page" | "profile" | "group" | "post";
  /** Page handle, numeric id, or group id. */
  handle: string;
  /** Populated for `kind === "post"`. */
  postId: string | null;
  /** Canonical www.facebook.com URL. */
  url: string;
  raw: string;
}

const PAGE_PATH_BLOCKLIST = new Set([
  "posts",
  "photos",
  "videos",
  "reels",
  "watch",
  "groups",
  "events",
  "marketplace",
  "story.php",
  "permalink.php",
  "photo.php",
  "video.php",
  "share",
  "p",
  "pages",
  "people",
]);

/**
 * Parse anything a user might paste — a bare handle, a page URL, a permalink, a
 * group URL, a `profile.php?id=` URL, an `fb.me`/`m.`/`mbasic.` variant — into a
 * normalized target. This is the single entry point every procedure uses so the
 * whole stack behaves consistently no matter the input format.
 */
export function parseFacebookTarget(raw: string): FbTarget {
  const input = raw.trim();
  if (!input) throw new Error("Empty Facebook target");

  // Bare handle or numeric id (no slashes, no protocol).
  if (!/[/?]/.test(input)) {
    const handle = input.replace(/^@/, "");
    return {
      kind: /^\d+$/.test(handle) ? "profile" : "page",
      handle,
      postId: null,
      url: `https://www.facebook.com/${handle}`,
      raw: input,
    };
  }

  let url: URL;
  try {
    url = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    throw new Error(`Could not parse "${raw}" as a Facebook handle or URL`);
  }
  if (!/(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch)$/i.test(url.hostname)) {
    throw new Error(`"${url.hostname}" is not a Facebook URL`);
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const qs = url.searchParams;

  // /groups/<id>[/posts/<postId>]
  if (segments[0] === "groups" && segments[1]) {
    const postId = segments[2] === "posts" || segments[2] === "permalink" ? segments[3] ?? null : null;
    return {
      kind: postId ? "post" : "group",
      handle: segments[1],
      postId,
      url: postId
        ? `https://www.facebook.com/groups/${segments[1]}/posts/${postId}`
        : `https://www.facebook.com/groups/${segments[1]}`,
      raw: input,
    };
  }

  // Query-string permalink forms: story.php, permalink.php, photo.php, video.php
  const qsPostId = qs.get("story_fbid") || qs.get("fbid") || qs.get("v") || qs.get("post_id");
  if (qsPostId && /^(story|permalink|photo|video)\.php$/.test(segments[0] ?? "")) {
    const owner = qs.get("id") || "";
    return {
      kind: "post",
      handle: owner,
      postId: qsPostId,
      url: url.toString().replace(/^https?:\/\/[^/]+/i, "https://www.facebook.com"),
      raw: input,
    };
  }

  // /profile.php?id=<numeric>
  if (segments[0] === "profile.php" && qs.get("id")) {
    const id = qs.get("id")!;
    return {
      kind: "profile",
      handle: id,
      postId: null,
      url: `https://www.facebook.com/profile.php?id=${id}`,
      raw: input,
    };
  }

  // /<handle>/posts/<id>, /<handle>/videos/<id>, /<handle>/photos/.../<id>, /reel/<id>
  if (segments[0] === "reel" || segments[0] === "watch") {
    const id = segments[1] || qs.get("v") || "";
    return {
      kind: "post",
      handle: "",
      postId: id,
      url: `https://www.facebook.com/${segments[0]}/${id}`,
      raw: input,
    };
  }
  if (segments.length >= 2 && ["posts", "videos", "photos", "reels"].includes(segments[1])) {
    const id = segments[segments.length - 1];
    return {
      kind: "post",
      handle: segments[0],
      postId: id.replace(/^pfbid/, "pfbid"),
      url: `https://www.facebook.com/${segments[0]}/${segments[1]}/${id}`,
      raw: input,
    };
  }

  // Anything else with a single usable segment → a page/profile.
  const handle = segments[0] ?? "";
  if (!handle || PAGE_PATH_BLOCKLIST.has(handle)) {
    throw new Error(`Could not work out what "${raw}" points at — paste a page URL or a post permalink`);
  }
  return {
    kind: /^\d+$/.test(handle) ? "profile" : "page",
    handle,
    postId: null,
    url: `https://www.facebook.com/${handle}`,
    raw: input,
  };
}

/** "1.2K", "3,405", "1.1M" → number. */
export function parseCount(input: string | null | undefined): number | null {
  if (!input) return null;
  const m = /(\d[\d.,]*)\s*([KMB])?/i.exec(String(input).trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toUpperCase();
  const mult = suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

/** Cookie bundle → header string + the logged-in user id. */
export function normalizeCookies(raw: string): { cookie: string; cUser: string | null } {
  let cookie = raw.trim();
  if (cookie.startsWith("{") || cookie.startsWith("[")) {
    try {
      const parsed = JSON.parse(cookie);
      const pairs = Array.isArray(parsed)
        ? parsed.map((c: any) => `${c.name}=${c.value}`)
        : Object.entries(parsed as Record<string, string>).map(([k, v]) => `${k}=${v}`);
      cookie = pairs.join("; ");
    } catch {
      /* treat as a raw cookie string */
    }
  }
  cookie = cookie.replace(/\s*;\s*/g, "; ").trim();
  return { cookie, cUser: /c_user=(\d+)/.exec(cookie)?.[1] ?? null };
}

export function assertUsableCookies(cookie: string): void {
  if (!/c_user=\d+/.test(cookie) || !/xs=/.test(cookie)) {
    throw new FbScrapeAuthError(
      "Facebook cookies must include c_user and xs — copy them from facebook.com in DevTools → Application → Cookies.",
    );
  }
}
