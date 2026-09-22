/**
 * Fetch one post/reel by shortcode: caption, location, engagement.
 *
 * Instagram's media endpoints key off a numeric media_id, not the shortcode in
 * the URL. The shortcode is that id base64-encoded with a URL-safe alphabet, so
 * decoding it locally avoids an extra lookup request.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeSession } from "../../src/server/services/instagram/fetcher";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const APP_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";

/** Shortcode -> numeric media id (base64 over Instagram's URL-safe alphabet). */
function shortcodeToMediaId(shortcode: string): string {
  let id = 0n;
  for (const ch of shortcode) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`Unexpected character "${ch}" in shortcode`);
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

function shortcodeFromUrl(input: string): string {
  const m = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i.exec(input);
  return m ? m[1] : input.trim();
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("pass a post URL or shortcode");
  const shortcode = shortcodeFromUrl(raw);
  const mediaId = shortcodeToMediaId(shortcode);
  console.log(`shortcode: ${shortcode}`);
  console.log(`media_id : ${mediaId}\n`);

  const { data } = await db.from("insta_sessions").select("session_id_encrypted")
    .eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const s = normalizeSession(decrypt(data!.session_id_encrypted));

  const headers: Record<string, string> = {
    "User-Agent": APP_UA,
    "X-IG-App-ID": "936619743392459",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    Cookie: s.cookie,
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers, cache: "no-store",
  });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`HTTP ${res.status}: got HTML, not JSON`);
  const j: any = JSON.parse(text);
  const m = j?.items?.[0];
  if (!m) throw new Error(`No media returned (HTTP ${res.status}) ${j?.message ?? ""}`);

  console.log("=== POST ===");
  console.log(`  url        : https://www.instagram.com/reel/${shortcode}/`);
  console.log(`  type       : ${m.product_type ?? (m.media_type === 2 ? "video" : "post")}`);
  console.log(`  owner      : @${m.user?.username}  (${m.user?.full_name ?? ""})`);
  console.log(`  posted     : ${m.taken_at ? new Date(m.taken_at * 1000).toISOString() : "?"}`);
  console.log(`  likes      : ${m.like_count ?? "-"}`);
  console.log(`  comments   : ${m.comment_count ?? "-"}`);
  console.log(`  plays/views: ${m.play_count ?? m.view_count ?? m.ig_play_count ?? "-"}`);

  console.log("\n=== LOCATION ===");
  if (m.location) {
    const L = m.location;
    console.log(`  name    : ${L.name}`);
    console.log(`  short   : ${L.short_name ?? "-"}`);
    console.log(`  address : ${L.address || "-"}`);
    console.log(`  city    : ${L.city || "-"}`);
    console.log(`  lat,lng : ${L.lat ?? "-"}, ${L.lng ?? "-"}`);
    console.log(`  id      : ${L.pk ?? "-"}   fb_places_id: ${L.facebook_places_id ?? "-"}`);
    if (L.lat != null) console.log(`  maps    : https://www.google.com/maps/search/?api=1&query=${L.lat},${L.lng}`);
  } else {
    console.log("  (no location tagged on this post)");
  }

  console.log("\n=== FULL CAPTION ===");
  const cap = m.caption?.text ?? "";
  console.log(cap ? cap : "  (no caption)");
  console.log(`\n  caption length: ${cap.length} chars`);
  const tags = cap.match(/#[\wऀ-ॿ]+/g) ?? [];
  console.log(`  hashtags (${tags.length}): ${tags.join(" ") || "-"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
