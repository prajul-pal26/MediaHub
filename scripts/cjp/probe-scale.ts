/**
 * Feasibility probe for a full comment harvest of a large public account.
 * Measures post count, comment distribution, and the real cost of one
 * comment-page request — so the time estimate is measured, not guessed.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import {
  fetchInstagramProfile,
  fetchUserFeed,
  normalizeSession,
} from "../../src/server/services/instagram/fetcher";

const TARGET = process.argv[2] || "myogi_adityanath";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function getSession(): Promise<string> {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.session_id_encrypted) throw new Error("no active Instagram session");
  return decrypt(data.session_id_encrypted);
}

/** One raw comments-endpoint call, to time it and see the page size. */
async function probeCommentPage(mediaId: string, session: string) {
  const s = normalizeSession(session);
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    Cookie: s.cookie,
    Accept: "*/*",
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  const started = Date.now();
  const res = await fetch(
    `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`,
    { headers, cache: "no-store" },
  );
  const ms = Date.now() - started;
  const json: any = await res.json().catch(() => null);
  return {
    ms,
    status: res.status,
    count: Array.isArray(json?.comments) ? json.comments.length : 0,
    hasMore: Boolean(json?.has_more_comments ?? json?.next_min_id),
    total: json?.comment_count ?? null,
    sample: json?.comments?.[0]
      ? {
          user: json.comments[0]?.user?.username,
          text: String(json.comments[0]?.text ?? "").slice(0, 60),
          likes: json.comments[0]?.comment_like_count,
        }
      : null,
    error: json?.message ?? null,
  };
}

async function main() {
  const session = await getSession();
  console.log(`TARGET: @${TARGET}\n`);

  const profile = await fetchInstagramProfile(TARGET, session);
  console.log("=== PROFILE ===");
  console.log(`  name       : ${profile.fullName}`);
  console.log(`  followers  : ${profile.followers?.toLocaleString?.() ?? profile.followers}`);
  console.log(`  posts      : ${profile.postsCount?.toLocaleString?.() ?? profile.postsCount}`);
  console.log(`  private    : ${profile.isPrivate}`);
  console.log(`  verified   : ${profile.isVerified}`);
  console.log(`  userId     : ${profile.id}`);

  console.log("\n=== SAMPLING RECENT POSTS ===");
  const started = Date.now();
  const feed = await fetchUserFeed(profile.id, session, 60);
  const feedMs = Date.now() - started;
  console.log(`  fetched ${feed.items.length} posts in ${(feedMs / 1000).toFixed(1)}s (truncated=${feed.truncated})`);

  const counts = feed.items.map((i) => i.comments).sort((a, b) => a - b);
  if (counts.length) {
    const sum = counts.reduce((a, b) => a + b, 0);
    const med = counts[Math.floor(counts.length / 2)];
    console.log(`  comments/post — min ${counts[0]}, median ${med}, mean ${Math.round(sum / counts.length)}, max ${counts[counts.length - 1]}`);
    console.log(`  sampled total comments: ${sum.toLocaleString()}`);
    if (profile.postsCount) {
      const est = Math.round((sum / counts.length) * profile.postsCount);
      console.log(`  ESTIMATED TOTAL COMMENTS across ${profile.postsCount} posts: ~${est.toLocaleString()}`);
    }
  }

  console.log("\n=== COMMENT ENDPOINT PROBE ===");
  const withComments = feed.items.filter((i) => i.comments > 0).slice(0, 3);
  for (const item of withComments) {
    const r = await probeCommentPage(item.id, session);
    console.log(
      `  media ${item.id} (${item.comments} comments): HTTP ${r.status}, got ${r.count} in ${r.ms}ms, more=${r.hasMore}${r.error ? `, err=${r.error}` : ""}`,
    );
    if (r.sample) console.log(`     sample: @${r.sample.user}: "${r.sample.text}" (${r.sample.likes} likes)`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  });
