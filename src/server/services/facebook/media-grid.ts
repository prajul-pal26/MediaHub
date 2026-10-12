import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { withFacebookContext } from "./browser-pool";
import { FbBrowserAuthError, FbBrowserRateLimitError, type FbBrowserPage, type FbBrowserPost } from "./browser-fetcher";

export type FacebookMediaType = "posts" | "reels";
type Retrieval = NonNullable<FbBrowserPage["retrieval"]>;
type Tile = { url: string; image: string; label: string; text: string };

/** Only owner collections, never a mixed feed, tagged photos or an individual post. */
export function mediaCollection(input: string, type: FacebookMediaType) {
  const raw = input.trim().replace(/^@/, "");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://www.facebook.com/${raw.replace(/^(?:www\.|m\.)?facebook\.com\//i, "")}`);
  if (!/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) throw new Error("Enter a Facebook page or profile URL.");
  const parts = url.pathname.split("/").filter(Boolean);
  let handle = parts[0];
  if (handle === "profile.php") handle = url.searchParams.get("id") ?? "";
  if (parts[0] === "people") handle = parts[2] ?? "";
  if (!handle || !/^[a-z\d._-]+$/i.test(handle) || /^(groups|reel|watch|photo|photo.php|videos|posts|login|share)$/i.test(handle)) {
    throw new Error("Use the page or profile address for its Photos or Reels collection.");
  }
  if (parts[1] && !["photos", "photos_by", "photos_of", "photos_albums", "reels", "reels_tab", "owner_reels", "about"].includes(parts[1]) && parts[0] !== "people") {
    throw new Error("Use the page or profile address, rather than an individual post link.");
  }
  const base = `https://www.facebook.com/${handle}`;
  return { handle, url: `${base}/`, collectionUrl: `${base}/${type === "posts" ? "photos" : "reels"}/` };
}

/** Preserve photo IDs from query strings; exclude header images and navigation. */
export function mediaTile(tile: Tile, type: FacebookMediaType): FbBrowserPost | null {
  if (!tile.image || /(?:profile|cover) (?:photo|picture)/i.test(tile.label)) return null;
  let url: URL;
  try { url = new URL(tile.url); } catch { return null; }
  if (!/^(?:www\.|m\.)?facebook\.com$/i.test(url.hostname)) return null;
  const reelId = /^\/reel\/(\d+)\/?$/.exec(url.pathname)?.[1];
  const photoId = /^\/photo(?:\.php|\/)?$/.test(url.pathname) ? url.searchParams.get("fbid") : null;
  const id = type === "reels" ? reelId : photoId;
  if (!id || !/^\d+$/.test(id)) return null;
  const count = type === "reels" ? /^(\d[\d,.]*)\s*([KMB])?(?:\s+views)?$/i.exec(tile.text.trim()) : null;
  const views = count ? Math.round(Number(count[1].replace(/,/g, "")) * ({ K: 1e3, M: 1e6, B: 1e9 }[count[2]?.toUpperCase() as "K" | "M" | "B"] ?? 1)) : null;
  return {
    postId: id,
    url: type === "reels" ? `https://www.facebook.com/reel/${id}/` : `https://www.facebook.com/photo.php?fbid=${id}`,
    mediaType: type === "reels" ? "reel" : "photo",
    // Grid image alt text is an accessibility description, not the post caption.
    text: "", publishedTime: null, images: [tile.image], isVideo: type === "reels",
    likes: 0, comments: 0, shares: 0, metricsAvailable: false, views,
  };
}

const snapshots = new Map<string, { expires: number; page: FbBrowserPage }>();
const pending = new Map<string, Promise<FbBrowserPage>>();
const CACHE_MS = 5 * 60_000;

export function mediaCacheKey(target: string, type: FacebookMediaType, limit: number, cookies: string) {
  // Never share a result across organization sessions or reuse it after cookies change.
  return createHash("sha256").update(JSON.stringify([target, type, limit, cookies])).digest("hex");
}

export function mediaOwnerName(title: string, fallback: string): string {
  const name = title.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook.*$/i, "").replace(/\s+(Reels|Photos)$/i, "").trim();
  return !name || /^(Facebook|Notifications)$/i.test(name) ? fallback : name;
}

async function checkAccess(page: Page) {
  const path = new URL(page.url()).pathname;
  if (/^\/(login|checkpoint|two_step_verification)(?:\/|\.php|$)/.test(path)) {
    throw new FbBrowserAuthError("Facebook requires sign-in or a session check.");
  }
  if (await page.locator('input[type="password"]').first().isVisible()) throw new FbBrowserAuthError("Facebook is showing a login prompt. Refresh the saved Facebook session in Settings before trying again.");
  const text = (await page.locator("body").innerText()).slice(0, 9000);
  if (/you're temporarily blocked|you’re temporarily blocked|we limit how often|going too fast/i.test(text)) {
    throw new FbBrowserRateLimitError("Facebook temporarily limited this session. Wait before trying another live fetch.");
  }
}

async function collectTiles(page: Page, type: FacebookMediaType): Promise<Tile[]> {
  return page.evaluate((kind) => {
    const selector = kind === "reels" ? 'a[href*="/reel/"]' : 'a[href*="fbid="]';
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(selector)).flatMap((a) => {
      const img = a.querySelector<HTMLImageElement>("img");
      const bounds = img?.getBoundingClientRect();
      if (!img || !bounds || bounds.width < 100 || bounds.height < 100) return [];
      if (a.closest('header, [role="banner"]')) return [];
      // The Photos grid uses square tiles; the profile cover is a wide header image.
      if (kind === "posts" && Math.abs(bounds.width / bounds.height - 1) > 0.15) return [];
      return [{ url: a.href, image: img.currentSrc || img.src, label: a.getAttribute("aria-label") ?? "", text: a.innerText }];
    });
  }, type);
}

/** Load the same dedicated collections that the user opens in Facebook's UI. */
export async function fetchFacebookMediaGrid(
  input: string,
  cookies: string,
  options: { contentType: FacebookMediaType; postLimit: number; bypassCache?: boolean; knownIds?: readonly string[] },
): Promise<FbBrowserPage> {
  const { contentType, postLimit } = options;
  if (!Number.isInteger(postLimit) || postLimit < 1 || postLimit > 1000) throw new Error("Enter a whole number from 1 to 1000.");
  const target = mediaCollection(input, contentType);
  // Updates stop as soon as the current grid reaches an already-saved item.
  // A normal fetch keeps the existing bounded-limit behaviour.
  const knownIds = new Set(options.knownIds ?? []);
  const key = mediaCacheKey(target.url, contentType, postLimit, cookies);
  const cached = snapshots.get(key);
  if (!options.bypassCache && cached && cached.expires > Date.now()) {
    const result = structuredClone(cached.page);
    result.retrieval!.fromCache = true;
    return result;
  }
  if (pending.has(key)) return structuredClone(await pending.get(key)!);

  const job = withFacebookContext(cookies, async (context) => {
    const started = Date.now();
    const page = await context.newPage();
    // Images stay enabled: the collection hydrates its tiles using image visibility.
    await page.route("**/*", (route) => ["media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
    page.setDefaultTimeout(5000);
    await page.goto(target.collectionUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await checkAccess(page);
    const selector = contentType === "reels" ? 'a[aria-label="Reel tile preview"] img, a[href*="/reel/"] img' : 'a[href*="fbid="]:not([aria-label]) img';
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
    await checkAccess(page);

    const found = new Map<string, FbBrowserPost>();
    let reachedKnownMedia = false;
    let stopReason: Retrieval["stopReason"] = "stalled";
    let idle = 0;
    const deadline = started + Math.min(180_000, 30_000 + postLimit * 250);
    while (Date.now() < deadline) {
      const before = found.size;
      if (contentType === "reels") {
        // Facebook sets some tile hrefs on pointer hover, after rendering the image.
        // Hover only visible missing links; scrolling hydrates the subsequent rows.
        await page.evaluate(() => {
          for (const tile of document.querySelectorAll<HTMLAnchorElement>('a[aria-label="Reel tile preview"]:not([href])')) {
            const r = tile.getBoundingClientRect();
            if (r.top < innerHeight && r.bottom > 0) {
              tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
            }
          }
        });
      }
      for (const tile of await collectTiles(page, contentType)) {
        const item = mediaTile(tile, contentType);
        if (item?.postId && !found.has(item.postId)) found.set(item.postId, item);
      }
      if (knownIds.size && [...found.keys()].some((id) => knownIds.has(id))) { reachedKnownMedia = true; stopReason = "end"; break; }
      if (found.size >= postLimit) { stopReason = "limit"; break; }
      idle = found.size === before ? idle + 1 : 0;
      if (idle >= 5) break;
      // Real wheel events, modest steps, and repeated accumulation handle virtualized grids.
      await page.mouse.move(1200, 850);
      await page.mouse.wheel(0, 850);
      await page.waitForTimeout(idle ? 1000 : 600);
    }
    if (Date.now() >= deadline) stopReason = "timeout";
    await checkAccess(page);
    if (!found.size) throw new Error(`Facebook returned no readable ${contentType === "posts" ? "photo" : "reel"} tiles. The collection may be empty, unavailable to this session, or not loaded. No result was cached.`);
    if (knownIds.size && !reachedKnownMedia) {
      throw new Error(`Facebook did not reach this profile's saved ${contentType === "posts" ? "photo" : "reel"} boundary. No data was saved, so old media cannot be mistaken for a new update.`);
    }
    // The first h1 may belong to Facebook's hidden notifications panel.
    const name = mediaOwnerName(await page.title(), target.handle);
    const posts = [...found.values()].filter((post) => !post.postId || !knownIds.has(post.postId)).slice(0, postLimit);
    const result: FbBrowserPage = {
      handle: target.handle, name, url: target.url, kind: "page", contentType,
      profilePic: null, coverPic: null, followers: null, likes: null, category: null,
      about: null, verified: false, posts,
      instagram: null, twitter: null, email: null, phone: null, website: null,
      stats: { requestedPosts: postLimit, scrapedPosts: posts.length, totalCommentsScraped: 0, totalLikesScraped: 0, totalSharesScraped: 0, followers: null, likes: null, engagementRate: null },
      retrieval: { capturedAt: new Date().toISOString(), fromCache: false, durationMs: Date.now() - started, requested: postLimit, returned: posts.length, stopReason },
    };
    if (stopReason === "limit") {
      for (const [k, v] of snapshots) if (v.expires <= Date.now()) snapshots.delete(k);
      if (snapshots.size >= 30) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(key, { expires: Date.now() + CACHE_MS, page: structuredClone(result) });
    }
    return result;
  });
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
