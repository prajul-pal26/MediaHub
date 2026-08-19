/** Is the stored Facebook session alive right now? */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { establishGraphqlSession } from "../../src/server/services/facebook/graphql-scraper";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data: rows } = await db
    .from("fb_sessions")
    .select("id, label, c_user, status, last_error, last_checked_at")
    .order("created_at", { ascending: false });

  if (!rows?.length) return console.log("No Facebook sessions stored at all.");

  for (const r of rows) {
    console.log(`\n[${r.label ?? "unnamed"}] c_user=${r.c_user ?? "?"} db_status=${r.status}`);
    if (r.last_error) console.log(`  last_error: ${r.last_error}`);

    const { data: full } = await db
      .from("fb_sessions")
      .select("cookie_encrypted")
      .eq("id", r.id)
      .maybeSingle();
    if (!full?.cookie_encrypted) {
      console.log("  no cookie stored");
      continue;
    }
    try {
      const s = await establishGraphqlSession(decrypt(full.cookie_encrypted));
      console.log(`  LIVE — fb_dtsg harvested, user ${s.userId}`);
    } catch (e: any) {
      console.log(`  DEAD — ${e?.message ?? e}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
