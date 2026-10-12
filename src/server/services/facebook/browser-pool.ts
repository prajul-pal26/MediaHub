/**
 * A single shared Chromium instance for every Facebook browser-backed scraper.
 *
 * Chromium is the heaviest thing in this stack (~150MB resident, ~1s cold
 * start), so the page fetcher, post scraper, and comment scraper all borrow the
 * same process rather than each launching their own.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Browser, BrowserContext } from "playwright-core";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let displayStarting: Promise<void> | null = null;
let virtualDisplay: ChildProcess | null = null;
let ownsDisplay = false;

/**
 * Docker has no desktop display, but Facebook supplies a restricted timeline to
 * headless Chromium. Xvfb gives the local scraper a normal browser surface
 * without requiring a user-visible window.
 */
async function ensureVirtualDisplay(): Promise<void> {
  if (process.env.DISPLAY) return;
  if (displayStarting) return displayStarting;

  displayStarting = new Promise<void>((resolve, reject) => {
    const display = ":99";
    const server = spawn("Xvfb", [display, "-screen", "0", "1366x1200x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    virtualDisplay = server;
    ownsDisplay = true;
    const timeout = setTimeout(() => {
      process.env.DISPLAY = display;
      resolve();
    }, 250);
    server.once("error", (error) => {
      clearTimeout(timeout);
      if (virtualDisplay === server) virtualDisplay = null;
      ownsDisplay = false;
      displayStarting = null;
      reject(new Error(`Could not start the virtual browser display: ${error.message}`));
    });
    server.once("exit", () => {
      if (virtualDisplay !== server) return;
      virtualDisplay = null;
      displayStarting = null;
      if (ownsDisplay && process.env.DISPLAY === display) delete process.env.DISPLAY;
      ownsDisplay = false;
    });
  });
  return displayStarting;
}

export async function getSharedBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;

  const { chromium } = await import("playwright-core");
  // Facebook serves headless browsers a stripped shell: the profile header
  // renders but the posts feed never does. Docker supplies Xvfb for a normal
  // browser surface; host development can opt in when it has a display.
  const headless = process.env.FB_HEADFUL !== "1";
  if (!headless) await ensureVirtualDisplay();
  // Two collection requests may finish the async import/display setup together.
  // Recheck here so Photos + Reels share one Chromium process on a cold start.
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
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
        // Reels autoplay video in every open context. Decoding those frames is
        // pure waste for a scraper that reads text and counts, and it is the
        // largest CPU cost when several detail pages run at once.
        "--autoplay-policy=user-gesture-required",
        "--mute-audio",
        "--disable-hang-monitor",
        "--disable-breakpad",
        // A long Facebook feed can otherwise create a renderer per embedded
        // frame. Keep the shared browser bounded even if a page is malformed;
        // comment jobs use fresh contexts per item, so completed work cannot
        // accumulate renderers across the batch.
        "--renderer-process-limit=12",
        "--process-per-site",
        // Facebook embeds a large cross-origin frame tree. Its default site
        // isolation creates a renderer for many of those frames in every
        // worker context, defeating the renderer limit during a batch.
        "--disable-site-isolation-trials",
        "--disable-features=IsolateOrigins,site-per-process",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AcceptCHFrame",
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
  const display = virtualDisplay;
  virtualDisplay = null;
  displayStarting = null;
  if (ownsDisplay && process.env.DISPLAY === ":99") delete process.env.DISPLAY;
  ownsDisplay = false;
  if (display && !display.killed) display.kill("SIGTERM");
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
export async function createFacebookContext(
  cookieString: string,
  options: { blockMedia?: boolean } = {},
): Promise<BrowserContext> {
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
    return ctx;
  } catch (error) {
    await ctx.close().catch(() => {});
    throw error;
  }
}

export async function withFacebookContext<T>(
  cookieString: string,
  fn: (ctx: BrowserContext) => Promise<T>,
  options: { blockMedia?: boolean } = {},
): Promise<T> {
  const ctx = await createFacebookContext(cookieString, options);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}
