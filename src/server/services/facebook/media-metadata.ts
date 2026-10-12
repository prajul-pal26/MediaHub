import type { Page } from "playwright-core";
import { FbBrowserAuthError, type FbMediaMetadata } from "./browser-fetcher";
import { publishedTimeFromPayloads } from "./media-metadata-data";
import { nativeMediaPayloads } from "./media-native-payloads";

const CAPTIONS = 'span[dir="auto"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
const EXCLUDED = '[role="navigation"], [role="banner"], [role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]';

/** Preserve the observed precision/timezone; never infer an obfuscated date. */
export function observedPublishedTime(value: string | null | undefined): string | null {
  const text = value?.replace(/[\u00a0\u202f]/g, " ").trim();
  if (!text || /[\u034f]/.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text) && Number.isFinite(Date.parse(text))) return text;
  const month = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
  // Facebook's tooltip may omit a timezone. Return that absolute label verbatim,
  // rather than manufacturing a UTC timestamp from the server's local timezone.
  if (month.test(text) && /\b\d{1,2}\b/.test(text) && /\b(?:19|20|21)\d{2}\b/.test(text) && text.length < 140) return text;
  return null;
}

async function assertNoLoginPrompt(page: Page) {
  if (await page.locator('input[type="password"]').first().isVisible()) {
    throw new FbBrowserAuthError("Facebook requires sign-in before reading media details.");
  }
}

async function captionSnapshot(page: Page, prefix = "") {
  return page.evaluate(({ selector, excluded, prefix }) => {
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 && box.left < innerWidth && box.right > 0 &&
        style.visibility !== "hidden" && style.display !== "none" && !el.closest(excluded);
    };
    const normalize = (value: string) => value.replace(/[\u00a0\u202f]/g, " ").trim();
    const ownerNames = new Set([...document.querySelectorAll<HTMLElement>('h1, h2, a[aria-label="See owner profile"]')].map((el) => normalize(el.innerText)));
    const candidates = [...document.querySelectorAll<HTMLElement>(selector)].map((el, index) => ({ el, index, raw: normalize(el.innerText) })).filter(({ el, raw }) => {
      if (!visible(el) || el.closest('a, [role="button"], h1, h2, h3') || el.querySelector(excluded)) return false;
      if (raw.length < 12 || /[\u034f]/.test(raw) || ownerNames.has(raw)) return false;
      if (/^(?:["“]?Most relevant|All comments|Newest|Comment as|Number of unread|See more on Facebook|Log in|Forgotten password)/i.test(raw)) return false;
      if (prefix && !raw.startsWith(prefix)) return false;
      return !el.querySelector('a[aria-label="See owner profile"], [role="button"][aria-label="Like"]');
    }).sort((a, b) => {
      const explicit = (el: Element) => Number(el.matches('[data-ad-preview="message"], [data-ad-comet-preview="message"]'));
      return explicit(b.el) - explicit(a.el) || b.raw.length - a.raw.length;
    });
    const best = candidates[0];
    if (!best) return null;
    // Keep an ellipsis if expansion fails: an excerpt must not look complete.
    const text = best.raw.replace(/\s*See (?:more|less)\s*$/i, "").trim();
    let date: string | null = null;
    let timeLinkIndex: number | null = null;
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
    let scope: HTMLElement | null = best.el;
    for (let depth = 0; scope && depth < 8 && scope !== document.body; depth++, scope = scope.parentElement) {
      if (scope.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]').length > 1) break;
      const time = [...scope.querySelectorAll<HTMLElement>('time[datetime], abbr[data-utime]')].find(visible);
      if (time) {
        const datetime = time.getAttribute("datetime");
        const unix = Number(time.getAttribute("data-utime"));
        if (datetime) date = datetime;
        else if (Number.isFinite(unix) && unix > 0 && Number.isFinite(new Date(unix * 1000).getTime())) date = new Date(unix * 1000).toISOString();
        if (date) break;
      }
      const link = [...scope.querySelectorAll<HTMLAnchorElement>("a[href]")].find((el) => {
        if (!visible(el)) return false;
        const url = new URL(el.href);
        if (!/^(?:www\.|m\.|web\.)?facebook\.com$/.test(url.hostname) || url.searchParams.has("comment_id") || url.searchParams.has("reply_comment_id")) return false;
        if (!/\/posts\/|\/reel\/|\/photo(?:\.php)?(?:\/|$)|\/permalink|\/story/.test(url.pathname)) return false;
        const label = el.getAttribute("aria-label") || el.innerText.trim();
        return /[\u034f]/.test(el.innerText) || /^(?:\d+\s*(?:[hmdwy]|minutes?|hours?|days?|weeks?|months?|years?)|Yesterday|Today)\b/i.test(label) || /\b(?:19|20|21)\d{2}\b/.test(label);
      });
      if (link) { timeLinkIndex = links.indexOf(link); break; }
    }
    return { index: best.index, text, raw: best.raw, date, timeLinkIndex };
  }, { selector: CAPTIONS, excluded: EXCLUDED, prefix });
}

async function embeddedPublishedTime(page: Page, item?: { postId: string; contentType: "posts" | "reels" }): Promise<string | null> {
  if (!item) return null;
  return publishedTimeFromPayloads(await nativeMediaPayloads(page), item);
}

/** Read the exact media's date independently of caption presence/length, then
 * expand only its active caption, restoring any panel we opened. */
export async function readMediaMetadata(page: Page, item?: { postId: string; contentType: "posts" | "reels" }): Promise<FbMediaMetadata> {
  await assertNoLoginPrompt(page);
  const embeddedTime = await embeddedPublishedTime(page, item);
  let snapshot = await captionSnapshot(page);
  if (!snapshot) return embeddedTime ? { publishedTime: embeddedTime } : {};
  const prefix = snapshot.text.replace(/(?:…|\.\.\.)\s*$/, "").slice(0, 40);
  const beforeDialogs = await page.evaluateHandle(() => new Set(document.querySelectorAll('[role="dialog"]')));
  let clicked = false;
  let readFailure: unknown;
  let retained: FbMediaMetadata = { text: snapshot.text, ...(embeddedTime ? { publishedTime: embeddedTime } : {}) };
  try {
    const more = page.locator(CAPTIONS).nth(snapshot.index).getByText("See more", { exact: true });
    for (let i = 0; i < await more.count(); i++) {
      const button = more.nth(i);
      const inViewport = await button.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 && box.left < innerWidth && box.right > 0;
      });
      if (!inViewport) continue;
      try { await button.click({ timeout: 1500 }); clicked = true; } catch { break; }
      break;
    }
    if (clicked) {
      // Expansion can replace the caption asynchronously or open a post panel.
      // Do not read the old truncated DOM immediately after the click resolves.
      const deadline = Date.now() + 2200;
      while (Date.now() < deadline) {
        await assertNoLoginPrompt(page);
        const next = await captionSnapshot(page, prefix);
        if (next) {
          snapshot = next;
          retained = { ...retained, text: next.text };
          if (!/See more\s*$/i.test(next.raw)) break;
        }
        await page.waitForTimeout(100);
      }
    }
    await assertNoLoginPrompt(page);
    let publishedTime = embeddedTime ?? (item ? publishedTimeFromPayloads(await nativeMediaPayloads(page, { refresh: true }), item) : null) ?? observedPublishedTime(snapshot.date);
    if (!publishedTime && snapshot.timeLinkIndex !== null) {
      const timestamp = page.locator("a[href]").nth(snapshot.timeLinkIndex);
      try {
        await timestamp.hover({ timeout: 800 });
        const tooltip = page.getByRole("tooltip").filter({ hasText: /\b(?:19|20|21)\d{2}\b/ }).first();
        await tooltip.waitFor({ state: "visible", timeout: 900 });
        publishedTime = observedPublishedTime(await tooltip.innerText());
      } catch { /* No observable absolute date; leave the field blank. */ }
    }
    retained = { ...(snapshot.text ? { text: snapshot.text } : {}), ...(publishedTime ? { publishedTime } : {}) };
    return retained;
  } catch (error) {
    readFailure = error;
    if (error instanceof Error) Object.assign(error, { partialMetadata: retained });
    throw error;
  } finally {
    try { if (clicked) {
      // Never dismiss a pre-existing viewer/login dialog or send Escape globally.
      const opened = await page.evaluateHandle(({ before, prefix, selector }) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => {
        if (before.has(dialog) || dialog.querySelector('input[type="password"]') || !dialog.getClientRects().length) return false;
        return [...dialog.querySelectorAll<HTMLElement>(selector)].some((caption) => caption.innerText.trim().startsWith(prefix));
      }) ?? null, { before: beforeDialogs, prefix, selector: CAPTIONS });
      try {
        const dialog = opened.asElement();
        if (dialog) {
          const close = await dialog.$('[role="button"][aria-label="Close"], button[aria-label="Close"]');
          if (!close || !await close.isVisible()) throw new Error("The expanded caption panel could not be closed.");
          await close.click({ timeout: 1000 });
          await dialog.waitForElementState("hidden", { timeout: 1000 });
        }
      } finally { await opened.dispose(); }
    } } catch (error) {
      // Retain a successfully read caption even if panel restoration fails,
      // while preventing later stages from clicking behind an unresolved panel.
      if (!readFailure) throw Object.assign(error instanceof Error ? error : new Error("The caption panel could not be restored."), { partialMetadata: retained, mediaBlocked: true });
    } finally { await beforeDialogs.dispose().catch(() => {}); }
  }
}
