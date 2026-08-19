/**
 * fetch-insta-metrics.mjs — likes / comments / views for ARBITRARY Instagram post URLs.
 *
 * WHY THIS EXISTS
 *   MediaHub could already read Instagram, but every entry point is keyed on an ACCOUNT or a
 *   HASHTAG — fetchUserFeed(userId), fetchHashtagMedia(tag), fetchProfiles(usernames). None of
 *   them answers "what are the stats for THIS permalink?", which is what you need when the links
 *   come from a spreadsheet of third-party reporters rather than from a connected brand.
 *   post_analytics can't help either: it only covers posts published THROUGH MediaHub.
 *
 * HOW
 *   Instagram shortcodes are plain base64 over "A-Za-z0-9-_", so shortcode -> numeric media_id is
 *   arithmetic, no lookup. /api/v1/media/{id}/info/ then returns the counts, using the same header
 *   set and session-cookie normalisation as src/server/services/instagram/fetcher.ts.
 *
 * SESSION
 *   Reads the org's active session from insta_sessions (AES-256-GCM, TOKEN_ENCRYPTION_KEY), so it
 *   reuses whatever the app already has. Must run where that key exists — i.e. inside mediahub-app.
 *
 * RATE LIMITS — deliberately slow. fetcher.ts carries InstaRateLimitError, a proxy dispatcher and
 *   randomised delays because Instagram blocks on velocity. One request every ~2.5-5s, sequential.
 *   Do not "speed this up" by parallelising: a killed session costs far more than the minutes saved.
 *
 * Usage (inside the container):  node fetch-insta-metrics.mjs < urls.txt > out.jsonl
 */
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function decrypt(text) {
  const [ivHex, tagHex, enc] = text.split(":");
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(enc, "hex", "utf8") + d.final("utf8");
}

/** /reel/<code>/, /p/<code>/, /tv/<code>/ -> shortcode */
export function shortcodeOf(url) {
  const m = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? m[1] : null;
}

/** Base64 over the IG alphabet — positional, so it is exact for any length. */
export function mediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) {
    const i = B64.indexOf(ch);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

/** Same normalisation as fetcher.ts: accept a full cookie string OR a bare sessionid. */
function cookieFrom(raw) {
  let cookie = /(^|;\s*)[a-zA-Z_]+=/.test(raw) ? raw.replace(/\s*;\s*/g, "; ").trim() : `sessionid=${raw}`;
  if (!/(^|;\s*)ds_user_id=/.test(cookie)) {
    const sess = /sessionid=([^;]+)/.exec(cookie)?.[1] ?? raw;
    const uid = decodeURIComponent(sess).split(":")[0];
    if (/^\d+$/.test(uid)) cookie += `; ds_user_id=${uid}`;
  }
  return cookie;
}

function headers(cookie) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest",
    "x-ig-www-claim": "0",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    // The Sec-Fetch-* trio is REQUIRED — without it Instagram serves a bot challenge.
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Referer: "https://www.instagram.com/",
    Cookie: cookie,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 2500 + Math.floor(Math.random() * 2500);   // 2.5–5.0s

async function fetchOne(url, H) {
  const sc = shortcodeOf(url);
  if (!sc) return { url, ok: false, error: "unparseable_url" };
  const id = mediaId(sc);
  if (!id) return { url, ok: false, error: "bad_shortcode" };

  let res;
  try {
    res = await fetch(`https://www.instagram.com/api/v1/media/${id}/info/`, { headers: H });
  } catch (e) {
    return { url, shortcode: sc, ok: false, error: `network:${e.message}` };
  }
  if (res.status === 429) return { url, shortcode: sc, ok: false, error: "rate_limited" };
  if (res.status === 404) return { url, shortcode: sc, ok: false, error: "not_found_or_deleted" };
  if (res.status === 401 || res.status === 403)
    return { url, shortcode: sc, ok: false, error: `auth_${res.status}` };
  if (!res.ok) return { url, shortcode: sc, ok: false, error: `http_${res.status}` };

  let it;
  try {
    it = JSON.parse(await res.text())?.items?.[0];
  } catch {
    return { url, shortcode: sc, ok: false, error: "bad_json" };
  }
  if (!it) return { url, shortcode: sc, ok: false, error: "empty_response" };

  // Everything below is already in the SAME response — no extra request, no extra rate-limit cost.
  // Probed against a live item rather than assumed: share_count and save_count are NOT returned by
  // this endpoint at all, so they are deliberately absent rather than emitted as a misleading 0.
  const MEDIA_TYPE = { 1: "image", 2: "video", 8: "carousel" };
  return {
    url,
    shortcode: sc,
    ok: true,
    owner: it?.user?.username ?? "",
    owner_name: it?.user?.full_name ?? "",
    owner_verified: it?.user?.is_verified ?? null,
    likes: it?.like_count ?? null,
    comments: it?.comment_count ?? null,
    // Reels report play_count; older video posts use view_count. Keep them distinct from null
    // (a real 0) so "we could not read it" never masquerades as "nobody watched it".
    views: it?.play_count ?? it?.ig_play_count ?? it?.view_count ?? null,
    // product_type "clips" = Reel, "feed" = normal post, "igtv" = long video.
    post_type: it?.product_type ?? MEDIA_TYPE[it?.media_type] ?? "",
    duration_sec: it?.video_duration != null ? Math.round(it.video_duration * 10) / 10 : null,
    posted_at: it?.taken_at ? new Date(it.taken_at * 1000).toISOString() : null,
    caption: (it?.caption?.text ?? "").replace(/\s+/g, " ").slice(0, 300),
    location: it?.location?.name ?? "",
    taken_at: it?.taken_at ?? null,
  };
}

const urls = readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const session = decrypt(process.env.ENC_SESSION);
const H = headers(cookieFrom(session));

let ok = 0, fail = 0;
for (let i = 0; i < urls.length; i++) {
  const r = await fetchOne(urls[i], H);
  r.ok ? ok++ : fail++;
  process.stdout.write(JSON.stringify(r) + "\n");
  process.stderr.write(`  [${i + 1}/${urls.length}] ${r.ok ? "ok" : "FAIL " + r.error}\n`);
  if (r.error === "rate_limited") {
    process.stderr.write("  rate limited — pausing 60s\n");
    await sleep(60000);
  }
  if (i < urls.length - 1) await sleep(jitter());
}
process.stderr.write(`\ndone: ${ok} ok, ${fail} failed\n`);
