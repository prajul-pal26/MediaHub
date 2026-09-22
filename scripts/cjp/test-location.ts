/** Confirm location now flows through fetchHashtagMedia. */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchHashtagMedia } from "../../src/server/services/instagram/fetcher";

const TAG = process.argv[2] || "lucknow";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db.from("insta_sessions").select("session_id_encrypted")
    .eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const session = decrypt(data!.session_id_encrypted);

  const r = await fetchHashtagMedia(TAG, session, 30);
  const withLoc = r.items.filter((i) => i.location);
  console.log(`#${r.tag}: ${r.items.length} items, ${withLoc.length} geotagged\n`);
  for (const i of withLoc) {
    const L = i.location!;
    console.log(`  ${i.kind.padEnd(8)} ${i.url}`);
    console.log(`    ${L.name}  (${L.lat}, ${L.lng})  id=${L.id}  short=${L.shortName}`);
  }
  if (!withLoc.length) console.log("  (no geotagged posts in this sample)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
