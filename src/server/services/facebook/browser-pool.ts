/**
 * A single shared Chromium instance for every Facebook browser-backed scraper.
 *
 * Chromium is the heaviest thing in this stack (~150MB resident, ~1s cold
 * start), so the page fetcher, post scraper, and comment scraper all borrow the
 * same process rather than each launching their own.
 */
import type { Browser, BrowserContext } from "playwright-core";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

export async function getSharedBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;

  const { chromium } = await import("playwright-core");
  // Facebook serves headless browsers a stripped shell: the profile header
  // renders but the posts feed never does. Running headful restores it, so it
  // is opt-in via FB_HEADFUL for environments that have a display.
  const headless = process.env.FB_HEADFUL !== "1";
  launching = chromium
    .launch({
      executablePath: CHROMIUM_PATH,
      headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-blink-features=AutomationControlled",
        "--dns-prefetch-disable",
        ...(headless ? ["--disable-gpu"] : ["--window-size=1400,1000"]),
      ],
    })
    .then((b) => {
      browser = b;
      launching = null;
      return b;
    })
    .catch((err) => {
      launching = null;
      throw new Error(
        `Could not start Chromium at ${CHROMIUM_PATH} — set CHROMIUM_PATH to a Chromium/Chrome binary. (${
          err?.message ?? err
        })`,
      );
    });
  return launching;
}

/** Drop the instance after a crash or a wedged network stack. */
export async function resetSharedBrowser(): Promise<void> {
  const current = browser;
  browser = null;
  launching = null;
  if (current) await current.close().catch(() => {});
}

/** Cookie header string → Playwright cookie records scoped to facebook.com. */
export function toPlaywrightCookies(cookieString: string) {
  return cookieString
    .split(/;\s*/)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 0) return null;
      const name = pair.slice(0, idx).trim();
      if (!name) return null;
      return { name, value: pair.slice(idx + 1).trim(), domain: ".facebook.com", path: "/" };
    })
    .filter((c): c is { name: string; value: string; domain: string; path: string } => !!c);
}

/** Open an authenticated context, run `fn`, and always tear the context down. */
export async function withFacebookContext<T>(
  cookieString: string,
  fn: (ctx: BrowserContext) => Promise<T>,
  options: { blockMedia?: boolean } = {},
): Promise<T> {
  const instance = await getSharedBrowser();
  const ctx = await instance.newContext({
    userAgent: DESKTOP_UA,
    viewport: { width: 1366, height: 1200 },
    locale: "en-US",
  });
  try {
    await ctx.addCookies(toPlaywrightCookies(cookieString));
    if (options.blockMedia) {
      // Images/fonts/video are pure cost when we only read text and counts.
      await ctx.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") return route.abort();
        return route.continue();
      });
    }
    return await fn(ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}
