/**
 * Harvest all comments for the newest N posts of an account → one CSV.
 *
 * Uses the parallel harvester with a shared adaptive rate governor. Comments
 * only — no media is downloaded.
 *
 *   KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
 *     npx tsx scripts/cjp/harvest-comments.ts myogi_adityanath 5
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchInstagramProfile, fetchUserFeed } from "../../src/server/services/instagram/fetcher";
import { harvestManyPosts, CommentRateGovernor } from "../../src/server/services/instagram/comments";

const TARGET = process.argv[2] || "myogi_adityanath";
const N = Number(process.argv[3] || 5);
const CONCURRENCY = Number(process.argv[4] || 5);
const OUT_DIR = "cjp_output";

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
  if (!data?.session_id_encrypted) throw new Error("no active Instagram session");
  const session = decrypt(data.session_id_encrypted);

  const profile = await fetchInstagramProfile(TARGET, session);
  const feed = await fetchUserFeed(profile.id, session, N);
  const posts = feed.items.slice(0, N);

  const expected = posts.reduce((a, p) => a + p.comments, 0);
  console.log(`@${TARGET} — ${posts.length} posts, ${expected.toLocaleString()} comments expected`);
  console.log(`concurrency=${CONCURRENCY}\n`);

  const byId = new Map(posts.map((p) => [p.id, p]));
  const governor = new CommentRateGovernor();
  const seenPerPost = new Map<string, number>();
  const t0 = Date.now();

  const { results, totalComments, throttleCount, elapsedMs } = await harvestManyPosts(
    posts.map((p) => p.id),
    session,
    {
      concurrency: CONCURRENCY,
      governor,
      onProgress: ({ mediaId, fetched, reportedTotal, done }) => {
        const prev = seenPerPost.get(mediaId) ?? 0;
        seenPerPost.set(mediaId, fetched);
        // Log every ~750 comments per post to keep output readable.
        if (done || Math.floor(fetched / 750) > Math.floor(prev / 750)) {
          const elapsed = (Date.now() - t0) / 1000;
          const running = [...seenPerPost.values()].reduce((a, b) => a + b, 0);
          console.log(
            `  ${done ? "DONE" : "    "} ${mediaId} ${fetched}/${reportedTotal ?? "?"}` +
              `   | total ${running} in ${elapsed.toFixed(0)}s (${(running / elapsed).toFixed(1)}/s, pace ${governor.current}ms)`,
          );
        }
      },
    },
  );

  const rows: Record<string, unknown>[] = [];
  for (const r of results) {
    const post = byId.get(r.mediaId);
    for (const c of r.comments) {
      rows.push({
        post_media_id: r.mediaId,
        post_shortcode: post?.shortcode ?? "",
        post_url: post?.url ?? "",
        post_kind: post?.kind ?? "",
        post_published: post?.takenAt ? new Date(post.takenAt * 1000).toISOString() : "",
        post_likes: post?.likes ?? "",
        post_comment_count: post?.comments ?? "",
        comment_id: c.id,
        comment_text: c.text.replace(/\s+/g, " "),
        comment_created_at: c.createdAt ?? "",
        comment_likes: c.likeCount,
        depth: c.depth,
        parent_comment_id: c.parentId ?? "",
        reply_count: c.replyCount,
        commenter_username: c.username,
        commenter_full_name: c.fullName,
        commenter_user_id: c.userId ?? "",
        commenter_verified: c.isVerified,
        commenter_profile_url: c.username ? `https://www.instagram.com/${c.username}/` : "",
      });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${TARGET}_comments.csv`);
  const fields = Object.keys(rows[0] ?? { note: "" });
  const csv = Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => r[f] ?? "")) });
  writeFileSync(path, `﻿${csv}`, "utf8");

  const secs = elapsedMs / 1000;
  console.log(`\n=== RESULT ===`);
  console.log(`  comments fetched : ${totalComments.toLocaleString()} / ${expected.toLocaleString()} expected`);
  console.log(`  coverage         : ${((totalComments / Math.max(1, expected)) * 100).toFixed(1)}%`);
  console.log(`  replies          : ${rows.filter((r) => r.depth === 1).length.toLocaleString()}`);
  console.log(`  elapsed          : ${(secs / 60).toFixed(1)} min (${secs.toFixed(0)}s)`);
  console.log(`  throughput       : ${(totalComments / secs).toFixed(1)} comments/sec`);
  console.log(`  throttles        : ${throttleCount}`);
  console.log(`  requests         : ${results.reduce((a, r) => a + r.requestCount, 0).toLocaleString()}`);
  console.log(`  written          : ${path}`);

  console.log(`\n  per post:`);
  for (const r of results) {
    const post = byId.get(r.mediaId);
    console.log(
      `    ${r.mediaId} ${String(r.comments.length).padStart(6)}/${String(r.reportedTotal ?? "?").padStart(6)}` +
        ` pages=${String(r.pagesFetched).padStart(4)} ${((r.elapsedMs / 1000) / 60).toFixed(1)}min` +
        ` ${post?.kind ?? ""}${r.error ? `  ERROR: ${r.error}` : ""}${r.truncated ? "  [truncated]" : ""}`,
    );
  }

  // Extrapolate to the full-account goal using the rate actually achieved.
  const rate = totalComments / secs;
  const FULL = 32_400_000;
  console.log(`\n=== EXTRAPOLATION to full account (~${(FULL / 1e6).toFixed(1)}M comments) ===`);
  console.log(`  at this rate (${rate.toFixed(1)}/s, 1 session): ${(FULL / rate / 3600).toFixed(0)} hours = ${(FULL / rate / 86400).toFixed(1)} days`);
  for (const sessions of [3, 5, 10]) {
    console.log(`  with ${String(sessions).padStart(2)} sessions in parallel: ${(FULL / (rate * sessions) / 86400).toFixed(1)} days`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  });
