/**
 * Why do fetched comments fall short of Instagram's reported comment_count?
 *
 * Hypothesis: `comment_count` counts the whole thread — top-level comments AND
 * their replies — while our harvester only walks the top-level connection. If
 * so, sum(child_comment_count) should account for most of the gap, and the fix
 * is to fetch each parent's replies rather than to "adjust" the reported count.
 *
 * Also probes the child-comments endpoint to confirm replies are reachable.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchInstagramProfile, fetchUserFeed, normalizeSession } from "../../src/server/services/instagram/fetcher";
import { fetchMediaComments } from "../../src/server/services/instagram/comments";

const APP_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const session = decrypt(data!.session_id_encrypted);
  const s = normalizeSession(session);

  const headers: Record<string, string> = {
    "User-Agent": APP_UA,
    "X-IG-App-ID": "936619743392459",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    Cookie: s.cookie,
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const profile = await fetchInstagramProfile("officialumarmla", session);
  const feed = await fetchUserFeed(profile.id, session, 5);
  const posts = feed.items.slice(0, 5);

  console.log("post          reported  toplevel  sum(child)  top+child   gap   explained?");
  console.log("-".repeat(80));

  let probeParent: { mediaId: string; commentId: string } | null = null;

  for (const p of posts) {
    const r = await fetchMediaComments(p.id, session, { includeReplies: false });
    const top = r.comments.length;
    const childSum = r.comments.reduce((a, c) => a + c.replyCount, 0);
    const gap = p.comments - top;
    const explained = childSum >= gap ? "YES" : childSum > 0 ? `partly (${childSum}/${gap})` : "no";
    console.log(
      `${p.shortcode}  ${String(p.comments).padStart(8)}  ${String(top).padStart(8)}  ` +
        `${String(childSum).padStart(10)}  ${String(top + childSum).padStart(9)}  ${String(gap).padStart(4)}   ${explained}`,
    );

    const withKids = r.comments.find((c) => c.replyCount > 0);
    if (withKids && !probeParent) probeParent = { mediaId: p.id, commentId: withKids.id };
    await new Promise((res) => setTimeout(res, 1200));
  }

  // Confirm replies are actually retrievable.
  if (probeParent) {
    console.log(`\n=== child-comments endpoint probe (parent ${probeParent.commentId}) ===`);
    const url =
      `https://www.instagram.com/api/v1/media/${probeParent.mediaId}/comments/${probeParent.commentId}/child_comments/`;
    const res = await fetch(url, { headers, cache: "no-store" });
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      console.log(`  HTTP ${res.status} but returned HTML (endpoint wrong or blocked)`);
    } else {
      const j: any = JSON.parse(text);
      console.log(`  HTTP ${res.status}  keys: ${Object.keys(j).slice(0, 10).join(", ")}`);
      const kids = j?.child_comments ?? j?.comments ?? [];
      console.log(`  child_comments returned: ${kids.length}`);
      if (kids[0]) {
        console.log(`  sample: @${kids[0]?.user?.username}: "${String(kids[0]?.text ?? "").slice(0, 60)}"`);
      }
      console.log(`  has_more: ${j?.has_more_head_child_comments ?? j?.has_more_tail_child_comments ?? "n/a"}`);
    }
  } else {
    console.log("\nNo parent comment with replyCount > 0 found — replies are not the cause here.");
  }

  // Are any fetched comments text-empty (image/sticker only)?
  console.log("\n=== empty-text comments (media-only) across the 5 posts ===");
  let emptyTotal = 0;
  for (const p of posts) {
    const r = await fetchMediaComments(p.id, session, { includeReplies: false });
    const empty = r.comments.filter((c) => !c.text.trim()).length;
    emptyTotal += empty;
    if (empty) console.log(`  ${p.shortcode}: ${empty} of ${r.comments.length} have empty text`);
    await new Promise((res) => setTimeout(res, 1200));
  }
  console.log(`  total empty-text comments: ${emptyTotal}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
