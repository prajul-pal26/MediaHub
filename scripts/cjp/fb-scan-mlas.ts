/** Which MLAs have Facebook surfaces that actually yield posts? */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { readFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { scrapeProfilePostsViaHtml } from "../../src/server/services/facebook/html-profile-scraper";

const MLA_ROOT = "/Users/pranjul/workspace/governance_report/Current MLA";
const LIMIT = Number(process.argv[2] || 14);

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db
    .from("fb_sessions")
    .select("cookie_encrypted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cookies = decrypt(data!.cookie_encrypted);

  const roster = Papa.parse<Record<string, string>>(readFileSync(join(MLA_ROOT, "up_mla_403.csv"), "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data.filter((r) => (r.facebook_profile ?? "").trim());

  console.log(`scanning ${LIMIT} of ${roster.length} MLAs with a facebook_profile\n`);
  const winners: { ac: string; name: string; url: string; posts: number; engaged: number }[] = [];

  for (const mla of roster.slice(0, LIMIT)) {
    const url = mla.facebook_profile.trim();
    try {
      const r = await scrapeProfilePostsViaHtml(url, cookies);
      // Posts carrying real engagement are the ones worth harvesting.
      const engaged = r.posts.filter((p) => p.likes + p.comments + p.shares > 0).length;
      const flag = engaged > 0 ? "GOOD" : r.posts.length ? "thin" : "none";
      console.log(
        `  [${flag}] ac_no=${String(mla.ac_no).padStart(3)} ${String(mla.mla_name).slice(0, 24).padEnd(24)} posts=${String(r.posts.length).padStart(2)} engaged=${String(engaged).padStart(2)}  ${url.slice(0, 52)}`,
      );
      if (engaged > 0) winners.push({ ac: mla.ac_no, name: mla.mla_name, url, posts: r.posts.length, engaged });
    } catch (e: any) {
      console.log(`  [ERR ] ac_no=${String(mla.ac_no).padStart(3)} ${String(mla.mla_name).slice(0, 24).padEnd(24)} ${String(e.message).slice(0, 50)}`);
    }
    await new Promise((res) => setTimeout(res, 2500));
  }

  console.log(`\n=== USABLE (${winners.length}) ===`);
  for (const w of winners.sort((a, b) => b.engaged - a.engaged)) {
    console.log(`  ac_no=${w.ac} ${w.name} — ${w.engaged} engaged posts — ${w.url}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
