import type { Browser } from "playwright-core";
import type { InstaCarouselChild, InstaFeedResult, InstaMediaItem } from "./fetcher";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const { chromium } = await import("playwright-core");
  launching = chromium
    .launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    })
    .then((instance) => {
      browser = instance;
      launching = null;
      instance.once("disconnected", () => {
        if (browser === instance) browser = null;
      });
      return instance;
    })
    .catch((error) => {
      launching = null;
      throw error;
    });
  return launching;
}

/** Accept both the Cookie header copied by DevTools and its visible label. */
function toCookies(raw: string) {
  let header = raw.trim();
  if (/^cookie\s*:/i.test(header)) header = header.replace(/^cookie\s*:\s*/i, "");
  else if (/^cookie\s+/i.test(header)) header = header.replace(/^cookie\s+/i, "");

  return header
    .split(/;\s*/)
    .map((pair) => {
      const boundary = pair.indexOf("=");
      if (boundary < 1) return null;
      return {
        name: pair.slice(0, boundary).trim(),
        value: pair.slice(boundary + 1).trim(),
        domain: ".instagram.com",
        path: "/",
      };
    })
    .filter((cookie): cookie is { name: string; value: string; domain: string; path: string } => Boolean(cookie));
}

function firstImage(node: any): string | null {
  const candidates = node?.image_versions2?.candidates;
  return Array.isArray(candidates) && candidates[0]?.url ? candidates[0].url : null;
}

function firstVideo(node: any): string | null {
  const versions = node?.video_versions;
  return Array.isArray(versions) && versions[0]?.url ? versions[0].url : null;
}

function mapNode(node: any): InstaMediaItem | null {
  const shortcode = typeof node?.code === "string" ? node.code : "";
  const id = node?.pk ?? node?.id;
  if (!shortcode || id == null) return null;
  const mediaType = node?.media_type;
  const isReel = node?.product_type === "clips";
  const kind: InstaMediaItem["kind"] =
    mediaType === 8 ? "carousel" : isReel ? "reel" : mediaType === 2 ? "video" : "post";
  const carousel: InstaCarouselChild[] = Array.isArray(node?.carousel_media)
    ? node.carousel_media.map((child: any) => ({
        displayUrl: firstImage(child),
        videoUrl: firstVideo(child),
        isVideo: child?.media_type === 2,
      }))
    : [];
  return {
    id: String(id),
    shortcode,
    url: `https://www.instagram.com/${isReel ? "reel" : "p"}/${shortcode}/`,
    kind,
    displayUrl: firstImage(node) ?? carousel[0]?.displayUrl ?? null,
    videoUrl: firstVideo(node),
    likes: typeof node?.like_count === "number" ? node.like_count : 0,
    comments: typeof node?.comment_count === "number" ? node.comment_count : 0,
    views: typeof node?.view_count === "number" ? node.view_count : null,
    caption: typeof node?.caption?.text === "string" ? node.caption.text : "",
    takenAt: typeof node?.taken_at === "number" ? node.taken_at : null,
    carousel,
  };
}

/**
 * Read the same Profile Posts GraphQL response that Instagram's web profile
 * page requests. This is a link-discovery fallback only: it does not download
 * photo/video files or expand comments.
 */
export async function fetchBrowserProfileFeed(
  username: string,
  sessionHeader: string,
  maxCount: number,
): Promise<InstaFeedResult> {
  // Discovery is deliberately separate from comment collection.  Keep the
  // ceiling large enough for a full latest-link workspace while still making
  // every request bounded by the caller's explicit limit.
  const cap = Math.min(Math.max(maxCount, 1), 400);
  const context = await (await getBrowser()).newContext({
    userAgent: BROWSER_UA,
    viewport: { width: 1366, height: 1000 },
    locale: "en-US",
  });
  const items = new Map<string, InstaMediaItem>();
  type PageInfo = { has_next_page?: boolean; end_cursor?: string | null };
  type Continuation = { url: string; method: string; postData: string; headers: Record<string, string> };
  const state: { pageInfo: PageInfo | null; continuation: Continuation | null } = {
    pageInfo: null,
    continuation: null,
  };

  const addPayload = (payload: any) => {
    const connection = payload?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    for (const edge of edges) {
      const item = mapNode(edge?.node);
      if (item) items.set(item.id, item);
    }
    state.pageInfo = connection?.page_info ?? state.pageInfo;
  };

  const nextBody = (postData: string, cursor: string) => {
    // Profile pagination is a continuation of the exact request that the
    // profile page already made.  Its body has appeared in both form and JSON
    // variants, so support either without inventing a private endpoint.
    try {
      const form = new URLSearchParams(postData);
      const rawVariables = form.get("variables");
      if (rawVariables) {
        const variables = JSON.parse(rawVariables);
        variables.after = cursor;
        form.set("variables", JSON.stringify(variables));
        return form.toString();
      }
    } catch { /* try JSON below */ }
    try {
      const body = JSON.parse(postData);
      if (body?.variables && typeof body.variables === "object") {
        body.variables.after = cursor;
        return JSON.stringify(body);
      }
    } catch { /* no supported continuation shape */ }
    return null;
  };

  try {
    await context.addCookies(toCookies(sessionHeader));
    const page = await context.newPage();
    const capture = async (response: any) => {
      const request = response.request();
      if (!(request.postData?.() ?? "").includes("PolarisProfilePostsQuery")) return;
      addPayload(await response.json().catch(() => null));
      // Preserve only the headers that the page itself used to make this
      // GraphQL request. Cookies stay in the browser context and are never
      // copied into a request body or persisted.
      state.continuation = {
        url: request.url(),
        method: request.method(),
        postData: request.postData() ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers())
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .filter(([name]) =>
            ["content-type", "x-ig-app-id", "x-fb-lsd", "x-asbd-id", "x-csrftoken", "x-requested-with"].includes(name.toLowerCase()),
            ),
        ),
      };
    };
    page.on("response", (response) => void capture(response));

    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });

    // Instagram loads the first page through GraphQL after the document. More
    // pages are only requested when the profile grid reaches its lower edge.
    let stableScrolls = 0;
    for (let turn = 0; turn < 12 && items.size < cap && stableScrolls < 3; turn++) {
      const before = items.size;
      await page.waitForTimeout(turn === 0 ? 1_500 : 750);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(750);
      if (items.size === before) stableScrolls++;
      else stableScrolls = 0;
    }

    // Scrolling is the cheapest path and lets Instagram choose its normal
    // pagination.  When its virtual grid does not request more pages, continue
    // the captured browser request one cursor at a time.  This is sequential
    // by design: each page's cursor is needed for the next page.
    for (let turn = 0; turn < 80 && items.size < cap; turn++) {
      const cursor = state.pageInfo?.end_cursor;
      const continuation = state.continuation;
      if (!state.pageInfo?.has_next_page || !cursor || !continuation) break;
      const body = nextBody(continuation.postData, cursor);
      if (!body) break;
      const before = items.size;
      const result = await page.evaluate(async ({ url, method, headers, body }) => {
        const response = await fetch(url, { method, headers, body, credentials: "include" });
        return { status: response.status, payload: await response.json().catch(() => null) };
      }, { ...continuation, body });
      if (result.status < 200 || result.status >= 300) break;
      addPayload(result.payload);
      if (items.size === before) break;
      // A short, bounded spacing reduces avoidable throttling while retaining
      // a much faster link-only path than comment pagination.
      await page.waitForTimeout(550);
    }

    return {
      items: [...items.values()].slice(0, cap),
      truncated: Boolean(state.pageInfo?.has_next_page) || items.size >= cap,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
