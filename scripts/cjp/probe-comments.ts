/**
 * Why did /api/v1/media/{id}/comments/ return 200 with zero comments?
 * Dump the raw response shape and try endpoint variants to find one that works.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeSession } from "../../src/server/services/instagram/fetcher";

const MEDIA_ID = process.argv[2] || "3963510110499812330";
const SHORTCODE = process.argv[3] || "";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const session = decrypt(data!.session_id_encrypted);
  const s = normalizeSession(session);

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    Cookie: s.cookie,
    Accept: "*/*",
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const variants: [string, string][] = [
    ["v1 plain", `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/`],
    ["v1 threading", `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/?can_support_threading=true&permalink_enabled=false`],
    ["v1 sort", `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/?can_support_threading=true&sort_order=popular`],
    ["v1 info", `https://www.instagram.com/api/v1/media/${MEDIA_ID}/info/`],
  ];

  for (const [label, url] of variants) {
    try {
      const res = await fetch(url, { headers, cache: "no-store" });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      const keys = json ? Object.keys(json).slice(0, 14) : [];
      console.log(`\n[${label}] HTTP ${res.status} len=${text.length}`);
      console.log(`  keys: ${keys.join(", ") || "(none)"}`);
      if (json?.comments) console.log(`  comments array length: ${json.comments.length}`);
      if (json?.comment_count != null) console.log(`  comment_count: ${json.comment_count}`);
      if (json?.message) console.log(`  message: ${json.message}`);
      if (json?.items?.[0]) {
        const it = json.items[0];
        console.log(`  info.comment_count: ${it.comment_count}, comments_disabled: ${it.comments_disabled}`);
      }
      if (!json) console.log(`  body head: ${text.slice(0, 160)}`);
    } catch (e: any) {
      console.log(`\n[${label}] threw: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  if (SHORTCODE) {
    console.log(`\n=== web page embed check for ${SHORTCODE} ===`);
    const res = await fetch(`https://www.instagram.com/p/${SHORTCODE}/`, { headers, cache: "no-store" });
    const html = await res.text();
    console.log(`  HTTP ${res.status}, html len ${html.length}`);
    console.log(`  mentions 'edge_media_to_parent_comment': ${/edge_media_to_parent_comment/.test(html)}`);
    console.log(`  mentions 'comment_count': ${/comment_count/.test(html)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
