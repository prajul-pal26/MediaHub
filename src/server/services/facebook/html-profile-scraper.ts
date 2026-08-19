/**
 * Facebook profile posts, read from the server-rendered HTML.
 *
 * Why not the browser: Playwright renders only ~2.7KB of a Facebook profile
 * (the header plus a notifications tray) and never hydrates the feed, headless
 * or headful. A plain fetch with correct browser headers returns ~2.6MB
 * containing real story data as embedded JSON — so the HTTP path is strictly
 * better here, and needs no Chromium at all.
 *
 * Facebook ships that data inside <script type="application/json"> blobs. Rather
 * than regex the minified payload, this parses each blob and walks it for
 * objects shaped like a story (a feedback node carrying reaction/comment/share
 * counts). That survives key reordering, which regexes do not.
 *
 * Only the first handful of posts are server-rendered; the rest lazy-load over
 * GraphQL. So expect a few posts per profile, not a full timeline.
 */
import { fbNavigationHeaders, isFacebookRejection } from "./headers";
import { assertUsableCookies, normalizeCookies, FbScrapeAuthError } from "./scraper-types";

const REQUEST_TIMEOUT_MS = 30_000;

export interface FbHtmlPost {
  postId: string;
  storyFbid: string | null;
  url: string | null;
  text: string;
  createdAt: string | null;
  likes: number;
  comments: number;
  shares: number;
  /** Reel/video posts carry a play count; normal posts don't. */
  views: number | null;
  isVideo: boolean;
  ownerName: string | null;
  ownerId: string | null;
}

/** Pull every <script type="application/json"> payload out of the page. */
function scriptBlobs(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1];
    if (!body || body.length < 40) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      /* not every blob is well-formed JSON we care about */
    }
  }
  return out;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Depth-first walk collecting every object that satisfies `pick`. */
function collect(root: unknown, pick: (node: any) => boolean, cap = 400): any[] {
  const found: any[] = [];
  const stack: unknown[] = [root];
  let steps = 0;
  while (stack.length && steps < 500_000 && found.length < cap) {
    const node = stack.pop();
    steps += 1;
    if (!node || typeof node !== "object") continue;
    if (pick(node)) found.push(node);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return found;
}

/** A story node: has feedback, and some text or a creation time. */
function looksLikeStory(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  const hasFeedback = node.feedback && typeof node.feedback === "object";
  const hasIdentity = node.post_id || node.id || node.story_fbid || node.creation_time;
  return Boolean(hasFeedback && hasIdentity);
}

/** Counts live at varying depths inside feedback; probe the known shapes. */
function readCounts(feedback: any): { likes: number; comments: number; shares: number } {
  const f = feedback ?? {};
  const likes =
    num(f.reaction_count?.count) ||
    num(f.reactors?.count) ||
    num(f.i18n_reaction_count) ||
    num(f.top_reactions?.summary?.total_count);
  const comments =
    num(f.total_comment_count) ||
    num(f.comment_count?.total_count) ||
    num(f.comments?.total_count) ||
    num(f.comment_rendering_instance?.comments?.total_count);
  const shares = num(f.share_count?.count) || num(f.reshare_count) || num(f.i18n_share_count);
  return { likes, comments, shares };
}

function readText(node: any): string {
  return (
    node?.message?.text ??
    node?.comet_sections?.content?.story?.message?.text ??
    node?.story?.message?.text ??
    node?.title?.text ??
    ""
  );
}

export interface HtmlProfileResult {
  posts: FbHtmlPost[];
  /** Bytes of HTML received — a tiny page means Facebook served a shell. */
  htmlLength: number;
  profileName: string | null;
}

/**
 * Fetch a profile/page and extract the server-rendered posts.
 * `handle` may be a bare handle or a full URL.
 */
export async function scrapeProfilePostsViaHtml(
  handleOrUrl: string,
  cookiesRaw: string,
): Promise<HtmlProfileResult> {
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const url = handleOrUrl.startsWith("http")
    ? handleOrUrl
    : `https://www.facebook.com/${handleOrUrl.replace(/^\/+|\/+$/g, "")}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: fbNavigationHeaders(cookie),
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new Error(
      err?.name === "AbortError" ? "Facebook request timed out" : `Network error: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const html = await res.text();
  if (isFacebookRejection(res.status, html)) {
    throw new Error("Facebook refused the request (HTTP 400) — check the browser headers.");
  }
  if (/\/login|\/checkpoint/i.test(res.url)) {
    throw new FbScrapeAuthError("Facebook redirected to login/checkpoint — session invalid or flagged");
  }

  const profileName =
    /<title>([^<]{2,120})<\/title>/i.exec(html)?.[1]?.replace(/\s*\|\s*Facebook\s*$/i, "").trim() ?? null;

  const blobs = scriptBlobs(html);
  const stories: any[] = [];
  for (const blob of blobs) stories.push(...collect(blob, looksLikeStory));

  const byId = new Map<string, FbHtmlPost>();
  for (const s of stories) {
    const feedback = s.feedback ?? {};
    const { likes, comments, shares } = readCounts(feedback);
    const postId = String(s.post_id ?? s.story_fbid ?? s.id ?? "");
    if (!postId) continue;

    const text = readText(s);
    // A story with no text and no engagement is chrome, not a post.
    if (!text && likes + comments + shares === 0) continue;

    const owner = feedback.owning_profile ?? s.actors?.[0] ?? {};
    const storyFbid = s.story_fbid ? String(s.story_fbid) : null;
    const created = Number(s.creation_time);

    const existing = byId.get(postId);
    const candidate: FbHtmlPost = {
      postId,
      storyFbid,
      url:
        s.wwwURL ??
        s.url ??
        (storyFbid && owner?.id
          ? `https://www.facebook.com/${owner.id}/posts/${storyFbid}`
          : null),
      text,
      createdAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
      likes,
      comments,
      shares,
      views: num(s.video_view_count) || num(s.play_count) || null,
      isVideo: Boolean(s.is_video || s.video || s.attachments?.some?.((a: any) => a?.media?.__typename === "Video")),
      ownerName: owner?.name ?? null,
      ownerId: owner?.id ? String(owner.id) : null,
    };
    // Keep the richest version when the same story appears in several blobs.
    if (!existing || candidate.likes + candidate.comments + candidate.shares > existing.likes + existing.comments + existing.shares) {
      byId.set(postId, candidate);
    }
  }

  const posts = [...byId.values()].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return { posts, htmlLength: html.length, profileName };
}
