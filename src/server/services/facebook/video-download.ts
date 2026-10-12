// Facebook video extractor for a public video/reel/watch link. Tries a fast
// logged-out HTML/mbasic fetch first, then falls back to the shared headless
// Chromium pool (which accepts the cookie-consent dialog and captures the
// stream from Facebook's GraphQL responses) — this is what lets genuinely
// public videos resolve without a logged-in session. Returns direct MP4 URLs
// (HD + SD) plus thumbnail/title, which the UI downloads through the
// /api/insta-media proxy (fbcdn.net is already whitelisted there).

export interface FbVideoVersion {
  url: string;
  quality: "HD" | "SD";
  resolution: string;
}

export interface FbVideoDownloadInfo {
  ok: boolean;
  url: string;
  videoUrl?: string | null;
  videoVersions: FbVideoVersion[];
  thumbnailUrl?: string | null;
  title?: string | null;
  ownerName?: string | null;
  videoId?: string | null;
  error?: string;
}

// Decode a JSON-escaped string fragment (\/, \uXXXX, %, &amp; …).
function decodeFragment(raw: string): string {
  let out = raw;
  try {
    out = JSON.parse(`"${raw}"`);
  } catch {
    out = raw.replace(/\\\//g, "/").replace(/\\u0025/g, "%").replace(/\\u0026/g, "&");
  }
  return out
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Grab the first capture of the first pattern that matches.
function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return decodeFragment(m[1]);
  }
  return null;
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /\/videos\/(?:[^/]+\/)?(\d{6,})/i,
    /\/reel\/(\d{6,})/i,
    /[?&]v=(\d{6,})/i,
    /\/watch\/\?v=(\d{6,})/i,
    /video_id["=:/](\d{6,})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return null;
}

async function fetchHtml(url: string, cookies?: string): Promise<{ ok: boolean; status: number; html: string }> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  // A consent cookie suppresses Facebook's logged-out consent interstitial,
  // which otherwise hides the video JSON from server-side fetches.
  headers["Cookie"] = `${cookies ? cookies + "; " : ""}locale=en_US`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: controller.signal, cache: "no-store" });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchFacebookVideoDetails(
  inputUrl: string,
  cookies?: string
): Promise<FbVideoDownloadInfo> {
  const url = (inputUrl || "").trim();
  if (!/^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch|fb\.com)\//i.test(url)) {
    return {
      ok: false,
      url,
      videoVersions: [],
      error:
        "Invalid Facebook link. Paste a public video, reel or watch URL (e.g. https://www.facebook.com/watch/?v=123... or https://fb.watch/...).",
    };
  }

  let html = "";
  try {
    const res = await fetchHtml(url, cookies);
    if (!res.ok) {
      return { ok: false, url, videoVersions: [], error: `Facebook returned HTTP ${res.status}. The video may be private or removed.` };
    }
    html = res.html;
  } catch (err: any) {
    return { ok: false, url, videoVersions: [], error: `Could not reach Facebook: ${err?.message || "network error"}.` };
  }

  // Fallback: the lightweight mbasic site exposes a direct video_redirect link
  // and is far less likely to gate behind the consent interstitial.
  const videoId = extractVideoId(url);
  if (!/playable_url/.test(html) && videoId) {
    try {
      const mb = await fetchHtml(`https://mbasic.facebook.com/watch/?v=${videoId}`, cookies);
      const redirect = /\/video_redirect\/\?src=([^"&]+)/.exec(mb.html);
      if (redirect?.[1]) {
        const direct = decodeFragment(decodeURIComponent(redirect[1]));
        const thumb = firstMatch(mb.html, [/<img[^>]+src="([^"]+)"[^>]*class="[^"]*\bimg\b/]);
        return {
          ok: true,
          url,
          videoUrl: direct,
          videoVersions: [{ url: direct, quality: "SD", resolution: "SD" }],
          thumbnailUrl: thumb,
          title: firstMatch(mb.html, [/<title>([^<]+)<\/title>/]),
          ownerName: null,
          videoId,
        };
      }
    } catch {}
  }

  // Try to read the stream straight from the fetched HTML (fast path).
  const streams = extractStreams(html);
  if (streams.hd || streams.sd) {
    const thumbnailUrl = firstMatch(html, [
      /"preferred_thumbnail":\{"image":\{"uri":"([^"]+)"/,
      /"thumbnailImage":\{"uri":"([^"]+)"/,
      /<meta property="og:image" content="([^"]+)"/,
    ]);
    const title = firstMatch(html, [
      /<meta property="og:title" content="([^"]+)"/,
      /"title":\{"text":"([^"]+)"/,
    ]);
    const ownerName = firstMatch(html, [
      /"owner":\{"__typename":"[^"]*","name":"([^"]+)"/,
      /"actors":\[\{"__typename":"[^"]*","name":"([^"]+)"/,
    ]);
    return buildResult(url, streams, thumbnailUrl, title, ownerName, videoId);
  }

  // Modern Facebook loads the stream via an authenticated GraphQL call made only
  // after the consent handshake — logged-out HTML fetches get a consent shell.
  // A real (headless) browser accepts consent and runs that call, so we reuse the
  // shared Chromium pool to capture the stream (works for public videos even
  // without a session; a session, when present, also unlocks gated content).
  try {
    const viaBrowser = await fetchViaBrowser(url, cookies);
    if (viaBrowser) {
      return buildResult(url, viaBrowser.streams, viaBrowser.thumbnailUrl, viaBrowser.title, null, videoId, viaBrowser.progressiveMp4);
    }
  } catch (err) {
    console.warn(`[fetchFacebookVideoDetails] browser extraction failed: ${(err as any)?.message}`);
  }

  // Still nothing — distinguish a login/consent wall from a genuinely empty link.
  if (/login_form|checkpoint|"__isLoggedIn":false/.test(html)) {
    return {
      ok: false,
      url,
      videoVersions: [],
      error: "Facebook would not serve this video without signing in. It may be private or age/region-restricted. For restricted content, refresh the Facebook session in Settings → Facebook.",
    };
  }
  return {
    ok: false,
    url,
    videoVersions: [],
    error: "No downloadable video stream was found at this link. Make sure it points to a public Facebook video or reel.",
  };
}

function extractStreams(text: string): { hd: string | null; sd: string | null } {
  const hd = firstMatch(text, [
    /"playable_url_quality_hd":"([^"]+)"/,
    /"browser_native_hd_url":"([^"]+)"/,
    /"hd_src(?:_no_ratelimit)?":"([^"]+)"/,
  ]);
  const sd = firstMatch(text, [
    /"playable_url":"([^"]+)"/,
    /"browser_native_sd_url":"([^"]+)"/,
    /"sd_src(?:_no_ratelimit)?":"([^"]+)"/,
  ]);
  return { hd, sd };
}

function buildResult(
  url: string,
  streams: { hd: string | null; sd: string | null },
  thumbnailUrl: string | null | undefined,
  title: string | null | undefined,
  ownerName: string | null | undefined,
  videoId: string | null,
  progressiveMp4?: string | null
): FbVideoDownloadInfo {
  const versions: FbVideoVersion[] = [];
  if (streams.hd) versions.push({ url: streams.hd, quality: "HD", resolution: "HD" });
  if (streams.sd && streams.sd !== streams.hd) versions.push({ url: streams.sd, quality: "SD", resolution: "SD" });
  if (versions.length === 0 && progressiveMp4) versions.push({ url: progressiveMp4, quality: "SD", resolution: "SD" });
  return {
    ok: versions.length > 0,
    url,
    videoUrl: versions[0]?.url || null,
    videoVersions: versions,
    thumbnailUrl: thumbnailUrl || null,
    title: title || null,
    ownerName: ownerName || null,
    videoId,
    ...(versions.length === 0 ? { error: "No downloadable video stream was found at this link." } : {}),
  };
}

// Headless-browser extraction: load the page, accept the cookie consent dialog,
// and capture the video stream from the GraphQL responses (or a progressive MP4
// media request as a fallback).
async function fetchViaBrowser(
  url: string,
  cookies?: string
): Promise<{ streams: { hd: string | null; sd: string | null }; thumbnailUrl: string | null; title: string | null; progressiveMp4: string | null } | null> {
  const { withFacebookContext } = await import("./browser-pool");

  return withFacebookContext(cookies || "", async (ctx) => {
    const page = await ctx.newPage();
    let hd: string | null = null;
    let sd: string | null = null;
    let progressiveMp4: string | null = null;

    page.on("response", async (resp) => {
      if (hd && sd) return;
      const u = resp.url();
      try {
        if (/\/api\/graphql|graphql\//.test(u)) {
          const body = await resp.text();
          if (body && body.includes("playable_url")) {
            const s = extractStreams(body);
            hd = hd || s.hd;
            sd = sd || s.sd;
          }
        } else if (!progressiveMp4 && /\.mp4/i.test(u) && /fbcdn\.net/i.test(u)) {
          // Progressive single-file MP4 (common for reels / short videos).
          progressiveMp4 = u.split("&bytestart=")[0];
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Dismiss the cookie-consent interstitial if present (several locales/labels).
    for (const label of [/allow all cookies/i, /accept all/i, /allow all/i, /only allow essential/i, /accept/i]) {
      try {
        const btn = page.getByRole("button", { name: label });
        if (await btn.count()) {
          await btn.first().click({ timeout: 2500 });
          break;
        }
      } catch {}
    }

    // Give the player's GraphQL call time to land.
    try {
      await page.waitForFunction(() => !!document.querySelector("video"), { timeout: 10000 });
    } catch {}
    for (let i = 0; i < 6 && !hd && !sd; i++) {
      await page.waitForTimeout(800);
    }

    let thumbnailUrl: string | null = null;
    let title: string | null = null;
    try {
      thumbnailUrl = await page.getAttribute('meta[property="og:image"]', "content");
    } catch {}
    try {
      title = (await page.title()) || null;
    } catch {}

    // Last resort: re-scan the fully rendered HTML.
    if (!hd && !sd) {
      try {
        const rendered = await page.content();
        const s = extractStreams(rendered);
        hd = s.hd;
        sd = s.sd;
      } catch {}
    }

    if (!hd && !sd && !progressiveMp4) return null;
    return { streams: { hd, sd }, thumbnailUrl, title, progressiveMp4 };
  });
}
