/**
 * Playwright renders only ~2.7KB for a Facebook profile, while a plain fetch
 * with correct browser headers returns ~4.3MB of logged-in HTML. So the HTTP
 * path is the better surface: Facebook ships feed data as embedded JSON.
 * Find out what post-shaped data is actually in there.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeCookies } from "../../src/server/services/facebook/scraper-types";
import { fbNavigationHeaders } from "../../src/server/services/facebook/headers";

const TARGET = process.argv[2] || "https://www.facebook.com/CockroachJantaParty";

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
  const { cookie } = normalizeCookies(decrypt(data!.cookie_encrypted));

  const res = await fetch(TARGET, { headers: fbNavigationHeaders(cookie), redirect: "follow" });
  const html = await res.text();
  console.log(`HTTP ${res.status}  len=${html.length}  final=${res.url}`);

  const count = (re: RegExp) => (html.match(re) ?? []).length;
  console.log(`\n=== post-shaped markers in the HTML ===`);
  console.log(`  "pfbid" occurrences        : ${count(/pfbid[A-Za-z0-9]+/g)}`);
  console.log(`  /posts/ links              : ${count(/\/posts\//g)}`);
  console.log(`  /videos/ links             : ${count(/\/videos\//g)}`);
  console.log(`  /reel/ links               : ${count(/\/reel\//g)}`);
  console.log(`  "story_fbid"               : ${count(/story_fbid/g)}`);
  console.log(`  "creation_time"            : ${count(/creation_time/g)}`);
  console.log(`  "feedback" objects         : ${count(/"feedback"/g)}`);
  console.log(`  "reaction_count"           : ${count(/reaction_count/g)}`);
  console.log(`  "share_count"              : ${count(/share_count/g)}`);
  console.log(`  "total_comment_count"      : ${count(/total_comment_count/g)}`);
  console.log(`  "message":{"text"          : ${count(/"message":\{"text"/g)}`);
  console.log(`  ProfileCometTimeline       : ${count(/ProfileCometTimeline/g)}`);
  console.log(`  "__typename":"Story"       : ${count(/"__typename":"Story"/g)}`);

  // Unique post ids actually present
  const pfbids = [...new Set([...html.matchAll(/pfbid[A-Za-z0-9]{20,}/g)].map((m) => m[0]))];
  console.log(`\n  unique pfbid post ids: ${pfbids.length}`);
  for (const id of pfbids.slice(0, 8)) console.log(`    ${id.slice(0, 42)}…`);

  // Sample a feedback object to see which count fields travel together.
  const fb = /"feedback":\{[\s\S]{0,600}?\}/.exec(html);
  if (fb) console.log(`\n  sample feedback blob:\n    ${fb[0].slice(0, 400).replace(/\s+/g, " ")}`);

  const msg = /"message":\{"text":"([^"]{20,200})"/.exec(html);
  if (msg) console.log(`\n  sample post text: ${msg[1].slice(0, 160)}`);

  const out = "/private/tmp/claude-501/-Users-pranjul-workspace-MediaHub/90b7c277-4ff9-423c-9412-684390e1366e/scratchpad/fb_profile.html";
  writeFileSync(out, html, "utf8");
  console.log(`\n  saved HTML for inspection: ${out}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
