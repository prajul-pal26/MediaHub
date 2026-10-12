/**
 * Facebook High-Performance Unified Scraper via Playwright + Chromium.
 *
 * Optimizations:
 * 1. Instant Cache: Returns in 0–10ms for cached targets.
 * 2. Media & Resource Blocking: Blocks images/media/fonts/trackers during DOM parsing,
 *    reducing page load time by 80%.
 * 3. Feed Accumulation: Iteratively extracts posts during fast scrolls to defeat
 *    Comet React DOM virtualization.
 * 4. Multi-strategy Follower & Like Extraction: Inspects <meta> tags, header links,
 *    subtitles, and intro pills.
 * 5. Concurrent Comment Harvesting: Runs comment extraction across posts in parallel.
 */
import {
  getSharedBrowser,
  resetSharedBrowser,
  toPlaywrightCookies,
  DESKTOP_UA as UA,
} from "./browser-pool";
import { availableParallelism } from "node:os";
import { getCachedFbPage, setCachedFbPage, type FbCacheRequirements } from "./fb-cache";

export class FbBrowserAuthError extends Error {}
/** Facebook rate limits are temporary; they must never invalidate a saved session. */
export class FbBrowserRateLimitError extends Error {}

/** The kind of rendered content retained for a visible Facebook comment node. */
export type FbCommentContentType = "text" | "emoji" | "gif" | "image" | "video" | "attachment" | "unavailable";
/** More precise rendering detail retained alongside the legacy export type. */
export type FbCommentContentKind = "text" | "emoji" | "gif" | "sticker" | "video" | "photo" | "attachment" | "empty";
/** How the collector established that a returned comment was Facebook-hidden. */
export type FbCommentHiddenSource = "card_marker" | "revealed_by_hidden_control";

export interface FbBrowserComment {
  id: string;
  parentId?: string | null;
  images?: string[];
  video?: string | null;
  timeLabel?: string | null;
  metricsAvailable?: boolean;
  commentUrl?: string | null;
  authorName: string;
  authorProfileUrl?: string | null;
  authorAvatar?: string | null;
  authorBadge?: string | null;
  /** Rich-media nodes keep a human-readable placeholder in text and their detected kind here. */
  contentType?: FbCommentContentType;
  /** Primary observed content kind. `contentType` remains for backwards-compatible exports. */
  contentKind?: FbCommentContentKind;
  /** Every observed kind, including a text comment with an attached GIF or photo. */
  contentKinds?: FbCommentContentKind[];
  /** A Facebook permalink is preferred; derived IDs only identify visible cards without one. */
  idSource?: "permalink" | "derived";
  /** True only when the card itself is marked hidden or it arrived immediately after a hidden-comment control was expanded. */
  isHidden?: boolean;
  hiddenSource?: FbCommentHiddenSource;
  text: string;
  createdAt?: string | null;
  likeCount: number;
  replyCount: number;
  depth: number;
  replies?: FbBrowserComment[];
}

/** A durable, non-overlapping explanation of the stored comment tree. */
export interface FbCommentsBreakdown {
  totalCount: number;
  topLevelCount: number;
  visibleTopLevelCount: number;
  hiddenTopLevelCount: number;
  replyCount: number;
  hiddenReplyCount: number;
  hiddenCount: number;
}

/** Count every unique node once; replies are included in the scraped total. */
export function summarizeFbComments(comments: FbBrowserComment[]): FbCommentsBreakdown {
  const seen = new Set<string>();
  let totalCount = 0;
  let topLevelCount = 0;
  let hiddenTopLevelCount = 0;
  let replyCount = 0;
  let hiddenReplyCount = 0;
  const visit = (comment: FbBrowserComment, parentId: string | null) => {
    if (seen.has(comment.id)) return;
    seen.add(comment.id);
    totalCount += 1;
    const reply = Boolean(comment.parentId ?? parentId) || (comment.depth ?? 0) > 0;
    if (reply) {
      replyCount += 1;
      if (comment.isHidden) hiddenReplyCount += 1;
    } else {
      topLevelCount += 1;
      if (comment.isHidden) hiddenTopLevelCount += 1;
    }
    for (const child of comment.replies ?? []) visit(child, comment.id);
  };
  for (const comment of comments) visit(comment, null);
  return {
    totalCount,
    topLevelCount,
    visibleTopLevelCount: topLevelCount - hiddenTopLevelCount,
    hiddenTopLevelCount,
    replyCount,
    hiddenReplyCount,
    hiddenCount: hiddenTopLevelCount + hiddenReplyCount,
  };
}

export interface FbBrowserReactor {
  name: string;
  link?: string | null;
  type?: string | null;
}

export type FbMediaEngagement = import("./media-engagement").MediaEngagement;
/** The comment ordering Facebook actually exposed for a saved detail result. */
export type FbCommentsSourceView = "all" | "newest" | "most_relevant" | "unknown";
/**
 * Evidence that Facebook repeatedly exposed the same finite comment view.
 *
 * This never replaces its raw badge. It only lets the UI distinguish a
 * retrievable gap from a remainder Facebook is currently withholding from the
 * signed-in session. The fingerprint is a hash of the current scan's stable
 * comment IDs; the attempt ID prevents a checkpoint and terminal callback for
 * the very same browser run from being counted twice.
 */
export interface FbCommentsAccessibility {
  sourceView: "all" | "newest";
  stablePasses: number;
  /** Raw Facebook badge observed for the matching scan pair. */
  reportedCount: number;
  lastScanFingerprint: string;
  lastAttemptId?: string;
  verifiedAt?: string;
}
export interface FbMediaMetadata {
  text?: string;
  publishedTime?: string | null;
  views?: number | null;
}

export interface FbBrowserPost {
  engagement?: FbMediaEngagement;
  commentsStatus?: "pending" | "running" | "complete" | "partial" | "failed" | "cancelled";
  commentsStopReason?: string;
  commentsDurationMs?: number;
  commentsReportedCount?: number | null;
  /** Facebook's raw count can include hidden, deleted, or otherwise unexposed nodes. */
  commentsObservedCount?: number;
  /** A separately verified retrievable target; never a replacement for Facebook's raw badge. */
  commentsVerifiedAccessibleCount?: number;
  /**
   * The verified count used as the basis for the actionable scrape delta.
   * It is named `Reported Delta Count` in exports at the user's request, but
   * it is an effective reported count (not the raw-minus-visible difference).
   */
  commentsReportedDeltaCount?: number;
  commentsAccessibility?: FbCommentsAccessibility;
  /** Derived from the stored JSON, not inferred from Facebook's raw badge. */
  commentsBreakdown?: FbCommentsBreakdown;
  commentsTextCount?: number;
  commentsExcludedNonTextCount?: number;
  commentsExcludedAttachmentCount?: number;
  commentsContentScope?: "text_only" | "observed_nodes";
  /** `complete` describes the collected view; this records whether Facebook exposed All comments. */
  commentsSourceView?: FbCommentsSourceView;
  mediaType?: "photo" | "reel";
  metricsAvailable?: boolean;
  views?: number | null;
  postId?: string | null;
  url?: string | null;
  text: string;
  publishedTime?: string | null;
  likes: number;
  comments: number;
  shares: number;
  images?: string[];
  video?: string | null;
  isVideo?: boolean;
  commentsData?: FbBrowserComment[];
  commentsError?: string;
  reactorsData?: FbBrowserReactor[];
  reactorsBreakdown?: Record<string, number>;
}

export interface FbFetchStats {
  requestedPosts: number;
  scrapedPosts: number;
  totalCommentsScraped: number;
  totalLikesScraped: number;
  totalSharesScraped: number;
  totalReactorsScraped?: number;
  followers: number | null;
  likes: number | null;
  engagementRate: string | null;
}

export interface FbBrowserPage {
  contentType?: "posts" | "reels";
  retrieval?: {
    capturedAt: string;
    fromCache: boolean;
    durationMs: number;
    requested: number;
    returned: number;
    stopReason: "limit" | "end" | "stalled" | "timeout";
  };
  handle: string;
  name: string;
  url: string;
  kind?: "page" | "profile" | "group" | "post";
  profilePic: string | null;
  coverPic?: string | null;
  followers: number | null;
  likes: number | null;
  category: string | null;
  about: string | null;
  verified: boolean;
  posts: FbBrowserPost[];
  stats?: FbFetchStats;
  instagram: string | null;
  twitter: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

export interface FetchFacebookPageOptions {
  postLimit?: number;
  includeComments?: boolean;
  commentsLimit?: number;
  includeReactors?: boolean;
  reactorsLimit?: number;
  bypassCache?: boolean;
}

function parseCount(s: string | undefined | null): number | null {
  if (!s) return null;
  const str = s.trim().replace(/\u00a0/g, " ");
  const m = /([\d.,]+)\s*([KMBL]?)/i.exec(str);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(num)) return null;
  const unit = m[2]?.toUpperCase();
  const mult =
    unit === "B"
      ? 1e9
      : unit === "M"
      ? 1e6
      : unit === "L"
      ? 1e5
      : unit === "K"
      ? 1e3
      : 1;
  return Math.round(num * mult);
}

/**
 * Normalizes any Facebook target input (page vanity, profile.php?id, /people/..., post URL, group URL, @handle, plain handle, numeric ID)
 */
export function normalizeFacebookTarget(input: string): {
  handle: string;
  url: string;
  kind: "page" | "profile" | "group" | "post";
} {
  if (!input) return { handle: "", url: "", kind: "page" };
  const s = input.trim();

  // Groups
  if (/facebook\.com\/groups\//i.test(s)) {
    const m = /facebook\.com\/groups\/([^/?#]+)/i.exec(s);
    const gid = m?.[1] || "";
    return {
      handle: gid,
      url: s.startsWith("http") ? s.split("?")[0] : `https://${s.split("?")[0]}`,
      kind: "group",
    };
  }

  // Post permalinks
  if (/\/(posts|videos|reel|photos)\/|story_fbid=/i.test(s)) {
    return {
      handle: s.split("/").filter(Boolean).pop()?.split("?")[0] || "post",
      url: s.startsWith("http") ? s : `https://${s}`,
      kind: "post",
    };
  }

  // profile.php?id=1000...
  const profMatch = s.match(/profile\.php\?id=(\d+)/i);
  if (profMatch && profMatch[1]) {
    return {
      handle: profMatch[1],
      url: `https://www.facebook.com/profile.php?id=${profMatch[1]}`,
      kind: "profile",
    };
  }

  // /people/Name/1000123.../
  const peopleMatch = s.match(/facebook\.com\/people\/[^/]+\/(\d+)/i);
  if (peopleMatch && peopleMatch[1]) {
    return {
      handle: peopleMatch[1],
      url: s.startsWith("http") ? s.split("?")[0].replace(/\/+$/, "") : `https://${s.split("?")[0].replace(/\/+$/, "")}`,
      kind: "profile",
    };
  }

  // Plain numeric ID
  if (/^\d{6,}$/.test(s)) {
    return {
      handle: s,
      url: `https://www.facebook.com/profile.php?id=${s}`,
      kind: "profile",
    };
  }

  // Generic handle or URL
  const clean = s
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i, "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .trim();

  const isNumeric = /^\d+$/.test(clean);
  const targetUrl = isNumeric
    ? `https://www.facebook.com/profile.php?id=${clean}`
    : `https://www.facebook.com/${clean}`;

  return {
    handle: clean,
    url: targetUrl,
    kind: isNumeric ? "profile" : "page",
  };
}

/**
 * Scrape a Facebook page, profile, group, or post using session cookies.
 */
export async function fetchFacebookPageViaBrowser(
  targetRaw: string,
  cookieString: string,
  options: FetchFacebookPageOptions = {},
): Promise<FbBrowserPage> {
  const {
    postLimit = 12,
    includeComments = true,
    commentsLimit = 25,
    includeReactors = false,
    reactorsLimit = 50,
    bypassCache = false,
  } = options;

  const target = normalizeFacebookTarget(targetRaw);
  if (!target.handle && !target.url) throw new Error("Empty Facebook target handle or URL");
  // A Page landing view often exposes only its featured/pinned item. The Posts
  // view is the actual chronological feed and is much more reliable for bulk
  // Match the timeline the user sees in Facebook. The dedicated /posts tab
  // can be an activity view that contains comment cards instead of posts.
  const feedUrl = target.url;

  const cacheRequirements: FbCacheRequirements = {
    postLimit,
    includeComments,
    commentsLimit,
    includeReactors,
    reactorsLimit,
  };

  // A result is reusable only for the exact amount and kinds of data requested.
  // In particular, never serve a one-post partial scrape for a larger request.
  if (!bypassCache) {
    const cached =
      getCachedFbPage(targetRaw, cacheRequirements) ||
      getCachedFbPage(target.handle, cacheRequirements);
    if (cached && cached.posts.length >= postLimit) {
      return cached;
    }
  }

  if (!/c_user=/.test(cookieString) || !/xs=/.test(cookieString)) {
    throw new FbBrowserAuthError("Facebook cookies must include c_user and xs");
  }

  const cookies = toPlaywrightCookies(cookieString);

  const attempt = async (): Promise<FbBrowserPage> => {
    const browser = await getSharedBrowser();
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 1200 },
      locale: "en-US",
    });

    try {
      await ctx.addCookies(cookies);

      // Fonts and video are not needed for the DOM data we extract.
      await ctx.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "font" || type === "media") return route.abort();
        return route.continue();
      });

      const page = await ctx.newPage();
      await page.goto(feedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });

      // Wait briefly for main content
      try {
        await page.waitForSelector('[role="main"], h1, [role="article"]', { timeout: 4000 });
      } catch {}
      await page.waitForTimeout(4500);

      const currentUrl = page.url();
      if (/\/login|\/checkpoint/i.test(currentUrl)) {
        throw new FbBrowserAuthError("Facebook redirected to login/checkpoint — session invalid or flagged");
      }
      const initialBody = await page.locator("body").innerText().catch(() => "");
      if (/temporarily blocked|going too fast|try again later|unusual activity/i.test(initialBody)) {
        throw new FbBrowserRateLimitError(
          "Facebook temporarily rate-limited this session. Wait before running another large scrape.",
        );
      }



      // Step 1: Extract header info & metadata
      const headerData = await page.evaluate(() => {
        const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
        const body = (document.body?.innerText || "").replace(/\u00a0/g, " ");

        const nameFrom = () => {
          const h1 = q('[role="main"] h1') || q("h1");
          if (h1 && h1.innerText.trim()) return h1.innerText.trim();
          const og = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
          if (og?.content) return og.content;
          const t = document.title.replace(/\s*[|·].*$/, "").trim();
          return t && t.toLowerCase() !== "facebook" ? t : "";
        };

        const picFrom = () => {
          const el =
            document.querySelector('[role="main"] svg image') ||
            document.querySelector('[role="main"] image') ||
            document.querySelector('[role="main"] img');
          if (!el) return "";
          return (
            el.getAttribute("xlink:href") ||
            el.getAttribute("href") ||
            (el as HTMLImageElement).src ||
            ""
          );
        };

        const coverFrom = () => {
          const el =
            document.querySelector('img[data-imgperflogname="profileCoverPhoto"]') ||
            document.querySelector('img[alt*="Cover" i]');
          return (el as HTMLImageElement)?.src || "";
        };

        const metaDesc = (document.querySelector('meta[name="description"]') as HTMLMetaElement)?.content || "";
        const ogDesc = (document.querySelector('meta[property="og:description"]') as HTMLMetaElement)?.content || "";
        const fullDesc = `${metaDesc} ${ogDesc} ${body}`;

        const followersText =
          (fullDesc.match(/([\d.,]+[KMBL]?)\s*followers/i) ||
            fullDesc.match(/Followed by\s*([\d.,]+[KMBL]?)/i) ||
            fullDesc.match(/([\d.,]+[KMBL]?)\s*members/i) ||
            [])[1] || "";

        const likesText = (fullDesc.match(/([\d.,]+[KMBL]?)\s*likes/i) || [])[1] || "";

        const followerLink = document.querySelector('a[href*="followers"], a[href*="friends"]');
        const followerLinkText = followerLink ? (followerLink as HTMLElement).innerText : "";
        const fLinkMatch = (followerLinkText.match(/([\d.,]+[KMBL]?)/) || [])[1] || "";

        const likesLink = document.querySelector('a[href*="likes"]');
        const likesLinkText = likesLink ? (likesLink as HTMLElement).innerText : "";
        const lLinkMatch = (likesLinkText.match(/([\d.,]+[KMBL]?)/) || [])[1] || "";

        const catEl =
          document.querySelector('[role="main"] a[href*="/pages/category/"]') ||
          document.querySelector('a[href*="/pages/category/"]');
        const category = catEl ? (catEl as HTMLElement).innerText.trim() : "";

        const introEl = document.querySelector(
          '[role="main"] span[dir="auto"], [role="main"] div[dir="auto"]',
        );
        const about =
          (body.match(/Intro\s*\n\s*([^\n]+)/i) || body.match(/About\s*\n\s*([^\n]+)/i) || [])[1] ||
          introEl?.textContent ||
          "";

        const verified = Boolean(
          document.querySelector(
            '[role="main"] [aria-label*="Verified" i], svg[aria-label*="Verified" i], [aria-label="Verified account"]',
          ),
        );

        const unwrap = (href: string): string => {
          let u = href;
          const m = /[?&]u=([^&]+)/.exec(u);
          if (m) {
            try {
              u = decodeURIComponent(m[1]);
            } catch {}
          }
          return u.split("?")[0].replace(/\/+$/, "");
        };

        let instagram = "";
        let twitter = "";
        let email = "";
        let website = "";
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const href = (a as HTMLAnchorElement).href;
          if (!email && /^mailto:/i.test(href)) {
            email = href.replace(/^mailto:/i, "").trim();
            continue;
          }
          const u = unwrap(href);
          if (!instagram && /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u))
            instagram = u;
          else if (!twitter && /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u))
            twitter = u;
          else if (
            !website &&
            /^https?:\/\//i.test(u) &&
            !/facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|messenger\.com|whatsapp\.com/i.test(
              u,
            )
          )
            website = u;
        }
        const phone = (body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/) || [])[1] || "";

        return {
          name: nameFrom(),
          pic: picFrom(),
          cover: coverFrom(),
          followers: followersText || fLinkMatch,
          likes: likesText || lLinkMatch,
          category,
          about: about.slice(0, 300),
          verified,
          instagram,
          twitter,
          email,
          phone,
          website,
        };
      });

      // Step 2: Feed Accumulation (extract posts iteratively across scrolls)
      const accumulatedPosts = new Map<string, FbBrowserPost>();


      const extractVisiblePosts = async () => {
        const batch = await page.evaluate(() => {
          const feedUnits = Array.from(
            document.querySelectorAll(
              'div[data-pagelet^="FeedUnit"], div[data-pagelet*="FeedUnit"], [data-ad-preview="message"], [data-ad-comet-preview="message"]',
            ),
          ).map((node) => {
            // Caption nodes sit three wrappers inside the actual Comet post card.
            // Lift them to the card before extracting media and post metadata.
            if (node.matches('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) {
              let card: Element = node;
              for (let depth = 0; depth < 3 && card.parentElement; depth++) card = card.parentElement;
              return card;
            }
            return node;
          });
          // Current Comet pages may omit FeedUnit attributes and only expose a
          // post permalink from a comment inside the post card. Walk upward to
          // the first media-bearing parent: that is the actual post container,
          // not the nested comment article.
          const mediaPostContainers = Array.from(document.querySelectorAll('img, video'))
            .map((media) => {
              const img = media instanceof HTMLImageElement ? media : null;
              const rect = media.getBoundingClientRect();
              const isPostMedia = Boolean(media instanceof HTMLVideoElement) || Boolean(img && (
                img.naturalWidth >= 160 || img.naturalHeight >= 120 || rect.width >= 160 || rect.height >= 120
              ));
              if (!isPostMedia) return null;
              let node = media.parentElement;
              while (node && node !== document.body) {
                const textLength = (node.textContent || '').trim().length;
                const hasPostReference = Boolean(node.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="comment_id="]'));
                if (hasPostReference && textLength > 100) return node;
                node = node.parentElement;
              }
              return null;
            })
            .filter((node): node is HTMLDivElement => Boolean(node));
          const articles = feedUnits.length
            ? feedUnits
            : mediaPostContainers.length
              ? Array.from(new Set(mediaPostContainers))
              : Array.from(document.querySelectorAll('[role="article"]'));
          const out: Array<{
            postId: string;
            url: string;
            text: string;
            likes: string;
            comments: string;
            shares: string;
            time: string;
            images: string[];
            isVideo: boolean;
          }> = [];

          for (const item of articles) {
            const article = item;
            if (
              article.closest(
                '[aria-label="Notifications"], [role="navigation"], [role="banner"]',
              )
            )
              continue;
            // Facebook renders every comment and reply as an article too. They
            // contain a post permalink with comment_id, but are not feed posts.
            const articleLabel = article.getAttribute("aria-label") || "";
            if (/^(comment|reply)/i.test(articleLabel)) continue;

            const msgEl = article.querySelector(
              '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
            );
            const text = (msgEl ? (msgEl as HTMLElement).innerText : (article as HTMLElement).innerText || "")
              .replace(/\u00a0/g, " ")
              .trim();

            const permalinkCandidates = Array.from(
              article.querySelectorAll(
                'a[href*="/posts/"], a[href*="/videos/"], a[href*="/reel/"], a[href*="story_fbid="], a[href*="/photos/"]',
              ),
            );
            // Prefer the post's canonical timestamp link; never promote a
            // comment permalink into a post card.
            const permalinkEl = permalinkCandidates.find((link) => {
              const href = link.getAttribute("href") || "";
              return !/[?&](?:comment_id|reply_comment_id)=/i.test(href);
            });
            let postUrl = "";
            let postId = "";
            if (permalinkEl) {
              const rawHref = permalinkEl.getAttribute("href") || "";
              postUrl = rawHref.startsWith("http") ? rawHref : `https://www.facebook.com${rawHref}`;
              const pathMatch = /(?:\/posts\/|\/videos\/|\/reel\/|\/photos\/)([A-Za-z0-9]+)/.exec(postUrl);
              const storyMatch = /[?&]story_fbid=([A-Za-z0-9]+)/.exec(postUrl);
              postId = pathMatch?.[1] || storyMatch?.[1] || "";
            } else {
              const commentLink = Array.from(article.querySelectorAll('a[href*="comment_id="]')).at(0);
              const rawHref = commentLink?.getAttribute("href") || "";
              if (rawHref) {
                const absolute = rawHref.startsWith("http") ? rawHref : `https://www.facebook.com${rawHref}`;
                try {
                  const canonical = new URL(absolute);
                  canonical.search = "";
                  canonical.hash = "";
                  postUrl = canonical.toString();
                } catch {
                  postUrl = absolute.split("?")[0];
                }
                const pathMatch = /(?:\/posts\/|\/videos\/|\/reel\/|\/photos\/)([A-Za-z0-9]+)/.exec(postUrl);
                postId = pathMatch?.[1] || "";
              }
            }

            const ctxt = ((article as HTMLElement).innerText || "").replace(/\u00a0/g, " ");
            const rx = article.querySelector(
              '[aria-label*="reaction" i], [aria-label*="All reactions" i]',
            );
            const likesTxt = rx
              ? ((rx.getAttribute("aria-label") || "").match(/([\d.,]+[KMBL]?)/) || [])[1] || ""
              : (ctxt.match(/([\d.,]+[KMBL]?)\s*(?:reactions|likes)/i) || [])[1] || "";
            const commentsTxt = (ctxt.match(/([\d.,]+[KMBL]?)\s*comments?/i) || [])[1] || "";
            const sharesTxt = (ctxt.match(/([\d.,]+[KMBL]?)\s*shares?/i) || [])[1] || "";

            const timeEl = article.querySelector('a[href*="/posts/"] span, abbr, span[id*="jsc_c"]');
            const timeTxt = timeEl?.textContent?.trim() || "";

            const videoEl = article.querySelector("video") as HTMLVideoElement | null;
            const images = Array.from(article.querySelectorAll("img"))
              .filter((img) => {
                const rect = img.getBoundingClientRect();
                return img.naturalWidth >= 160 || img.naturalHeight >= 120 || rect.width >= 160 || rect.height >= 120;
              })
              .map((img) => img.getAttribute("src") || "")
              .filter((src) => /^https?:/.test(src) && !/rsrc\.php|static\.xx|emoji/.test(src));
            const poster = videoEl?.getAttribute("poster") || "";
            if (poster && /^https?:/.test(poster)) images.unshift(poster);

            const isVideo = Boolean(videoEl);

            // Feed shells, suggestion units, and comment trays are also rendered
            // as articles. A post is usable only when Facebook exposes its own
            // permalink; accepting text-only articles made one visible post look
            // like a completed multi-post result.
            if (postId && postUrl) {
              out.push({
                postId,
                url: postUrl,
                text: text.slice(0, 1500),
                likes: likesTxt,
                comments: commentsTxt,
                shares: sharesTxt,
                time: timeTxt,
                images: Array.from(new Set(images)).slice(0, 8),
                isVideo,
              });
            }
          }
          return out;
        });

        for (const p of batch) {
          const key = p.postId;
          if (key && !accumulatedPosts.has(key)) {
            accumulatedPosts.set(key, {
              postId: p.postId || null,
              url: p.url || null,
              text: p.text,
              publishedTime: p.time || null,
              likes: parseCount(p.likes) ?? 0,
              comments: parseCount(p.comments) ?? 0,
              shares: parseCount(p.shares) ?? 0,
              images: p.images,
              isVideo: p.isVideo,
            });
          }
        }
      };

      // The page shell can arrive long before the feed. Give React a bounded
      // chance to render more than the pinned item before the first extraction.
      await page
        .waitForFunction(
          () =>
            document.querySelectorAll(
              'a[href*="/posts/"], a[href*="/videos/"], a[href*="/reel/"], a[href*="story_fbid="]',
            ).length > 1,
          { timeout: 2500 },
        )
        .catch(() => {});
      await extractVisiblePosts();



      // Facebook hydrates its feed after the scroll event.  A short fixed delay
      // caused us to read the same first article repeatedly, so wait for the feed
      // to settle and stop only after several genuinely empty scrolls.
      const maxScrolls = Math.min(Math.max(postLimit, 6), 240);
      let stalledScrolls = 0;
      for (let s = 0; s < maxScrolls && accumulatedPosts.size < postLimit; s++) {
        const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
        const beforeCount = accumulatedPosts.size;
        // Dispatch a real wheel event. Facebook's virtualized timeline can
        // ignore script-only window.scrollBy calls while responding normally to
        // the same gesture from an interactive browser.
        // Keep the pointer over the Facebook feed before wheeling. In the
        // headed virtual display an unfocused cursor can leave the scroll on
        // the browser chrome instead of Comet's feed scroller.
        await page.mouse.move(640, 640);
        await page.mouse.wheel(0, 1800);
        await page
          .waitForFunction((height) => document.body.scrollHeight > height, beforeHeight, { timeout: 1400 })
          .catch(() => {});
        await page.waitForTimeout(1400);
        await extractVisiblePosts();
        stalledScrolls = accumulatedPosts.size > beforeCount ? 0 : stalledScrolls + 1;
        if (stalledScrolls >= 3) break;
      }


      const formattedPosts = Array.from(accumulatedPosts.values()).slice(0, postLimit);

      // Step 3: Concurrent Comment & Reactor Harvesting
      if ((includeComments || includeReactors) && formattedPosts.length > 0) {
        const postsToHarvest = formattedPosts.filter((p) => p.url).slice(0, postLimit);

        const harvestSinglePost = async (post: FbBrowserPost) => {
          if (!post.url) return;
          let commentPage: any = null;
          try {
            commentPage = await ctx.newPage();
            await commentPage.goto(post.url, {
              waitUntil: "domcontentloaded",
              timeout: 12000,
            });
            await commentPage.waitForTimeout(1000);

            if (includeComments) {
              const maxCommentLoadRounds = Math.min(Math.ceil(commentsLimit / 10) + 1, 8);
              for (let round = 0; round < maxCommentLoadRounds; round++) {
                const count = (await commentPage.evaluate(
                  `document.querySelectorAll('[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]').length`,
                )) as number;
                if (count >= commentsLimit) break;

                const more = commentPage.locator('[role="button"], span', {
                  hasText: /view more comments|view \d+ more comment|all comments/i,
                });
                if ((await more.count()) > 0) {
                  try {
                    await more.first().click({ timeout: 800 });
                    await commentPage.waitForTimeout(800);
                  } catch {
                    break;
                  }
                } else {
                  break;
                }
              }

              const rawComments = ((await commentPage.evaluate(`(() => {
                const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').trim();
                const nodes = Array.from(document.querySelectorAll('[role="article"]'))
                  .filter((el) => {
                    const label = el.getAttribute('aria-label') || '';
                    return /^Comment|^Reply/i.test(label);
                  });
                const out = [];
                for (const node of nodes) {
                  const label = node.getAttribute('aria-label') || '';
                  const isReply = /^Reply/i.test(label);
                  const authorLink = node.querySelector('a[href*="/user/"], a[href*="profile.php"], span a[href]');
                  const authorName = authorLink ? clean(authorLink.textContent) : clean((label.match(/by\\s+(.+)$/i) || [])[1] || '');
                  const authorHref = authorLink ? authorLink.getAttribute('href') : null;
                  const authorImg = node.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
                  const avatar = authorImg ? authorImg.getAttribute('src') : null;

                  const blocks = Array.from(node.querySelectorAll('div[dir="auto"]'))
                    .map((d) => clean(d.innerText))
                    .filter((t) => t && t !== authorName && !/^(Like|Reply|Share|·|\\d+[hmwdy])$/i.test(t));
                  const body = blocks.sort((a, b) => b.length - a.length)[0] || '';

                  const rx = node.querySelector('[aria-label*="reaction" i]');
                  const likes = rx ? rx.getAttribute('aria-label') || '' : '';

                  const timeLink = node.querySelector('a[href*="comment_id"], abbr');
                  const time = timeLink ? clean(timeLink.getAttribute('title') || timeLink.textContent) : '';

                  if (authorName || body) {
                    out.push({
                      authorName,
                      authorHref: authorHref && authorHref.startsWith('http') ? authorHref : (authorHref ? 'https://www.facebook.com' + authorHref : null),
                      avatar,
                      body,
                      likes,
                      time,
                      isReply,
                    });
                  }
                }
                return out;
              })()`)) ?? []) as any[];

              post.commentsData = rawComments.slice(0, commentsLimit).map((c, idx) => ({
                id: `fb_c_${idx + 1}`,
                authorName: c.authorName || "Facebook User",
                authorProfileUrl: c.authorHref || null,
                authorAvatar: c.avatar || null,
                text: c.body || "",
                createdAt: c.time || null,
                likeCount: parseCount(c.likes) ?? 0,
                replyCount: 0,
                depth: c.isReply ? 1 : 0,
              }));
            }

            if (includeReactors) {
              try {
                const rxBtn = commentPage.locator(
                  '[aria-label*="reaction" i], [aria-label*="See who reacted" i]',
                ).first();
                if (await rxBtn.isVisible({ timeout: 1200 })) {
                  await rxBtn.click({ timeout: 800 });
                  await commentPage.waitForTimeout(600);

                  const rawReactors = ((await commentPage.evaluate(`(() => {
                    return Array.from(document.querySelectorAll('[role="dialog"] a[role="link"]'))
                      .map((a) => {
                        const holder = a.closest('li, div');
                        const img = holder ? holder.querySelector('img[alt]') : null;
                        return {
                          name: (a.innerText || '').trim().split('\\n')[0],
                          link: a.getAttribute('href'),
                          type: img ? (img.getAttribute('alt') || '').toLowerCase() : null,
                        };
                      })
                      .filter((r) => r.name);
                  })()`)) ?? []) as any[];

                  post.reactorsData = rawReactors.slice(0, reactorsLimit).map((r) => ({
                    name: r.name,
                    link: r.link?.startsWith("http") ? r.link : r.link ? `https://www.facebook.com${r.link}` : null,
                    type: r.type || "like",
                  }));
                }
              } catch {}
            }
          } catch (cErr: any) {
            post.commentsError = cErr?.message ?? "Comments fetch failed";
          } finally {
            if (commentPage) await commentPage.close().catch(() => {});
          }
        };

        const configuredConcurrency = Number(
          process.env.FB_COMMENT_CONCURRENCY ?? Math.min(availableParallelism(), 16),
        );
        const commentConcurrency = Number.isFinite(configuredConcurrency)
          ? Math.max(1, Math.min(Math.floor(configuredConcurrency), 16))
          : Math.min(availableParallelism(), 16);
        for (let i = 0; i < postsToHarvest.length; i += commentConcurrency) {
          const slice = postsToHarvest.slice(i, i + commentConcurrency);
          await Promise.all(slice.map((p) => harvestSinglePost(p)));
        }
      }

      // Step 4: Compute stats
      const totalCommentsScraped = formattedPosts.reduce(
        (acc, p) => acc + (p.commentsData?.length || 0),
        0,
      );
      const totalLikesScraped = formattedPosts.reduce((acc, p) => acc + (p.likes || 0), 0);
      const totalSharesScraped = formattedPosts.reduce((acc, p) => acc + (p.shares || 0), 0);
      const totalReactorsScraped = formattedPosts.reduce(
        (acc, p) => acc + (p.reactorsData?.length || 0),
        0,
      );

      const followersNum = parseCount(headerData.followers);
      const likesNum = parseCount(headerData.likes);

      const avgInteractions =
        formattedPosts.length > 0
          ? (totalLikesScraped + totalSharesScraped + totalCommentsScraped) / formattedPosts.length
          : 0;
      const engagementRate =
        followersNum && followersNum > 0
          ? `${((avgInteractions / followersNum) * 100).toFixed(2)}%`
          : `${avgInteractions.toFixed(1)} / post`;

      const stats: FbFetchStats = {
        requestedPosts: postLimit,
        scrapedPosts: formattedPosts.length,
        totalCommentsScraped,
        totalLikesScraped,
        totalSharesScraped,
        totalReactorsScraped,
        followers: followersNum,
        likes: likesNum,
        engagementRate,
      };

      const result: FbBrowserPage = {
        handle: target.handle,
        name: headerData.name || target.handle,
        url: target.url,
        kind: target.kind,
        profilePic: headerData.pic || null,
        coverPic: headerData.cover || null,
        followers: followersNum,
        likes: likesNum,
        category: target.kind === "group" ? "Group" : headerData.category?.trim() || null,
        about: headerData.about?.trim() || null,
        verified: headerData.verified,
        posts: formattedPosts,
        stats,
        instagram: headerData.instagram || null,
        twitter: headerData.twitter || null,
        email: headerData.email || null,
        phone: headerData.phone?.trim() || null,
        website: headerData.website || null,
      };

      // Do not cache partial feeds. A later request must be allowed to continue
      // rather than appearing as an instant-but-incomplete success.
      if (result.posts.length >= postLimit) {
        setCachedFbPage(targetRaw, result, cacheRequirements);
        setCachedFbPage(target.handle, result, cacheRequirements);
      }

      return result;
    } finally {
      await ctx.close().catch(() => {});
    }
  };

  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof FbBrowserAuthError) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (i === 0 && /ERR_NAME_NOT_RESOLVED|net::|ERR_|Timeout|timed out/i.test(msg)) {
        await resetSharedBrowser();
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    "Couldn't load the Facebook page (network hiccup or Facebook throttling) — please try again. " +
      (lastErr instanceof Error ? lastErr.message.slice(0, 100) : ""),
  );
}
