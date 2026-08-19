/**
 * Browser-backed Facebook scraping (Playwright + Chromium).
 *
 * This is the slow-but-reliable path. Where mbasic gets rewritten out from
 * under us and GraphQL doc_ids go stale, rendering the real page as a genuine
 * Chrome keeps working — we read exactly what a person browsing would see.
 *
 * Covers the three surfaces the HTTP paths can't reach reliably:
 *   - a page/profile timeline, scroll-paginated into structured posts
 *   - a post permalink's comments, including expanded reply threads
 *   - a post's reactor list with per-reaction breakdown
 *
 * NOTE: against Meta ToS; ~3–10s per surface. Use a throwaway account.
 */
import { withFacebookContext, resetSharedBrowser } from "./browser-pool";
import {
  assertUsableCookies,
  FbScrapeAuthError,
  normalizeCookies,
  parseCount,
  type FbScrapedComment,
  type FbScrapedPost,
  type FbScrapedReactor,
} from "./scraper-types";

const NAV_TIMEOUT_MS = 45_000;
/** Facebook hydrates the feed lazily; give it a beat after each scroll. */
const SETTLE_MS = 2_200;

function assertNotBounced(url: string): void {
  if (/\/login|\/checkpoint/i.test(url)) {
    throw new FbScrapeAuthError("Facebook redirected to login/checkpoint — session invalid or flagged");
  }
}

/**
 * Serialized in the page: pull post-shaped records off the live DOM.
 * Kept as a standalone function so it stays readable despite running in
 * a different realm (no imports/closures available inside).
 */
/**
 * Takes the target handle: a profile page also renders the notifications tray,
 * whose entries are ALSO role="article" and carry other users' comment
 * permalinks. Without an ownership filter those get scraped as if they were the
 * profile's posts.
 */
const POST_EXTRACTOR = `(handle) => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').trim();
  const articles = Array.from(document.querySelectorAll('[role="article"]'));
  const out = [];
  const seen = new Set();

  const ownsPermalink = (href) => {
    if (!href) return false;
    if (/comment_id=/.test(href)) return false;           // a comment, not a post
    if (!/\\/(posts|videos|reel|photo)\\//.test(href) && !/story_fbid=/.test(href)) return false;
    if (!handle) return true;
    // The owner segment must match the profile we asked for.
    const m = /facebook\\.com\\/([A-Za-z0-9.]+)\\/(?:posts|videos|reel|photo)\\//.exec(href);
    if (m) return m[1].toLowerCase() === String(handle).toLowerCase();
    return /story_fbid=/.test(href);
  };

  for (const article of articles) {
    // Reply/comment nodes are also role=article — skip nested ones.
    if (article.parentElement && article.parentElement.closest('[role="article"]')) continue;
    // Skip anything rendered inside the notifications tray or a dialog.
    if (article.closest('[aria-label="Notifications"], [role="dialog"], [role="navigation"], [role="banner"]')) continue;

    const messageEl = article.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
    const text = clean(messageEl ? messageEl.innerText : '');
    const whole = clean(article.innerText);
    if (!text && whole.length < 40) continue;

    const permalink = (() => {
      const links = Array.from(article.querySelectorAll('a[href]'));
      for (const a of links) {
        const raw = a.getAttribute('href') || '';
        const abs = raw.startsWith('http') ? raw : 'https://www.facebook.com' + raw;
        if (ownsPermalink(abs)) return abs.split('?')[0];   // drop tracking query
      }
      return null;
    })();
    // A profile post without its own permalink is almost always chrome.
    if (!permalink) continue;

    const postId = (() => {
      if (!permalink) return '';
      const m = /(?:\\/posts\\/|story_fbid=|\\/videos\\/|\\/reel\\/)([A-Za-z0-9]+)/.exec(permalink);
      return m ? m[1] : '';
    })();

    const key = postId || permalink || text.slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const images = Array.from(article.querySelectorAll('img'))
      .map((img) => img.getAttribute('src') || '')
      .filter((src) => /^https?:/.test(src) && !/rsrc\\.php|static\\.xx|emoji/.test(src) && (img => true)(src));

    const timeEl = article.querySelector('a[href*="/posts/"] span[title], abbr[data-utime], [data-tooltip-content]');
    const timeLabel = timeEl
      ? clean(timeEl.getAttribute('title') || timeEl.getAttribute('data-tooltip-content') || timeEl.textContent)
      : '';
    const utime = article.querySelector('abbr[data-utime]');

    const reactionEl = article.querySelector('[aria-label*="reaction" i], [aria-label*="All reactions" i]');
    const reactionLabel = reactionEl ? reactionEl.getAttribute('aria-label') || reactionEl.innerText : '';

    const outbound = (() => {
      const links = Array.from(article.querySelectorAll('a[href^="https://l.facebook.com"], a[href^="/l.php"], a[href^="http"]'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (/l\\.facebook\\.com|\\/l\\.php/.test(href)) {
          try {
            const u = new URL(href, 'https://www.facebook.com').searchParams.get('u');
            if (u) return decodeURIComponent(u);
          } catch (e) { /* ignore */ }
        } else if (/^https?:\\/\\//.test(href) && !/facebook\\.com|fbcdn\\.net/.test(href)) {
          return href;
        }
      }
      return null;
    })();

    const authorLink = article.querySelector('h2 a[href], h3 a[href], strong a[href]');

    out.push({
      postId,
      text: text || whole.slice(0, 2000),
      permalink,
      images: Array.from(new Set(images)).slice(0, 12),
      timeLabel,
      utime: utime ? utime.getAttribute('data-utime') : null,
      reactionLabel,
      commentsLabel: (whole.match(/([\\d.,]+[KMB]?)\\s*comments?/i) || [])[1] || '',
      sharesLabel: (whole.match(/([\\d.,]+[KMB]?)\\s*shares?/i) || [])[1] || '',
      isLive: /\\bLIVE\\b/.test(whole),
      link: outbound,
      authorName: authorLink ? clean(authorLink.textContent) : '',
      authorHref: authorLink ? authorLink.getAttribute('href') : null,
      hasVideo: !!article.querySelector('video'),
      videoSrc: (() => { const v = article.querySelector('video'); return v ? v.getAttribute('src') : null; })(),
    });
  }
  return out;
}`;

const COMMENT_EXTRACTOR = `() => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').trim();
  // Comment nodes are role=article elements nested inside the post's comment tray.
  const nodes = Array.from(document.querySelectorAll('[role="article"]'))
    .filter((el) => {
      const label = el.getAttribute('aria-label') || '';
      return /^Comment|^Reply/i.test(label);
    });

  const out = [];
  const seen = new Set();
  for (const node of nodes) {
    const label = node.getAttribute('aria-label') || '';
    const isReply = /^Reply/i.test(label);

    const authorLink = node.querySelector('a[href*="/user/"], a[href*="profile.php"], span a[href]');
    const authorName = authorLink ? clean(authorLink.textContent) : clean((label.match(/by\\s+(.+)$/i) || [])[1] || '');
    const authorHref = authorLink ? authorLink.getAttribute('href') : null;

    // The comment body is the longest text block that is not the author name.
    const blocks = Array.from(node.querySelectorAll('div[dir="auto"]'))
      .map((d) => clean(d.innerText))
      .filter((t) => t && t !== authorName && !/^(Like|Reply|Share|·|\\d+[hmwdy])$/i.test(t));
    const body = blocks.sort((a, b) => b.length - a.length)[0] || '';

    const timeLink = node.querySelector('a[href*="comment_id"], abbr');
    const permalink = timeLink ? timeLink.getAttribute('href') : null;
    const commentId = permalink ? (/comment_id=([\\d]+)/.exec(permalink) || [])[1] || '' : '';

    const key = commentId || (authorName + ':' + body.slice(0, 80));
    if (!key.trim() || seen.has(key)) continue;
    if (!authorName && !body) continue;
    seen.add(key);

    const reactionEl = node.querySelector('[aria-label*="reaction" i]');

    out.push({
      commentId,
      permalink: permalink && permalink.startsWith('http') ? permalink : (permalink ? 'https://www.facebook.com' + permalink : null),
      authorName,
      authorHref: authorHref && authorHref.startsWith('http') ? authorHref : (authorHref ? 'https://www.facebook.com' + authorHref : null),
      body,
      timeLabel: timeLink ? clean(timeLink.getAttribute('title') || timeLink.textContent) : '',
      reactionLabel: reactionEl ? (reactionEl.getAttribute('aria-label') || '') : '',
      image: (() => { const img = node.querySelector('img[src*="scontent"]'); return img ? img.getAttribute('src') : null; })(),
      isReply,
      badge: (() => {
        const b = node.querySelector('[aria-label*="contributor" i], [aria-label*="Author" i]');
        return b ? clean(b.getAttribute('aria-label')) : null;
      })(),
    });
  }
  return out;
}`;

function toIso(label: string | null, utime?: string | null): string | null {
  if (utime && Number.isFinite(Number(utime))) return new Date(Number(utime) * 1000).toISOString();
  if (!label) return null;
  const parsed = Date.parse(label);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : label;
}

export interface BrowserPostsOptions {
  /** Scroll rounds; each surfaces roughly 3–8 more posts. */
  scrolls?: number;
  limit?: number;
}

/** Scroll a timeline and return structured posts. */
export async function scrapePostsViaBrowser(
  handle: string,
  cookiesRaw: string,
  options: BrowserPostsOptions = {},
): Promise<FbScrapedPost[]> {
  const { scrolls = 4, limit = 30 } = options;
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const target = handle.startsWith("http")
    ? handle
    : `https://www.facebook.com/${encodeURIComponent(handle.replace(/^\/+/, ""))}`;
  const fetchedAt = new Date().toISOString();
  // The bare handle drives the ownership filter inside the extractor.
  const ownerHandle =
    /facebook\.com\/([A-Za-z0-9.]+)/i.exec(target)?.[1] ?? handle.replace(/^\/+|\/+$/g, "");

  const run = async () =>
    withFacebookContext(cookie, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS + 1500);
      assertNotBounced(page.url());

      // The feed hydrates well after DOMContentLoaded. Extracting too early
      // yields only the notifications tray, so wait for a real post permalink
      // and nudge the page if none has appeared.
      for (let wait = 0; wait < 4; wait++) {
        const hasPosts = (await page.evaluate(
          `document.querySelectorAll('a[href*="/posts/"], a[href*="/videos/"], a[href*="/reel/"]').length`,
        )) as number;
        if (hasPosts > 0) break;
        await page.evaluate("window.scrollBy(0, window.innerHeight)");
        await page.waitForTimeout(SETTLE_MS);
      }

      let raw: any[] = [];
      for (let i = 0; i < Math.max(1, scrolls); i++) {
        // page.evaluate(string) evaluates an EXPRESSION, so a bare "() => {…}"
        // string yields the function itself and never runs. Every extractor
        // must therefore be invoked as an IIFE.
        raw = ((await page.evaluate(
          `(${POST_EXTRACTOR})(${JSON.stringify(ownerHandle)})`,
        )) ?? []) as any[];
        if (raw.length >= limit) break;
        await page.evaluate("window.scrollBy(0, window.innerHeight * 2)");
        await page.waitForTimeout(SETTLE_MS);
      }

      if (!raw.length) {
        const bodyLength = (await page.evaluate("(document.body && document.body.innerText || '').length")) as number;
        if (bodyLength < 400) {
          throw new FbScrapeAuthError("Facebook returned an empty page — session may be invalid or the page is blocked");
        }
      }
      return raw.slice(0, limit);
    });

  let raw: any[];
  try {
    raw = await run();
  } catch (err) {
    if (err instanceof FbScrapeAuthError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!/net::|ERR_|Timeout|timed out|Target closed/i.test(message)) throw err;
    // One retry on a transient network/browser fault.
    await resetSharedBrowser();
    raw = await run();
  }

  return raw.map((r) => {
    const images: string[] = r.images ?? [];
    const reactionCount = parseCount(/([\d.,]+[KMB]?)/.exec(r.reactionLabel ?? "")?.[1]) ?? 0;
    return {
      postId: r.postId ?? "",
      text: r.text ?? "",
      postText: r.text ?? "",
      sharedText: "",
      time: toIso(r.timeLabel, r.utime),
      postUrl: r.permalink ?? null,
      image: images[0] ?? null,
      images,
      video: r.videoSrc ?? null,
      videoId: null,
      videoThumbnail: r.hasVideo ? images[0] ?? null : null,
      isLive: Boolean(r.isLive),
      link: r.link ?? null,
      likes: reactionCount,
      comments: parseCount(r.commentsLabel) ?? 0,
      shares: parseCount(r.sharesLabel) ?? 0,
      reactions: {},
      reactionCount,
      userId: /profile\.php\?id=(\d+)/.exec(r.authorHref ?? "")?.[1] ?? null,
      username: r.authorName || null,
      sharedPostId: null,
      sharedPostUrl: null,
      sharedUserId: null,
      sharedUsername: null,
      available: true,
      fetchedAt,
      source: "browser" as const,
    };
  });
}

export interface BrowserCommentsOptions {
  limit?: number;
  withReplies?: boolean;
  /** "all" switches the tray off Facebook's default "most relevant" filter. */
  ordering?: "all" | "newest" | "relevant";
}

/**
 * Open a post permalink, widen the comment filter, expand every "view more"
 * control it can find, and read the tray.
 */
export async function scrapeCommentsViaBrowser(
  postUrl: string,
  cookiesRaw: string,
  options: BrowserCommentsOptions = {},
): Promise<FbScrapedComment[]> {
  const { limit = 50, withReplies = true, ordering = "all" } = options;
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const target = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com/${postUrl}`;

  const raw = await withFacebookContext(cookie, async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS + 1500);
    assertNotBounced(page.url());

    // Facebook defaults to "Most relevant", which hides the long tail.
    if (ordering !== "relevant") {
      const wanted = ordering === "newest" ? /newest/i : /all comments/i;
      try {
        const selector = page.locator('[role="button"]', { hasText: /most relevant|all comments|newest/i }).first();
        if (await selector.isVisible({ timeout: 3000 })) {
          await selector.click({ timeout: 3000 });
          await page.waitForTimeout(900);
          const option = page.locator('[role="menuitem"], [role="menuitemradio"]', { hasText: wanted }).first();
          if (await option.isVisible({ timeout: 3000 })) {
            await option.click({ timeout: 3000 });
            await page.waitForTimeout(SETTLE_MS);
          }
        }
      } catch {
        /* ordering is a nicety, not a requirement */
      }
    }

    // Expand: "View more comments" first, then reply threads.
    for (let round = 0; round < 10; round++) {
      const count = (await page.evaluate(
        `document.querySelectorAll('[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]').length`,
      )) as number;
      if (count >= limit) break;

      const pattern = withReplies
        ? /view more comments|view \d+ more comment|view all \d+ replies|\d+ repl(y|ies)|previous comments/i
        : /view more comments|view \d+ more comment|previous comments/i;
      const more = page.locator('[role="button"], span', { hasText: pattern });

      let clicked = 0;
      const total = Math.min(await more.count(), 6);
      for (let i = 0; i < total; i++) {
        try {
          const node = more.nth(i);
          if (await node.isVisible({ timeout: 1000 })) {
            await node.click({ timeout: 2500 });
            clicked += 1;
            await page.waitForTimeout(1100);
          }
        } catch {
          /* the tray re-renders constantly; skip stale handles */
        }
      }
      if (!clicked) break;
      await page.waitForTimeout(SETTLE_MS);
    }

    return ((await page.evaluate(`(${COMMENT_EXTRACTOR})()`)) ?? []) as any[];
  });

  // Flat list → threaded: replies attach to the nearest preceding top-level comment.
  const comments: FbScrapedComment[] = [];
  let lastTopLevel: FbScrapedComment | null = null;

  for (const r of raw) {
    const comment: FbScrapedComment = {
      commentId: r.commentId ?? "",
      commentUrl: r.permalink ?? null,
      commenterId: /(?:profile\.php\?id=|\/user\/)(\d+)/.exec(r.authorHref ?? "")?.[1] ?? null,
      commenterName: r.authorName ?? "",
      commenterUrl: r.authorHref ?? null,
      commenterMeta: r.badge ?? null,
      commentText: r.body ?? "",
      commentTime: toIso(r.timeLabel),
      commentImage: r.image ?? null,
      commentReactionCount: parseCount(/([\d.,]+[KMB]?)/.exec(r.reactionLabel ?? "")?.[1]) ?? 0,
      replies: [],
      depth: r.isReply ? 1 : 0,
      source: "browser",
    };

    if (comment.depth === 1 && lastTopLevel) {
      lastTopLevel.replies.push(comment);
    } else {
      if (comments.length >= limit) break;
      comments.push(comment);
      lastTopLevel = comment;
    }
  }

  return comments;
}

const REACTION_KINDS = ["like", "love", "care", "haha", "wow", "sad", "angry"];

/** Open a post's reaction dialog and read who reacted, and with what. */
export async function scrapeReactorsViaBrowser(
  postUrl: string,
  cookiesRaw: string,
  options: { limit?: number } = {},
): Promise<{ reactors: FbScrapedReactor[]; breakdown: Record<string, number>; total: number }> {
  const { limit = 100 } = options;
  const { cookie } = normalizeCookies(cookiesRaw);
  assertUsableCookies(cookie);

  const target = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com/${postUrl}`;

  return withFacebookContext(cookie, async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS + 1000);
    assertNotBounced(page.url());

    const breakdown: Record<string, number> = {};
    let total = 0;
    let reactors: FbScrapedReactor[] = [];

    try {
      const trigger = page.locator('[aria-label*="reaction" i], [aria-label*="See who reacted" i]').first();
      if (!(await trigger.isVisible({ timeout: 4000 }))) {
        return { reactors, breakdown, total };
      }
      total = parseCount(/([\d.,]+[KMB]?)/.exec((await trigger.getAttribute("aria-label")) ?? "")?.[1]) ?? 0;
      await trigger.click({ timeout: 4000 });
      await page.waitForTimeout(SETTLE_MS);

      // The dialog's tabs read "Like 1.2K", "Love 340", …
      const tabs = ((await page.evaluate(
        `Array.from(document.querySelectorAll('[role="dialog"] [role="tab"]')).map(function (t) { return (t.getAttribute('aria-label') || t.innerText || '').trim(); })`,
      )) ?? []) as string[];
      for (const tab of tabs) {
        const kind = REACTION_KINDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(tab));
        const count = parseCount(/([\d.,]+[KMB]?)\s*$/.exec(tab.trim())?.[1] ?? /([\d.,]+[KMB]?)/.exec(tab)?.[1]);
        if (kind && count != null) breakdown[kind] = count;
      }

      for (let i = 0; i < 6; i++) {
        const seen = (await page.evaluate(
          `document.querySelectorAll('[role="dialog"] a[href*="facebook.com/"], [role="dialog"] a[role="link"]').length`,
        )) as number;
        if (seen >= limit) break;
        await page.evaluate(
          `(function () { var d = document.querySelector('[role="dialog"] div[style*="overflow"]') || document.querySelector('[role="dialog"]'); if (d) d.scrollTop = d.scrollHeight; })()`,
        );
        await page.waitForTimeout(1200);
      }

      reactors = (((await page.evaluate(
        `(function () {
          return Array.from(document.querySelectorAll('[role="dialog"] a[role="link"]'))
            .map(function (a) {
              var holder = a.closest('li, div');
              var img = holder ? holder.querySelector('img[alt]') : null;
              return {
                name: (a.innerText || '').trim().split('\\n')[0],
                link: a.getAttribute('href'),
                type: img ? (img.getAttribute('alt') || '').toLowerCase() : null,
              };
            })
            .filter(function (r) { return r.name; });
        })()`,
      )) ?? []) as any[])
        .slice(0, limit)
        .map((r) => ({
          name: r.name,
          link: r.link?.startsWith("http") ? r.link : r.link ? `https://www.facebook.com${r.link}` : null,
          type: REACTION_KINDS.find((k) => (r.type ?? "").includes(k)) ?? null,
        }));
    } catch {
      /* the reaction dialog is optional enrichment */
    }

    return { reactors, breakdown, total: total || Object.values(breakdown).reduce((a, b) => a + b, 0) };
  });
}
