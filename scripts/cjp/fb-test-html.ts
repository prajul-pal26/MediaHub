/** Does the HTML story extractor actually pull real posts? */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { scrapeProfilePostsViaHtml } from "../../src/server/services/facebook/html-profile-scraper";

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["https://www.facebook.com/CockroachJantaParty", "https://www.facebook.com/officeumaralikhan"];

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

  for (const t of TARGETS) {
    try {
      const r = await scrapeProfilePostsViaHtml(t, cookies);
      console.log(`\n=== ${t}`);
      console.log(`  profile: ${r.profileName}   html=${r.htmlLength.toLocaleString()} bytes`);
      console.log(`  posts extracted: ${r.posts.length}`);
      for (const p of r.posts.slice(0, 8)) {
        console.log(
          `    id=${p.postId.slice(0, 18)} likes=${String(p.likes).padStart(5)} comments=${String(p.comments).padStart(4)} shares=${String(p.shares).padStart(4)} ${p.createdAt?.slice(0, 16) ?? "?"}`,
        );
        console.log(`       owner=${p.ownerName ?? "?"}  url=${p.url ?? "(none)"}`);
        if (p.text) console.log(`       text: ${p.text.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    } catch (e: any) {
      console.log(`\n=== ${t}\n  FAILED: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
