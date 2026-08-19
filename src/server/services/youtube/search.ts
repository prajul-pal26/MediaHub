/**
 * YouTube search / discovery without an API key.
 *
 * MediaHub's existing YouTube code only *publishes* (OAuth + videos.insert).
 * For discovery we need the opposite: find public videos matching a query. The
 * Data API v3 would need a billed API key and imposes a 100-unit quota cost per
 * search, so instead we read the same JSON payload the web player bootstraps
 * from (`ytInitialData`), then page through with YouTube's internal
 * `youtubei/v1/search` endpoint using the key embedded in that payload.
 *
 * This is public, unauthenticated data — no cookies, no login, no user data.
 */

const WATCH_BASE = "https://www.youtube.com/watch?v=";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 25_000;

export interface YtVideo {
  videoId: string;
  url: string;
  title: string;
  description: string;
  channelName: string;
  channelUrl: string | null;
  /** Relative string YouTube renders, e.g. "3 weeks ago". Null for live/upcoming. */
  publishedText: string | null;
  /** Parsed absolute estimate derived from publishedText. */
  publishedEstimate: string | null;
  durationText: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  viewCountText: string | null;
  thumbnail: string | null;
  isShort: boolean;
  isLive: boolean;
  badges: string[];
}

/** Search-result ordering. YouTube encodes these as protobuf `sp` params. */
export type YtSortBy = "relevance" | "date" | "views" | "rating";

/** Pre-encoded `sp` values for sort order (stable, widely documented). */
const SORT_PARAMS: Record<YtSortBy, string | null> = {
  relevance: null,
  date: "CAI%3D",
  views: "CAM%3D",
  rating: "CAE%3D",
};

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (err: any) {
    throw new Error(
      err?.name === "AbortError" ? "YouTube request timed out" : `Network error: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** "1.2M views" / "1,234 views" / "No views" → number */
export function parseViewCount(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/^no views/i.test(text.trim())) return 0;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/,/g, ""));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toUpperCase();
  const mult = suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

/** "1:23:45" / "10:30" → seconds */
export function parseDuration(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * Turn "3 weeks ago" into an ISO date. Approximate by design — YouTube only
 * exposes relative times on search results, and an approximate date still sorts
 * and filters correctly for recency work.
 */
export function estimatePublished(text: string | null | undefined, now = Date.now()): string | null {
  if (!text) return null;
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const seconds: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2629800,
    year: 31557600,
  };
  const delta = (seconds[unit] ?? 0) * n * 1000;
  return new Date(now - delta).toISOString();
}

function joinRuns(node: any): string {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r?.text ?? "").join("");
  return "";
}

/** Map a `videoRenderer` (or the Shorts/reel variant) into our shape. */
function mapVideoRenderer(renderer: any, now: number): YtVideo | null {
  const videoId = renderer?.videoId;
  if (!videoId) return null;

  const title = joinRuns(renderer.title);
  const publishedText = joinRuns(renderer.publishedTimeText) || null;
  const viewCountText =
    joinRuns(renderer.viewCountText) || joinRuns(renderer.shortViewCountText) || null;
  const durationText =
    joinRuns(renderer.lengthText) ||
    renderer.thumbnailOverlays
      ?.map((o: any) => joinRuns(o?.thumbnailOverlayTimeStatusRenderer?.text))
      .find((t: string) => t) ||
    null;

  const badges: string[] = [
    ...(renderer.badges ?? []).map((b: any) => joinRuns(b?.metadataBadgeRenderer?.label)),
    ...(renderer.ownerBadges ?? []).map((b: any) => joinRuns(b?.metadataBadgeRenderer?.label)),
  ].filter(Boolean);

  const isLive =
    Boolean(renderer.badges?.some((b: any) => /LIVE/i.test(joinRuns(b?.metadataBadgeRenderer?.label)))) ||
    /watching/i.test(viewCountText ?? "");

  const channelRun = renderer.ownerText?.runs?.[0] ?? renderer.longBylineText?.runs?.[0];
  const channelPath =
    channelRun?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? null;

  const durationSeconds = parseDuration(durationText);

  return {
    videoId,
    url: `${WATCH_BASE}${videoId}`,
    title,
    description:
      joinRuns(renderer.detailedMetadataSnippets?.[0]?.snippetText) ||
      joinRuns(renderer.descriptionSnippet) ||
      "",
    channelName: channelRun?.text ?? "",
    channelUrl: channelPath ? `https://www.youtube.com${channelPath}` : null,
    publishedText,
    publishedEstimate: estimatePublished(publishedText, now),
    durationText,
    durationSeconds,
    viewCount: parseViewCount(viewCountText),
    viewCountText,
    thumbnail:
      renderer.thumbnail?.thumbnails?.[renderer.thumbnail.thumbnails.length - 1]?.url ?? null,
    // Shorts are <= 3 min and served by a distinct renderer; treat both as short.
    isShort: durationSeconds != null && durationSeconds <= 180,
    isLive,
    badges,
  };
}

/** Recursively collect every videoRenderer in an arbitrary YouTube payload. */
function collectVideoRenderers(root: any): any[] {
  const found: any[] = [];
  const stack: any[] = [root];
  let steps = 0;
  while (stack.length && steps < 200_000) {
    const node = stack.pop();
    steps += 1;
    if (!node || typeof node !== "object") continue;
    if (node.videoRenderer?.videoId) found.push(node.videoRenderer);
    else if (node.videoWithContextRenderer?.videoId) found.push(node.videoWithContextRenderer);
    else if (node.reelItemRenderer?.videoId) found.push(node.reelItemRenderer);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return found;
}

/** Pull the first continuation token out of a payload, if any. */
function findContinuation(root: any): string | null {
  const stack: any[] = [root];
  let steps = 0;
  while (stack.length && steps < 200_000) {
    const node = stack.pop();
    steps += 1;
    if (!node || typeof node !== "object") continue;
    const token =
      node.continuationCommand?.token ??
      node.continuationEndpoint?.continuationCommand?.token ??
      node.nextContinuationData?.continuation;
    if (typeof token === "string" && token.length > 10) return token;
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

interface Bootstrap {
  initialData: any;
  apiKey: string | null;
  clientVersion: string;
}

/** Load a search page and extract ytInitialData + the innertube API key. */
async function bootstrapSearch(query: string, sortBy: YtSortBy, hl: string, gl: string): Promise<Bootstrap> {
  const sp = SORT_PARAMS[sortBy];
  const url =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}` +
    (sp ? `&sp=${sp}` : "");

  const res = await timedFetch(url, {
    headers: {
      "User-Agent": DESKTOP_UA,
      "Accept-Language": `${hl},en;q=0.9`,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      // Bypass the EU consent interstitial, which otherwise replaces results.
      Cookie: "CONSENT=YES+cb; SOCS=CAI",
    },
  });
  const html = await res.text();

  const match =
    /var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html) ??
    /ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/.exec(html) ??
    /ytInitialData\s*=\s*(\{[\s\S]*?\});/.exec(html);

  if (!match) {
    throw new Error(
      "Could not read ytInitialData — YouTube may have served a consent wall or changed its markup",
    );
  }

  let initialData: any;
  try {
    initialData = JSON.parse(match[1]);
  } catch {
    throw new Error("ytInitialData was not valid JSON");
  }

  return {
    initialData,
    apiKey: /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1] ?? null,
    clientVersion: /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? "2.20240101.00.00",
  };
}

/** Fetch one continuation page from the internal search endpoint. */
async function fetchContinuation(
  token: string,
  apiKey: string,
  clientVersion: string,
  hl: string,
  gl: string,
): Promise<any> {
  const res = await timedFetch(`https://www.youtube.com/youtubei/v1/search?key=${apiKey}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "User-Agent": DESKTOP_UA,
      "Content-Type": "application/json",
      "Accept-Language": `${hl},en;q=0.9`,
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
    },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion, hl, gl } },
      continuation: token,
    }),
  });
  return res.json().catch(() => null);
}

export interface YtSearchOptions {
  /** Max videos to return. */
  limit?: number;
  sortBy?: YtSortBy;
  /** Interface language — "hi" surfaces Hindi results more reliably. */
  hl?: string;
  /** Geo bias — "IN" for India. */
  gl?: string;
  /** Extra continuation pages to walk beyond the first (~20 results each). */
  maxPages?: number;
}

export interface YtSearchResult {
  query: string;
  videos: YtVideo[];
  pagesWalked: number;
  /** True when YouTube ran out of continuations before the limit was hit. */
  exhausted: boolean;
}

/**
 * Search YouTube and return structured video records.
 * Deduplicates by videoId across continuation pages.
 */
export async function searchYouTube(query: string, options: YtSearchOptions = {}): Promise<YtSearchResult> {
  const { limit = 40, sortBy = "relevance", hl = "en", gl = "IN", maxPages = 3 } = options;
  const now = Date.now();

  const boot = await bootstrapSearch(query, sortBy, hl, gl);

  const videos: YtVideo[] = [];
  const seen = new Set<string>();
  const absorb = (payload: any) => {
    for (const renderer of collectVideoRenderers(payload)) {
      if (videos.length >= limit) return;
      const video = mapVideoRenderer(renderer, now);
      if (!video || seen.has(video.videoId)) continue;
      seen.add(video.videoId);
      videos.push(video);
    }
  };

  absorb(boot.initialData);

  let pagesWalked = 1;
  let token = findContinuation(boot.initialData);
  let exhausted = !token;

  while (videos.length < limit && pagesWalked <= maxPages && token && boot.apiKey) {
    const payload = await fetchContinuation(token, boot.apiKey, boot.clientVersion, hl, gl);
    pagesWalked += 1;
    if (!payload) break;
    const before = videos.length;
    absorb(payload);
    const next = findContinuation(payload);
    if (!next || next === token || videos.length === before) {
      exhausted = !next;
      break;
    }
    token = next;
    // Be a polite client.
    await new Promise((r) => setTimeout(r, 400));
  }

  return { query, videos, pagesWalked, exhausted };
}

export interface YtVideoStats {
  videoId: string;
  /** Exact ISO timestamp, unlike the relative text on search pages. */
  publishedAt: string | null;
  channelId: string | null;
  channelTitle: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  duration: string | null;
  /** ISO-3166 region the uploader declared, when present. */
  defaultAudioLanguage: string | null;
}

/**
 * Enrich scraped videos with exact figures from the Data API v3.
 *
 * Search-result scraping gives relative dates ("2 days ago") and rounded view
 * counts; `videos.list` gives exact timestamps plus like/comment counts, which
 * is what a virality ranking actually needs. Costs 1 quota unit per call (vs 100
 * for an API `search`), and accepts up to 50 ids per request.
 *
 * Works with either an OAuth access token or a plain API key.
 */
export async function fetchVideoStats(
  videoIds: string[],
  auth: { accessToken?: string; apiKey?: string },
): Promise<{ stats: Map<string, YtVideoStats>; error?: string }> {
  const stats = new Map<string, YtVideoStats>();
  if (!videoIds.length) return { stats };
  if (!auth.accessToken && !auth.apiKey) return { stats, error: "No YouTube API key or access token" };

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
      maxResults: "50",
    });
    if (auth.apiKey) params.set("key", auth.apiKey);

    let res: Response;
    try {
      res = await timedFetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
        headers: auth.accessToken
          ? { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" }
          : { Accept: "application/json" },
      });
    } catch (err: any) {
      return { stats, error: err?.message ?? "network error" };
    }

    const json: any = await res.json().catch(() => null);
    if (json?.error) {
      return { stats, error: json.error?.message ?? `HTTP ${res.status}` };
    }

    for (const item of json?.items ?? []) {
      const num = (v: unknown) => (v == null ? null : Number(v));
      stats.set(item.id, {
        videoId: item.id,
        publishedAt: item.snippet?.publishedAt ?? null,
        channelId: item.snippet?.channelId ?? null,
        channelTitle: item.snippet?.channelTitle ?? null,
        title: item.snippet?.title ?? null,
        description: item.snippet?.description ?? null,
        tags: item.snippet?.tags ?? [],
        viewCount: num(item.statistics?.viewCount),
        likeCount: num(item.statistics?.likeCount),
        commentCount: num(item.statistics?.commentCount),
        duration: item.contentDetails?.duration ?? null,
        defaultAudioLanguage: item.snippet?.defaultAudioLanguage ?? null,
      });
    }
    if (i + 50 < videoIds.length) await new Promise((r) => setTimeout(r, 250));
  }

  return { stats };
}

/**
 * Run many queries and merge into one deduplicated, virality-ranked list.
 * Records which queries surfaced each video — useful for auditing relevance.
 */
export async function searchYouTubeMulti(
  queries: string[],
  options: YtSearchOptions & { delayMs?: number } = {},
): Promise<{ videos: (YtVideo & { matchedQueries: string[] })[]; errors: { query: string; error: string }[] }> {
  const { delayMs = 700, ...searchOptions } = options;
  const byId = new Map<string, YtVideo & { matchedQueries: string[] }>();
  const errors: { query: string; error: string }[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    try {
      const { videos } = await searchYouTube(query, searchOptions);
      for (const video of videos) {
        const existing = byId.get(video.videoId);
        if (existing) {
          if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
        } else {
          byId.set(video.videoId, { ...video, matchedQueries: [query] });
        }
      }
    } catch (err: any) {
      errors.push({ query, error: err?.message ?? "search failed" });
    }
    if (i < queries.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  const videos = [...byId.values()].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
  return { videos, errors };
}
