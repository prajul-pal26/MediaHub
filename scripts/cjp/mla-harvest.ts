/**
 * Per-MLA Instagram harvest: newest N posts, with ALL comments for each.
 *
 * Reads the MLA roster CSV, picks a row by ac_no, resolves its instagram_profile
 * and produces ONE ROW PER POST — the comments for that post packed into the
 * row itself.
 *
 *   KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
 *     npx tsx scripts/cjp/mla-harvest.ts 1 5
 *
 * Two files are written, because one cell cannot honestly hold thousands of
 * comments: Excel truncates any cell past 32,767 characters. So the wide file
 * carries the packed comments for the requested shape, and a long companion
 * file carries one row per comment for anything analytical.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { fetchInstagramProfile, fetchUserFeed } from "../../src/server/services/instagram/fetcher";
import {
  harvestManyPosts,
  CommentRateGovernor,
  type InstaComment,
} from "../../src/server/services/instagram/comments";

const MLA_ROOT = "/Users/pranjul/workspace/governance_report/Current MLA";
const ROSTER = join(MLA_ROOT, "up_mla_403.csv");
/**
 * The governance_report repo scaffolds one empty CSV per MLA per platform,
 * named "<ac_no>_<Name_With_Underscores>.csv". The wide result is written
 * straight into that designated file; the long companion stays in cjp_output so
 * the scaffolded directory keeps exactly one file per MLA.
 */
function designatedPath(acNo: string, name: string): string {
  const file = `${acNo}_${String(name).trim().replace(/\s+/g, "_")}.csv`;
  return join(MLA_ROOT, "instagram", file);
}
const AC_NO = process.argv[2] || "1";
const POST_COUNT = Number(process.argv[3] || 5);
const CONCURRENCY = Number(process.argv[4] || 5);
const OUT_DIR = "cjp_output";
/** Excel's hard per-cell limit; anything beyond this is silently lost. */
const EXCEL_CELL_LIMIT = 32_767;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

function usernameFromUrl(url: string): string {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(url || "");
  return (m?.[1] ?? "").replace(/\/+$/, "");
}

/** "@user: text (12 likes)" joined by a delimiter unlikely to occur in text. */
function packComments(comments: InstaComment[]): string {
  return comments
    .map((c) => `@${c.username}: ${c.text.replace(/\s+/g, " ")} (${c.likeCount} likes)`)
    .join(" ||| ");
}

async function main() {
  const roster = Papa.parse<Record<string, string>>(readFileSync(ROSTER, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data;

  const mla = roster.find((r) => String(r.ac_no ?? "").trim() === String(AC_NO));
  if (!mla) throw new Error(`ac_no=${AC_NO} not found in the roster`);

  const username = usernameFromUrl(mla.instagram_profile);
  if (!username) throw new Error(`No usable instagram_profile for ac_no=${AC_NO}`);

  console.log(`ac_no=${mla.ac_no}  ${mla.mla_name}`);
  console.log(`instagram: @${username}\n`);

  const { data: sess } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sess?.session_id_encrypted) throw new Error("no active Instagram session");
  const session = decrypt(sess.session_id_encrypted);

  const profile = await fetchInstagramProfile(username, session);
  console.log(`profile: ${profile.fullName} — ${profile.followers?.toLocaleString?.() ?? "?"} followers, ${profile.postsCount} posts, private=${profile.isPrivate}`);
  if (profile.isPrivate) throw new Error("account is private — comments are not reachable");

  const feed = await fetchUserFeed(profile.id, session, POST_COUNT);
  const posts = feed.items.slice(0, POST_COUNT);
  if (!posts.length) throw new Error("no posts returned");

  const expected = posts.reduce((a, p) => a + p.comments, 0);
  console.log(`\nnewest ${posts.length} posts, ${expected.toLocaleString()} comments reported:`);
  for (const [i, p] of posts.entries()) {
    console.log(
      `  ${i + 1}. ${p.shortcode} ${p.kind.padEnd(8)} likes=${String(p.likes).padStart(6)} comments=${String(p.comments).padStart(5)} views=${p.views ?? "-"}`,
    );
  }

  console.log(`\nharvesting comments (concurrency=${CONCURRENCY})…`);
  const t0 = Date.now();
  const seen = new Map<string, number>();
  const { results, totalComments, throttleCount } = await harvestManyPosts(
    posts.map((p) => p.id),
    session,
    {
      concurrency: CONCURRENCY,
      // Instagram's comment_count counts the whole thread, so replies must be
      // fetched or the totals never reconcile.
      includeReplies: true,
      governor: new CommentRateGovernor(),
      onProgress: ({ mediaId, fetched, done }) => {
        const prev = seen.get(mediaId) ?? 0;
        seen.set(mediaId, fetched);
        if (done || Math.floor(fetched / 300) > Math.floor(prev / 300)) {
          const tot = [...seen.values()].reduce((a, b) => a + b, 0);
          const secs = (Date.now() - t0) / 1000;
          console.log(`  ${done ? "DONE" : "    "} ${mediaId} ${fetched}  | total ${tot} in ${secs.toFixed(0)}s`);
        }
      },
    },
  );

  const byMedia = new Map(results.map((r) => [r.mediaId, r]));

  // ── One row per post, exactly the requested columns ──
  const wide = posts.map((p) => {
    const comments = byMedia.get(p.id)?.comments ?? [];

    // Threaded: replies nest under their parent so the JSON mirrors the real
    // conversation rather than a flat list.
    const byParent = new Map<string, typeof comments>();
    for (const c of comments) {
      if (c.depth === 1 && c.parentId) {
        const arr = byParent.get(c.parentId) ?? [];
        arr.push(c);
        byParent.set(c.parentId, arr);
      }
    }
    const threaded = comments
      .filter((c) => c.depth === 0)
      .map((c) => ({
        id: c.id,
        username: c.username,
        full_name: c.fullName,
        text: c.text,
        likes: c.likeCount,
        created_at: c.createdAt,
        verified: c.isVerified,
        profile_url: c.username ? `https://www.instagram.com/${c.username}/` : null,
        replies: (byParent.get(c.id) ?? []).map((r) => ({
          id: r.id,
          username: r.username,
          full_name: r.fullName,
          text: r.text,
          likes: r.likeCount,
          created_at: r.createdAt,
          verified: r.isVerified,
          profile_url: r.username ? `https://www.instagram.com/${r.username}/` : null,
        })),
      }));

    return {
      ac_no: mla.ac_no,
      mla_name: mla.mla_name,
      post_url: p.url,
      likes_count: p.likes,
      // Reconciled to what is actually retrievable — see the reconciliation
      // note in the run output for why this can differ from Instagram's raw
      // counter (which includes deleted/hidden/filtered comments).
      comments_count_reported: comments.length,
      views_or_plays: p.views ?? "",
      // Instagram's web API exposes no share count to non-owners.
      shares_count: "not_exposed_by_instagram",
      caption: (p.caption ?? "").replace(/\s+/g, " "),
      comments_json: JSON.stringify(threaded),
    };
  });

  // Reconciliation report: raw counter vs what we could actually retrieve.
  const reconciliation = posts.map((p) => {
    const comments = byMedia.get(p.id)?.comments ?? [];
    const top = comments.filter((c) => c.depth === 0).length;
    const replies = comments.filter((c) => c.depth === 1).length;
    return {
      shortcode: p.shortcode,
      rawCounter: p.comments,
      top,
      replies,
      retrieved: comments.length,
      unreachable: Math.max(0, p.comments - comments.length),
    };
  });

  // ── Long file: one row per comment ──
  const long: Record<string, unknown>[] = [];
  for (const p of posts) {
    const r = byMedia.get(p.id);
    for (const c of r?.comments ?? []) {
      long.push({
        ac_no: mla.ac_no,
        mla_name: mla.mla_name,
        instagram_username: username,
        post_url: p.url,
        post_shortcode: p.shortcode,
        post_type: p.kind,
        comment_id: c.id,
        commenter_username: c.username,
        commenter_full_name: c.fullName,
        commenter_verified: c.isVerified,
        commenter_profile: c.username ? `https://www.instagram.com/${c.username}/` : "",
        comment_text: c.text.replace(/\s+/g, " "),
        comment_likes: c.likeCount,
        comment_created_at: c.createdAt ?? "",
        depth: c.depth,
      });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const slug = String(mla.mla_name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const writeTo = (path: string, rows: Record<string, unknown>[]) => {
    const fields = Object.keys(rows[0] ?? { note: "" });
    const csv = Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => r[f] ?? "")) });
    writeFileSync(path, `﻿${csv}`, "utf8");
    return path;
  };

  // Primary output: the repo's designated per-MLA file.
  const widePath = writeTo(designatedPath(String(mla.ac_no), String(mla.mla_name)), wide);
  const longPath = writeTo(join(OUT_DIR, `mla_ac${mla.ac_no}_${slug}_comments_long.csv`), long);

  const secs = (Date.now() - t0) / 1000;
  console.log(`\n=== RESULT ===`);
  console.log(`  posts               : ${wide.length}`);
  console.log(`  comments fetched    : ${totalComments.toLocaleString()} / ${expected.toLocaleString()} reported`);
  console.log(`  coverage            : ${((totalComments / Math.max(1, expected)) * 100).toFixed(1)}%`);
  console.log(`  elapsed             : ${secs.toFixed(0)}s`);
  console.log(`  throttles           : ${throttleCount}`);
  console.log(`  wide (5 rows)       : ${widePath}`);
  console.log(`  long (per comment)  : ${longPath}  [${long.length.toLocaleString()} rows]`);

  const over = wide.filter((r) => r.comments_json.length > EXCEL_CELL_LIMIT);
  if (over.length) {
    console.log(`\n  NOTE: ${over.length}/${wide.length} comments_json cells exceed Excel's 32,767-char limit`);
    console.log(`        (largest ${Math.max(...wide.map((r) => r.comments_json.length)).toLocaleString()} chars)`);
    console.log(`        Excel truncates the DISPLAY only — the CSV holds the full JSON.`);
  }

  console.log(`\n=== RECONCILIATION (why raw counter != retrieved) ===`);
  console.log(`  post          raw   top  replies  retrieved  unreachable`);
  for (const r of reconciliation) {
    console.log(
      `  ${r.shortcode}  ${String(r.rawCounter).padStart(4)}  ${String(r.top).padStart(4)}  ` +
        `${String(r.replies).padStart(7)}  ${String(r.retrieved).padStart(9)}  ${String(r.unreachable).padStart(11)}`,
    );
  }
  const rawSum = reconciliation.reduce((a, r) => a + r.rawCounter, 0);
  const gotSum = reconciliation.reduce((a, r) => a + r.retrieved, 0);
  console.log(`  ${"TOTAL".padEnd(12)}  ${String(rawSum).padStart(4)}  ${" ".repeat(14)}${String(gotSum).padStart(9)}  ${String(rawSum - gotSum).padStart(11)}`);
  console.log(`\n  comments_count_reported in the CSV = retrieved (reconciled), not the raw counter.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  });
