/** Find the real pagination cursor field on the comments endpoint. */
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

  const get = async (qs: string) => {
    const res = await fetch(
      `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/${qs}`,
      { headers, cache: "no-store" },
    );
    return res.json().catch(() => null);
  };

  const j1: any = await get("?can_support_threading=true&permalink_enabled=false");
  console.log("=== PAGE 1 — all top-level keys ===");
  console.log(Object.keys(j1 ?? {}).join("\n"));
  console.log("\n=== pagination-ish values ===");
  for (const k of Object.keys(j1 ?? {})) {
    if (/more|cursor|min_id|max_id|next|token|page/i.test(k)) {
      const v = (j1 as any)[k];
      console.log(`  ${k} = ${typeof v === "object" ? JSON.stringify(v).slice(0, 120) : v}`);
    }
  }
  console.log(`\n  comments returned: ${j1?.comments?.length}`);
  console.log(`  comment_count    : ${j1?.comment_count}`);

  // Try each plausible cursor and see if page 2 differs.
  const firstIds = new Set((j1?.comments ?? []).map((c: any) => String(c.pk)));
  const candidates: [string, any][] = [
    ["next_min_id", j1?.next_min_id],
    ["next_max_id", j1?.next_max_id],
    ["min_id", j1?.min_id],
    ["max_id", j1?.max_id],
    ["scroll_anchor", j1?.scroll_anchor],
  ];

  for (const [name, value] of candidates) {
    if (value == null) continue;
    const cursor = typeof value === "string" ? value : JSON.stringify(value);
    await new Promise((r) => setTimeout(r, 2000));
    const j2: any = await get(
      `?can_support_threading=true&permalink_enabled=false&${name === "next_max_id" ? "max_id" : "min_id"}=${encodeURIComponent(cursor)}`,
    );
    const ids = (j2?.comments ?? []).map((c: any) => String(c.pk));
    const fresh = ids.filter((id: string) => !firstIds.has(id));
    console.log(
      `\n  [${name}] -> page2 returned ${ids.length}, NEW=${fresh.length} ${fresh.length ? "<-- WORKS" : ""}`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
