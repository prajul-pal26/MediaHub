/** Timed sample: measure real comments-per-second so the ETA is measured, not guessed. */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchMediaComments } from "../../src/server/services/instagram/comments";

const MEDIA_ID = process.argv[2] || "3963510110499812330";
const MAX = Number(process.argv[3] || 200);
const DELAY = Number(process.argv[4] || 1400);
const TOTAL_TARGET = 22170;

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

  console.log(`Timing ${MAX} comments from media ${MEDIA_ID} at ${DELAY}ms pacing…\n`);
  const r = await fetchMediaComments(MEDIA_ID, session, {
    max: MAX,
    delayMs: DELAY,
    onProgress: (n, total, page) => {
      if (page % 3 === 0 || n >= MAX) console.log(`  page ${page}: ${n} comments (post total ${total})`);
    },
  });

  const secs = r.elapsedMs / 1000;
  const perPage = r.comments.length / Math.max(1, r.pagesFetched);
  const rate = r.comments.length / secs;

  console.log(`\n=== MEASURED ===`);
  console.log(`  fetched          : ${r.comments.length} comments`);
  console.log(`  replies included : ${r.comments.filter((c) => c.depth === 1).length}`);
  console.log(`  pages            : ${r.pagesFetched}  (${perPage.toFixed(1)} comments/page)`);
  console.log(`  requests         : ${r.requestCount}`);
  console.log(`  elapsed          : ${secs.toFixed(1)}s`);
  console.log(`  throughput       : ${rate.toFixed(1)} comments/sec`);

  console.log(`\n=== EXTRAPOLATION for all 5 posts (${TOTAL_TARGET.toLocaleString()} comments) ===`);
  const pages = Math.ceil(TOTAL_TARGET / Math.max(1, perPage));
  console.log(`  estimated pages  : ~${pages.toLocaleString()}`);
  for (const d of [1000, 1400, 2000, 3000]) {
    const est = (pages * (d + 450)) / 1000 / 60;
    console.log(`  at ${String(d).padStart(4)}ms pacing: ~${est.toFixed(0)} min`);
  }

  const sample = r.comments.find((c) => c.text);
  if (sample) {
    console.log(`\n  sample: @${sample.username} (${sample.likeCount} likes) ${sample.createdAt?.slice(0, 16)}`);
    console.log(`          "${sample.text.slice(0, 80)}"`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
