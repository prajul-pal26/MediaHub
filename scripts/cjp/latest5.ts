/** List the newest N posts of an account: media id, shortcode, comment count. */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchInstagramProfile, fetchUserFeed } from "../../src/server/services/instagram/fetcher";

const TARGET = process.argv[2] || "myogi_adityanath";
const N = Number(process.argv[3] || 5);

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

  const profile = await fetchInstagramProfile(TARGET, session);
  const feed = await fetchUserFeed(profile.id, session, N);

  console.log(`@${TARGET} — newest ${feed.items.length} posts`);
  let total = 0;
  for (const [i, it] of feed.items.slice(0, N).entries()) {
    total += it.comments;
    const when = it.takenAt ? new Date(it.takenAt * 1000).toISOString().slice(0, 16) : "?";
    console.log(
      `${i + 1}. id=${it.id} code=${it.shortcode} kind=${it.kind} ${when} likes=${it.likes} comments=${it.comments}`,
    );
    console.log(`   ${it.url}`);
  }
  console.log(`\nTOTAL comments across these ${Math.min(N, feed.items.length)} posts: ${total.toLocaleString()}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
