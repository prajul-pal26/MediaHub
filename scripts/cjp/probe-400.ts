/**
 * Is an HTTP 400 from the profile endpoint permanent (dead handle) or transient
 * (throttle/blip)? Permanent is fine — expected roster attrition. Transient
 * would mean the roster run is silently dropping valid MLAs and needs a retry.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchInstagramProfile } from "../../src/server/services/instagram/fetcher";

const NAMES = process.argv.slice(2);
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

  for (const name of NAMES) {
    // Three spaced attempts: a consistent 400 is a dead handle, an
    // intermittent one is throttling.
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        const p = await fetchInstagramProfile(name, session);
        outcomes.push(`OK(followers=${p.followers}, posts=${p.postsCount}, private=${p.isPrivate})`);
      } catch (e: any) {
        outcomes.push(`ERR(${String(e?.message ?? e).slice(0, 60)})`);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    const allErr = outcomes.every((o) => o.startsWith("ERR"));
    console.log(`@${name}`);
    for (const [i, o] of outcomes.entries()) console.log(`   attempt ${i + 1}: ${o}`);
    console.log(`   VERDICT: ${allErr ? "PERMANENT (dead/renamed handle)" : "TRANSIENT — retry would recover it"}\n`);
  }

  // Control: a handle known to work, to prove the session is healthy.
  try {
    const p = await fetchInstagramProfile("officialumarmla", session);
    console.log(`control @officialumarmla: OK (followers=${p.followers}) — session is healthy`);
  } catch (e: any) {
    console.log(`control FAILED: ${e?.message} — session may be degrading`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
