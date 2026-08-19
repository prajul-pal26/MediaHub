/**
 * Find a working Instagram comments endpoint.
 * /api/v1/media/{id}/comments/ now serves the SPA shell, while
 * /api/v1/media/{id}/info/ still returns JSON — so the session is fine and only
 * that route moved. Test the mobile host and the GraphQL persisted queries.
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

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const APP_UA = "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

function shape(json: any): string {
  if (!json) return "(not json)";
  const keys = Object.keys(json);
  const bits = [`keys=[${keys.slice(0, 10).join(",")}]`];
  if (Array.isArray(json.comments)) bits.push(`comments=${json.comments.length}`);
  if (json.data) {
    const d = json.data;
    const dk = Object.keys(d);
    bits.push(`data.keys=[${dk.slice(0, 6).join(",")}]`);
    const conn =
      d?.xdt_api__v1__media__media_id__comments__connection ??
      d?.shortcode_media?.edge_media_to_parent_comment;
    if (conn) bits.push(`CONN edges=${(conn.edges ?? []).length}`);
  }
  if (json.message) bits.push(`msg=${json.message}`);
  return bits.join(" ");
}

async function main() {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const s = normalizeSession(decrypt(data!.session_id_encrypted));

  const base = (ua: string): Record<string, string> => {
    const h: Record<string, string> = {
      "User-Agent": ua,
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.instagram.com/",
      Cookie: s.cookie,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (s.csrftoken) h["x-csrftoken"] = s.csrftoken;
    return h;
  };

  // 1. mobile host
  for (const [label, url, ua] of [
    ["i.instagram v1", `https://i.instagram.com/api/v1/media/${MEDIA_ID}/comments/`, APP_UA],
    ["www v1 + app UA", `https://www.instagram.com/api/v1/media/${MEDIA_ID}/comments/`, APP_UA],
  ] as [string, string, string][]) {
    try {
      const res = await fetch(url, { headers: base(ua), cache: "no-store" });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      console.log(`\n[${label}] HTTP ${res.status} len=${text.length} ${shape(json)}`);
      if (!json) console.log(`   head: ${text.slice(0, 100)}`);
    } catch (e: any) {
      console.log(`\n[${label}] threw ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 2. harvest a comments doc_id from the post page, then POST GraphQL
  if (SHORTCODE) {
    console.log(`\n=== harvesting doc_id from /p/${SHORTCODE}/ ===`);
    const res = await fetch(`https://www.instagram.com/p/${SHORTCODE}/`, {
      headers: base(WEB_UA),
      cache: "no-store",
    });
    const html = await res.text();
    console.log(`  page HTTP ${res.status} len=${html.length}`);

    const ids = [...html.matchAll(/"doc_id"\s*:\s*"(\d+)"/g)].map((m) => m[1]);
    const named = [...html.matchAll(/PolarisPostComment\w*/g)].map((m) => m[0]);
    console.log(`  doc_ids found: ${[...new Set(ids)].slice(0, 8).join(", ") || "(none)"}`);
    console.log(`  comment query names: ${[...new Set(named)].slice(0, 5).join(", ") || "(none)"}`);

    const csrf = /"csrf_token":"([^"]+)"/.exec(html)?.[1] ?? s.csrftoken;

    for (const docId of [...new Set(ids)].slice(0, 6)) {
      const body = new URLSearchParams({
        doc_id: docId,
        variables: JSON.stringify({ media_id: MEDIA_ID, first: 20, sort_order: "popular" }),
        server_timestamps: "true",
      });
      try {
        const r = await fetch("https://www.instagram.com/graphql/query", {
          method: "POST",
          headers: {
            ...base(WEB_UA),
            "Content-Type": "application/x-www-form-urlencoded",
            "x-csrftoken": csrf ?? "",
            Origin: "https://www.instagram.com",
          },
          body,
          cache: "no-store",
        });
        const t = await r.text();
        let j: any = null;
        try {
          j = JSON.parse(t);
        } catch {}
        const sh = shape(j);
        if (/CONN edges=[1-9]/.test(sh) || /comments=[1-9]/.test(sh)) {
          console.log(`  *** doc_id ${docId}: HTTP ${r.status} ${sh}  <-- WORKS`);
        } else {
          console.log(`      doc_id ${docId}: HTTP ${r.status} ${sh.slice(0, 110)}`);
        }
      } catch (e: any) {
        console.log(`      doc_id ${docId}: threw ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1800));
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
