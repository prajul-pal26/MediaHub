/** Does Instagram's hashtag payload carry location data for posts/reels? */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeSession } from "../../src/server/services/instagram/fetcher";

const TAG = process.argv[2] || "lucknow";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db.from("insta_sessions").select("session_id_encrypted")
    .eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const s = normalizeSession(decrypt(data!.session_id_encrypted));

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "X-IG-App-ID": "936619743392459",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    Cookie: s.cookie,
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const res = await fetch(
    `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(TAG)}`,
    { headers, cache: "no-store" },
  );
  const j: any = await res.json();
  console.log(`#${TAG}  HTTP ${res.status}`);

  // Gather media nodes the same way fetchHashtagMedia does.
  const nodes: any[] = [];
  for (const key of ["top", "recent"]) {
    for (const sec of j?.data?.[key]?.sections ?? []) {
      const medias = sec?.layout_content?.medias;
      if (Array.isArray(medias)) for (const it of medias) if (it?.media) nodes.push(it.media);
    }
  }
  console.log(`media nodes: ${nodes.length}\n`);

  let withLoc = 0;
  for (const m of nodes) {
    if (m?.location) {
      withLoc++;
      if (withLoc <= 4) {
        console.log(`  code=${m.code} location keys: ${Object.keys(m.location).join(", ")}`);
        console.log(`    ${JSON.stringify(m.location).slice(0, 300)}`);
      }
    }
  }
  console.log(`\nnodes WITH location: ${withLoc}/${nodes.length}`);

  // Any other geo-ish fields hiding elsewhere on the media object?
  const geoKeys = new Set<string>();
  for (const m of nodes) {
    for (const k of Object.keys(m ?? {})) {
      if (/loc|geo|lat|lng|place|city|venue/i.test(k)) geoKeys.add(k);
    }
  }
  console.log(`other geo-ish top-level keys seen: ${[...geoKeys].join(", ") || "(none)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
