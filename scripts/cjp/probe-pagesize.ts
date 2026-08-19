/**
 * Can we get more than ~15 comments per request?
 * Page size is the highest-leverage variable: 15 -> 50 would be a 3.3x win.
 * Try every plausible size/sort parameter and report what actually changes.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeSession } from "../../src/server/services/instagram/fetcher";

const MEDIA_ID = process.argv[2] || "3963510110499812330";
const APP_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";

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
  const s = normalizeSession(decrypt(data!.session_id_encrypted));
  const headers: Record<string, string> = {
    "User-Agent": APP_UA,
    "X-IG-App-ID": "936619743392459",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    Cookie: s.cookie,
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const BASE = "can_support_threading=true&permalink_enabled=false";
  const trials: [string, string][] = [
    ["baseline", BASE],
    ["count=50", `${BASE}&count=50`],
    ["amount=50", `${BASE}&amount=50`],
    ["first=50", `${BASE}&first=50`],
    ["page_size=50", `${BASE}&page_size=50`],
    ["count=100", `${BASE}&count=100`],
    ["sort=recent", `${BASE}&sort_order=recent`],
    ["sort=popular", `${BASE}&sort_order=popular`],
    ["no-threading", "permalink_enabled=false"],
    ["threading+count", "can_support_threading=true&count=50"],
    ["analytics_module", `${BASE}&analytics_module=comments_v2`],
    ["inline_replies", `${BASE}&count=50&can_support_threading=true&inline_replies=true`],
  ];

  console.log(`media ${MEDIA_ID}\n`);
  console.log("trial".padEnd(20), "top".padStart(4), "replies".padStart(8), "total".padStart(6), "ms".padStart(6));
  console.log("-".repeat(50));

  let best = { label: "", count: 0 };
  for (const [label, qs] of trials) {
    const t0 = Date.now();
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/?${qs}`,
        { headers, cache: "no-store" },
      );
      const ms = Date.now() - t0;
      const j: any = await res.json().catch(() => null);
      const top = Array.isArray(j?.comments) ? j.comments.length : 0;
      const replies = Array.isArray(j?.comments)
        ? j.comments.reduce(
            (a: number, c: any) => a + (Array.isArray(c?.preview_child_comments) ? c.preview_child_comments.length : 0),
            0,
          )
        : 0;
      console.log(
        label.padEnd(20),
        String(top).padStart(4),
        String(replies).padStart(8),
        String(top + replies).padStart(6),
        String(ms).padStart(6),
        j?.message ? `  msg=${j.message}` : "",
      );
      if (top + replies > best.count) best = { label, count: top + replies };
    } catch (e: any) {
      console.log(label.padEnd(20), `  threw ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2200));
  }

  console.log(`\nBEST: ${best.label} => ${best.count} comments/request`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
