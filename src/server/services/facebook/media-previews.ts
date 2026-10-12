import type { Page } from "playwright-core";
import { withFacebookContext } from "./browser-pool";
import { FbBrowserAuthError, FbBrowserRateLimitError } from "./browser-fetcher";
import { canonicalCommentItem, type MediaCommentItem } from "./comment-jobs";

export type MediaPreview = Pick<MediaCommentItem, "postId" | "contentType"> & { image: string | null };

async function assertPreviewAccess(page: Page): Promise<void> {
  if (/^\/(login|checkpoint|two_step_verification)(?:\/|\.php|$)/.test(new URL(page.url()).pathname)
    || await page.locator('input[type="password"]').first().isVisible()) {
    throw new FbBrowserAuthError("Facebook requires a session check before restoring saved previews.");
  }
  const text = (await page.locator("body").innerText()).slice(0, 5000);
  if (/you're temporarily blocked|you’re temporarily blocked|we limit how often|going too fast/i.test(text)) {
    throw new FbBrowserRateLimitError("Facebook temporarily limited preview loading. Wait before trying again.");
  }
}

async function previewFor(page: Page, item: MediaCommentItem): Promise<string | null> {
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await assertPreviewAccess(page);
  await page.locator("img, video[poster]").first().waitFor({ state: "attached", timeout: 4000 }).catch(() => {});
  const preview = await page.evaluate(() => {
    const valid = (value: string) => {
      try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
    };
    const candidates = [
      ...[...document.images].map((image) => ({ url: image.currentSrc || image.src, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, alt: image.alt || "", kind: "image" })),
      ...[...document.querySelectorAll<HTMLVideoElement>("video[poster]")].map((video) => ({ url: video.poster, width: video.videoWidth || video.clientWidth, height: video.videoHeight || video.clientHeight, alt: "", kind: "video" })),
    ].flatMap((candidate) => {
      const url = valid(candidate.url);
      if (!url || candidate.width < 100 || candidate.height < 100) return [];
      const score = (/(?:scontent|fbcdn|facebook\.com)/i.test(url) ? 100_000 : 0)
        + candidate.width * candidate.height + (candidate.kind === "video" ? 10_000 : 0)
        - (/(?:profile|avatar|emoji|reaction|icon)/i.test(candidate.alt) ? 50_000 : 0);
      return [{ url, score }];
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url ?? null;
  });
  await assertPreviewAccess(page);
  return preview;
}

/**
 * Recover only visible saved cards from their exact known media URLs. This is
 * intentionally not a profile grid scrape and never opens the comment tray.
 */
export async function fetchFacebookMediaPreviews(items: MediaCommentItem[], cookies: string): Promise<MediaPreview[]> {
  const unique = [...new Map(items.map((item) => {
    const canonical = canonicalCommentItem(item);
    return [`${canonical.contentType}:${canonical.postId}`, canonical] as const;
  })).values()];
  if (!unique.length || unique.length > 48) throw new Error("Restore between 1 and 48 saved media previews at a time.");
  return withFacebookContext(cookies, async (context) => {
    const pending = [...unique];
    const recovered: MediaPreview[] = [];
    const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
      const page = await context.newPage();
      try {
        // A thumbnail needs image bytes; videos, fonts and every comment detail
        // resource remain blocked. The work is bounded to visible saved cards.
        await page.route("**/*", (route) => ["media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
        page.setDefaultTimeout(3000);
        for (let item = pending.shift(); item; item = pending.shift()) {
          try { recovered.push({ postId: item.postId, contentType: item.contentType, image: await previewFor(page, item) }); }
          catch (error) {
            if (error instanceof FbBrowserAuthError || error instanceof FbBrowserRateLimitError) throw error;
            recovered.push({ postId: item.postId, contentType: item.contentType, image: null });
          }
        }
      } finally { await page.close().catch(() => {}); }
    });
    await Promise.all(workers);
    return recovered;
  });
}
