/**
 * Facebook scraping over the `mbasic.facebook.com` surface.
 *
 * mbasic is the no-JavaScript fallback Facebook still serves for low-end
 * devices. It returns plain server-rendered HTML, so a normal `fetch` with the
 * session cookies gets real content — unlike www.facebook.com, which hands a
 * plain fetch an empty JS shell (see browser-fetcher.ts).
 *
 * This is the cheap, fast path: no Chromium, ~300ms per page, and it paginates
 * cleanly via the "See more stories" cursor link. It degrades on accounts that
 * Facebook has migrated off mbasic, so callers should fall back to the browser
 * scraper when this returns nothing.
 *
 * NOTE: scraping is against Meta's ToS and cookies can be checkpointed. Use a
 * throwaway account. Approach informed by the `facebook-scraper` project.
 */
import {
  absoluteUrl,
  attr,
  attrAll,
  extractBlocks,
  parseDataAttr,
  stripTags,
  unwrapRedirect,
} from "./html";
import { fbNavigationHeaders, isFacebookRejection } from "./headers";
import {
  assertUsableCookies,
  FbScrapeAuthError,
  FbScrapeRateLimitError,
  normalizeCookies,
  parseCount,
  type FbScrapedComment,
  type FbScrapedGroup,
  type FbScrapedPost,
  type FbScrapedProfile,
} from "./scraper-types";

const MBASIC = "https://mbasic.facebook.com";
/** An old, low-end UA keeps Facebook on the mbasic markup. */
const MBASIC_UA =
  "Mozilla/5.0 (Linux; Android 5.0; SM-G900P Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Mobile Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
/** Facebook throttles hard on bursts; keep a floor between page loads. */
const PAGE_DELAY_MS = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mbasicGet(path: string, cookie: string): Promise<string> {
  const url = path.startsWith("http") ? path : `${MBASIC}${path.startsWith("/") ? "" : "/"}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      // Full browser headers are mandatory: without the Sec-Fetch-*/sec-ch-ua
      // client hints Facebook answers a bare 400 regardless of cookies.
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

  if (res.status === 429) throw new FbScrapeRateLimitError("Facebook rate-limited this session — slow down or rotate cookies");
  if (/\/login|\/checkpoint/i.test(res.url)) {
    throw new FbScrapeAuthError("Facebook redirected to login/checkpoint — the session is invalid or flagged");
  }

  const html = await res.text();
  if (isFacebookRejection(res.status, html)) {
    throw new Error(
      "Facebook refused the request (HTTP 400) — request shape, not the session. Check the browser headers.",
    );
  }
  if (/<title>\s*(Log in|Login|Facebook)\s*<\/title>/i.test(html) && /name="pass"/i.test(html)) {
    throw new FbScrapeAuthError("Facebook served the login page — cookies expired");
  }
  if (/checkpoint\/block|Your Account Has Been/i.test(html)) {
    throw new FbScrapeAuthError("Facebook checkpointed this session — approve the login, then retry");
  }
  return html;
}

/** Map an emoji-reaction key from the reaction bar into a readable name. */
const REACTION_NAMES: Record<string, string> = {
  "1": "like",
  "2": "love",
  "3": "wow",
  "4": "haha",
  "7": "sad",
  "8": "angry",
  "16": "care",
};

/** Post ids live in `data-ft`, but Facebook moves the key around by surface. */
function postIdFrom(dataFt: Record<string, any> | null, block: string): string {
  const fromFt =
    dataFt?.top_level_post_id ??
    dataFt?.mf_story_key ??
    dataFt?.story_fbid ??
    dataFt?.photo_attachments_list?.[0];
  if (fromFt) return String(fromFt);
  const fromHref =
    /story_fbid=(\d+)/.exec(block)?.[1] ??
    /\/posts\/(\d+)/.exec(block)?.[1] ??
    /ft_ent_identifier=(\d+)/.exec(block)?.[1];
  return fromHref ?? "";
}

/** The footer holds counts + permalink; the body above it is the actual post. */
function splitBody(block: string): { body: string; footer: string } {
  const marker = /<div[^>]*class="[^"]*\bfooter\b[^"]*"|<footer\b/i.exec(block);
  const reactionBar = /<a[^>]+href="\/ufi\/reaction\//i.exec(block);
  const cut = marker?.index ?? reactionBar?.index ?? block.length;
  return { body: block.slice(0, cut), footer: block.slice(cut) };
}

function parsePermalink(block: string): string | null {
  const candidates = attrAll(block, "href").filter(
    (h) => /story\.php\?story_fbid=|\/posts\/|permalink\.php|\/videos\/|\/photos\//.test(h) && !/comment/.test(h),
  );
  const href = candidates[0];
  if (!href) return null;
  const abs = absoluteUrl(href);
  if (!abs) return null;
  // Strip Facebook's tracking noise so the link is stable + shareable.
  try {
    const url = new URL(abs);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(__|_ft_|refid|ref|_rdr|eav|hc_|sfns|comment_tracking)/.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return abs;
  }
}

function parseCounts(footer: string): { likes: number; comments: number; shares: number } {
  const text = stripTags(footer);
  // The reaction link's own text is the like/reaction total.
  const reactionAnchor = /<a[^>]+href="\/ufi\/reaction\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(footer);
  const likes =
    parseCount(reactionAnchor ? stripTags(reactionAnchor[1]) : null) ??
    parseCount(/([\d.,]+[KMB]?)\s*(?:people\s+)?(?:reacted|reactions?|likes?)/i.exec(text)?.[1]) ??
    0;
  const comments = parseCount(/([\d.,]+[KMB]?)\s*Comments?/i.exec(text)?.[1]) ?? 0;
  const shares = parseCount(/([\d.,]+[KMB]?)\s*Shares?/i.exec(text)?.[1]) ?? 0;
  return { likes, comments, shares };
}

function parseImages(body: string): string[] {
  const seen = new Set<string>();
  for (const src of attrAll(body, "src")) {
    if (!/^https?:/.test(src)) continue;
    // Skip sprites, emoji, and profile thumbnails — keep post media.
    if (/\/rsrc\.php|static\.xx|emoji|\/safe_image\.php\?.*(?:emoji)/i.test(src)) continue;
    if (/(?:s\d{2}x\d{2}|p\d{2}x\d{2}|c\d+\.\d+\.\d+\.\d+)/.test(src) && seen.size > 0) continue;
    seen.add(src);
  }
  return [...seen];
}

function parseOutboundLink(body: string): string | null {
  for (const href of attrAll(body, "href")) {
    if (/^\/l\.php\?u=/.test(href) || /^https?:\/\/(?!(?:www\.|m\.|mbasic\.)?facebook\.com)/.test(href)) {
      const resolved = unwrapRedirect(absoluteUrl(href));
      if (resolved && !/facebook\.com/.test(resolved)) return resolved;
    }
  }
  return null;
}

function parseTime(block: string): string | null {
  // mbasic renders an <abbr> with the human time; data-ft carries the epoch.
  const dataFt = parseDataAttr(block, "data-ft");
  const epoch =
    dataFt?.page_insights &&
    Object.values(dataFt.page_insights as Record<string, any>)
      .map((v: any) => v?.post_context?.publish_time)
      .find((v) => typeof v === "number");
  if (typeof epoch === "number" && epoch > 0) return new Date(epoch * 1000).toISOString();
  const abbrHtml = /<abbr[^>]*>([\s\S]*?)<\/abbr>/i.exec(block)?.[1];
  const label = abbrHtml ? stripTags(abbrHtml) : null;
  if (!label) return null;
  const parsed = Date.parse(label);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : label;
}

/** Parse one `role="article"` block into a post. */
function parsePostBlock(block: string, fetchedAt: string): FbScrapedPost | null {
  const dataFt = parseDataAttr(block, "data-ft");
  const postId = postIdFrom(dataFt, block);
  const { body, footer } = splitBody(block);

  const text = stripTags(body);
  if (!postId && !text) return null;

  // A shared post nests a second article-ish container inside the body.
  const nested = extractBlocks(body, /<div[^>]+data-ft="[^"]*shared/i, "div")[0] ?? "";
  const sharedText = nested ? stripTags(nested) : "";
  const postText = sharedText && text.endsWith(sharedText) ? text.slice(0, -sharedText.length).trim() : text;

  const { likes, comments, shares } = parseCounts(footer);
  const images = parseImages(body);
  const videoHref = attrAll(body, "href").find((h) => /\/video_redirect\/|\.mp4/i.test(h)) ?? null;

  const reactions: Record<string, number> = {};
  for (const m of footer.matchAll(/reaction_type[=:]"?(\d+)"?[^0-9]{0,40}?([\d.,]+[KMB]?)/gi)) {
    const name = REACTION_NAMES[m[1]];
    const count = parseCount(m[2]);
    if (name && count != null) reactions[name] = count;
  }

  return {
    postId,
    text,
    postText,
    sharedText,
    time: parseTime(block),
    postUrl: parsePermalink(block),
    image: images[0] ?? null,
    images,
    video: videoHref ? unwrapRedirect(absoluteUrl(videoHref)) : null,
    videoId: dataFt?.video_id ? String(dataFt.video_id) : null,
    videoThumbnail: videoHref ? images[0] ?? null : null,
    isLive: /is_live_stream|LIVE NOW/i.test(block),
    link: parseOutboundLink(body),
    likes,
    comments,
    shares,
    reactions,
    reactionCount: Object.values(reactions).reduce((a, b) => a + b, 0) || likes,
    userId: dataFt?.content_owner_id_new ? String(dataFt.content_owner_id_new) : dataFt?.page_id ? String(dataFt.page_id) : null,
    username: null,
    sharedPostId: dataFt?.original_content_id ? String(dataFt.original_content_id) : null,
    sharedPostUrl: null,
    sharedUserId: dataFt?.original_content_owner_id ? String(dataFt.original_content_owner_id) : null,
    sharedUsername: null,
    available: true,
    fetchedAt,
    source: "mbasic",
  };
}

/** Find the "See more stories" cursor link that drives pagination. */
function nextCursorHref(html: string): string | null {
  const section = /<div[^>]+id="(?:m_more_item|structured_composer_async_container)"[\s\S]{0,4000}?<\/div>/i.exec(html)?.[0] ?? html;
  const hrefs = attrAll(section, "href").filter((h) => /cursor=|timestart=|bacr=|sectionLoadingID=/.test(h));
  const href = hrefs.find((h) => !/#/.test(h)) ?? hrefs[0];
  return href ? absoluteUrl(href, "mbasic.facebook.com") : null;
}

export interface ScrapePostsOptions {
  /** How many paginated result pages to walk (each ≈ 4–10 posts). */
  pages?: number;
  /** Hard cap on returned posts. */
  limit?: number;
  /** Fetch each post's comments too (one extra request per post — slow). */
  withComments?: boolean;
  /** Max comments per post when `withComments` is on. */
  commentsPerPost?: number;
}

export interface ScrapePostsResult {
  posts: FbScrapedPost[];
  pagesWalked: number;
  /** True when Facebook stopped serving a cursor before the page budget ran out. */
  exhausted: boolean;
}

/**
 * Walk a page/profile/group timeline and return structured posts.
 * Facebook often serves 1–2 near-empty pages first, so an empty page does not
 * end the walk — only a missing cursor does.
 */
export async function scrapePostsViaMbasic(
  handleOrPath: string,
  cookiesRaw: string,
  options: ScrapePostsOptions = {},
): Promise<ScrapePostsResult> {
  const { pages = 3, limit = 50, withComments = false, commentsPerPost = 20 } = options;
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const fetchedAt = new Date().toISOString();
  const posts: FbScrapedPost[] = [];
  const seen = new Set<string>();

  let url: string | null = handleOrPath.startsWith("http")
    ? handleOrPath
    : `${MBASIC}/${encodeURIComponent(handleOrPath.replace(/^\/+/, ""))}?v=timeline`;
  let pagesWalked = 0;
  let exhausted = false;

  while (url && pagesWalked < pages && posts.length < limit) {
    const html: string = await mbasicGet(url, cookie);
    pagesWalked += 1;

    const blocks = extractBlocks(html, /<div[^>]+role="article"[^>]*>/i, "div");
    for (const block of blocks) {
      if (posts.length >= limit) break;
      const post = parsePostBlock(block, fetchedAt);
      if (!post) continue;
      const key = post.postId || post.postUrl || post.text.slice(0, 120);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      posts.push(post);
    }

    const next: string | null = nextCursorHref(html);
    if (!next || next === url) {
      exhausted = true;
      break;
    }
    url = next;
    if (pagesWalked < pages) await sleep(PAGE_DELAY_MS);
  }

  if (withComments) {
    for (const post of posts) {
      if (!post.postId) continue;
      try {
        post.commentsFull = await scrapeCommentsViaMbasic(post.postUrl ?? post.postId, cookiesRaw, {
          limit: commentsPerPost,
        });
      } catch {
        post.commentsFull = [];
      }
      await sleep(PAGE_DELAY_MS);
    }
  }

  return { posts, pagesWalked, exhausted };
}

/** Parse a single mbasic comment block. */
function parseCommentBlock(block: string, depth: number): FbScrapedComment | null {
  const store = parseDataAttr(block, "data-store") ?? parseDataAttr(block, "data-ft");
  const idFromAttr = attr(block, "id");
  const commentId = String(store?.commentID ?? store?.comment_id ?? idFromAttr ?? "").trim();

  const authorAnchor = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
  const commenterUrl = absoluteUrl(authorAnchor?.[1]);
  const commenterName = authorAnchor ? stripTags(authorAnchor[2]) : "";

  // The body sits in the div right after the author heading.
  const afterAuthor = authorAnchor ? block.slice((authorAnchor.index ?? 0) + authorAnchor[0].length) : block;
  const bodyHtml = /<div[^>]*>([\s\S]*?)<\/div>/i.exec(afterAuthor)?.[1] ?? "";
  const commentText = stripTags(bodyHtml);
  if (!commenterName && !commentText) return null;

  const abbr = /<abbr[^>]*>([\s\S]*?)<\/abbr>/i.exec(block)?.[1];
  const timeLabel = abbr ? stripTags(abbr) : null;
  const parsedTime = timeLabel ? Date.parse(timeLabel) : NaN;

  const commenterId =
    (store?.actorID ?? store?.actor_id)?.toString() ??
    /(?:profile\.php\?id=|\/)(\d{6,})/.exec(commenterUrl ?? "")?.[1] ??
    null;

  const reactionAnchor = /<a[^>]+href="\/ufi\/reaction\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

  return {
    commentId,
    commentUrl: commentId ? absoluteUrl(`/${commentId}`) : null,
    commenterId,
    commenterName,
    commenterUrl,
    commenterMeta: null,
    commentText,
    commentTime: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : timeLabel,
    commentImage: parseImages(block)[0] ?? null,
    commentReactionCount: parseCount(reactionAnchor ? stripTags(reactionAnchor[1]) : null) ?? 0,
    replies: [],
    depth,
    source: "mbasic",
  };
}

export interface ScrapeCommentsOptions {
  limit?: number;
  /** Follow "View replies" links (one extra request per parent comment). */
  withReplies?: boolean;
  maxRepliesPerComment?: number;
}

/**
 * Scrape a post's comments. Accepts a permalink URL or a bare post id, and
 * follows "View more comments" until the limit or the links run out.
 */
export async function scrapeCommentsViaMbasic(
  postUrlOrId: string,
  cookiesRaw: string,
  options: ScrapeCommentsOptions = {},
): Promise<FbScrapedComment[]> {
  const { limit = 50, withReplies = false, maxRepliesPerComment = 10 } = options;
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  let url: string | null = postUrlOrId.startsWith("http")
    ? postUrlOrId.replace(/^https?:\/\/(?:www|m|mbasic)\.facebook\.com/i, MBASIC)
    : `${MBASIC}/${encodeURIComponent(postUrlOrId)}`;

  const comments: FbScrapedComment[] = [];
  const seen = new Set<string>();
  let guard = 0;

  while (url && comments.length < limit && guard < 12) {
    guard += 1;
    const html: string = await mbasicGet(url, cookie);

    // Comment nodes carry a data-sigil of "comment"; fall back to id-prefixed divs.
    let blocks = extractBlocks(html, /<div[^>]+data-sigil="[^"]*\bcomment\b[^"]*"[^>]*>/i, "div");
    if (!blocks.length) blocks = extractBlocks(html, /<div[^>]+id="\d{6,}"[^>]*>/i, "div");

    let added = 0;
    for (const block of blocks) {
      if (comments.length >= limit) break;
      const comment = parseCommentBlock(block, 0);
      if (!comment) continue;
      const key = comment.commentId || `${comment.commenterName}:${comment.commentText.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(comment);
      added += 1;
    }

    const moreHref = attrAll(html, "href").find((h) => /p=\d+.*&?(?:ft_ent_identifier|comment)/i.test(h) || /view_more_comments|\bp=\d+/.test(h));
    const next: string | null = moreHref ? absoluteUrl(moreHref, "mbasic.facebook.com") : null;
    if (!next || next === url || (added === 0 && guard > 1)) break;
    url = next;
    await sleep(PAGE_DELAY_MS);
  }

  if (withReplies) {
    for (const comment of comments) {
      if (!comment.commentId) continue;
      try {
        const replyHtml = await mbasicGet(`/comment/replies/?ctoken=${encodeURIComponent(comment.commentId)}`, cookie);
        const blocks = extractBlocks(replyHtml, /<div[^>]+data-sigil="[^"]*\bcomment\b[^"]*"[^>]*>/i, "div");
        comment.replies = blocks
          .map((b) => parseCommentBlock(b, 1))
          .filter((c): c is FbScrapedComment => !!c && c.commentId !== comment.commentId)
          .slice(0, maxRepliesPerComment);
      } catch {
        /* replies are best-effort */
      }
      await sleep(PAGE_DELAY_MS);
    }
  }

  return comments;
}

/** Read the About tabs of a page/profile: work, education, places, contact. */
export async function scrapeProfileViaMbasic(handle: string, cookiesRaw: string): Promise<FbScrapedProfile> {
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const clean = handle.replace(/^@/, "").replace(/^\/+/, "");
  const path = /^\d+$/.test(clean) ? `/profile.php?id=${clean}&v=info` : `/${encodeURIComponent(clean)}/about`;
  const html = await mbasicGet(path, cookie);
  const text = stripTags(html);

  const section = (label: RegExp): string[] => {
    const match = label.exec(text);
    if (!match) return [];
    const chunk = text.slice(match.index + match[0].length, match.index + match[0].length + 400);
    return chunk
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(Work|Education|Places lived|Contact|Basic|About|Details)/i.test(l))
      .slice(0, 6);
  };

  const contactInfo: Record<string, string> = {};
  const email = /[\w.+-]+@[\w-]+\.[\w.]{2,}/.exec(text)?.[0];
  if (email) contactInfo.email = email;
  const phone = /(?:\+\d[\d\s-]{7,}\d)/.exec(text)?.[0];
  if (phone) contactInfo.phone = phone.trim();

  const websites = attrAll(html, "href")
    .map((h) => unwrapRedirect(absoluteUrl(h)))
    .filter((h): h is string => !!h && !/facebook\.com|fbcdn\.net/.test(h))
    .slice(0, 5);

  const name =
    stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").split("|")[0].trim() || clean;

  return {
    id: /"(?:entity_id|profile_id|userID)"\s*:\s*"?(\d+)"?/.exec(html)?.[1] ?? (/^\d+$/.test(clean) ? clean : null),
    name,
    username: /^\d+$/.test(clean) ? null : clean,
    url: `https://www.facebook.com/${clean}`,
    profilePic: parseImages(html)[0] ?? null,
    coverPhoto: null,
    about: section(/\bAbout\b/i)[0] ?? null,
    category: /Page\s*·\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? null,
    verified: /Verified Page|Verified account/i.test(text),
    followers: parseCount(/([\d.,]+[KMB]?)\s*(?:people\s+)?follow/i.exec(text)?.[1]),
    likes: parseCount(/([\d.,]+[KMB]?)\s*(?:people\s+)?like/i.exec(text)?.[1]),
    friendCount: parseCount(/([\d.,]+[KMB]?)\s*friends/i.exec(text)?.[1]),
    work: section(/\bWork\b/i),
    education: section(/\bEducation\b/i),
    placesLived: section(/Places lived/i),
    contactInfo,
    websites: [...new Set(websites)],
    fetchedAt: new Date().toISOString(),
    source: "mbasic",
  };
}

/** Group metadata: name, type, member count, admins. */
export async function scrapeGroupViaMbasic(groupId: string, cookiesRaw: string): Promise<FbScrapedGroup> {
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const html = await mbasicGet(`/groups/${encodeURIComponent(groupId)}?view=info`, cookie);
  const text = stripTags(html);

  const admins: { name: string; link: string | null }[] = [];
  const adminSection = /Admins?(?:\s+and\s+moderators?)?([\s\S]{0,3000})/i.exec(html)?.[1] ?? "";
  for (const m of adminSection.matchAll(/<a[^>]+href="([^"]*(?:profile\.php\?id=\d+|\/[\w.]+)[^"]*)"[^>]*>([^<]{2,60})<\/a>/gi)) {
    const name = stripTags(m[2]).trim();
    if (!name || /^(see|more|join|group)/i.test(name)) continue;
    admins.push({ name, link: absoluteUrl(m[1]) });
    if (admins.length >= 12) break;
  }

  return {
    id: groupId,
    name: stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").split("|")[0].trim() || groupId,
    url: `https://www.facebook.com/groups/${groupId}`,
    type: /\b(Public|Private|Closed|Secret)\s+group\b/i.exec(text)?.[1] ?? null,
    members: parseCount(/([\d.,]+[KMB]?)\s*members?/i.exec(text)?.[1]),
    about: /About(?:\s+this\s+group)?\n([^\n]{10,400})/i.exec(text)?.[1]?.trim() ?? null,
    admins,
    fetchedAt: new Date().toISOString(),
    source: "mbasic",
  };
}
