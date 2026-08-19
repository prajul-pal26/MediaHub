/**
 * Per-MLA FACEBOOK harvest — the mirror of mla-harvest.ts.
 *
 * Produces the same column contract as the Instagram pipeline so the two files
 * sit side by side and merge cleanly:
 *
 *   ac_no, mla_name, post_url, likes_count, comments_count_reported,
 *   views_or_plays, shares_count, caption, comments_json
 *
 *   CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
 *     npx tsx scripts/cjp/fb-mla-harvest.ts 1 5
 *
 * Facebook differs from Instagram in three ways that matter here:
 *   - shares ARE exposed (Instagram never exposes them), so shares_count is real.
 *   - there is no comment counter to reconcile against, so
 *     comments_count_reported is simply what was retrieved — which is what the
 *     Instagram pipeline reconciles to anyway, so the columns stay comparable.
 *   - video view counts are not reliably present in the rendered DOM.
 *
 * Requires a LIVE Facebook session (Settings → Facebook). Every method needs it.
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
import { scrapePosts, scrapeComments } from "../../src/server/services/facebook/orchestrator";
import { scrapeProfilePostsViaHtml } from "../../src/server/services/facebook/html-profile-scraper";
import { establishGraphqlSession } from "../../src/server/services/facebook/graphql-scraper";
import type { FbScrapedComment } from "../../src/server/services/facebook/scraper-types";

const MLA_ROOT = "/Users/pranjul/workspace/governance_report/Current MLA";
const ROSTER = join(MLA_ROOT, "up_mla_403.csv");
const AC_NO = process.argv[2] || "1";
const POST_COUNT = Number(process.argv[3] || 5);
const COMMENTS_PER_POST = Number(process.argv[4] || 500);
const OUT_DIR = "cjp_output";
const EXCEL_CELL_LIMIT = 32_767;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

function designatedPath(acNo: string, name: string): string {
  return join(MLA_ROOT, "facebook", `${acNo}_${String(name).trim().replace(/\s+/g, "_")}.csv`);
}

/** Flatten a threaded comment into the same JSON shape the IG pipeline emits. */
function toJsonComment(c: FbScrapedComment): Record<string, unknown> {
  return {
    id: c.commentId,
    username: c.commenterName,
    full_name: c.commenterName,
    text: c.commentText,
    likes: c.commentReactionCount,
    created_at: c.commentTime,
    verified: false,
    profile_url: c.commenterUrl,
    replies: (c.replies ?? []).map((r) => ({
      id: r.commentId,
      username: r.commenterName,
      full_name: r.commenterName,
      text: r.commentText,
      likes: r.commentReactionCount,
      created_at: r.commentTime,
      verified: false,
      profile_url: r.commenterUrl,
    })),
  };
}

function countAll(threaded: Record<string, unknown>[]): number {
  return threaded.reduce((a, c) => a + 1 + ((c.replies as unknown[])?.length ?? 0), 0);
}

async function main() {
  const roster = Papa.parse<Record<string, string>>(readFileSync(ROSTER, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data;

  const mla = roster.find((r) => String(r.ac_no ?? "").trim() === String(AC_NO));
  if (!mla) throw new Error(`ac_no=${AC_NO} not found in the roster`);
  const fbUrl = (mla.facebook_profile ?? "").trim();
  if (!fbUrl) throw new Error(`No facebook_profile for ac_no=${AC_NO}`);

  console.log(`ac_no=${mla.ac_no}  ${mla.mla_name}`);
  console.log(`facebook: ${fbUrl}\n`);

  // Session gate — every Facebook method needs live cookies, so fail loudly
  // and specifically rather than producing an empty file.
  const { data: sess } = await db
    .from("fb_sessions")
    .select("id, cookie_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sess?.cookie_encrypted) {
    throw new Error("No Facebook session stored. Add cookies in Settings → Facebook.");
  }
  const cookies = decrypt(sess.cookie_encrypted);
  try {
    const s = await establishGraphqlSession(cookies);
    console.log(`session: LIVE (user ${s.userId})\n`);
  } catch (e: any) {
    throw new Error(
      `Facebook session is DEAD (${e?.message ?? e}).\n` +
        `  Facebook cannot be scraped without it — there is no anonymous path.\n` +
        `  Fix: Settings → Facebook → Replace cookies (fresh c_user + xs), then re-run.`,
    );
  }

  if (!process.env.CHROMIUM_PATH) {
    console.log("NOTE: CHROMIUM_PATH is unset — the browser method will fail if mbasic returns nothing.");
    console.log('      Set it to "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".\n');
  }

  console.log(`fetching newest ${POST_COUNT} posts…`);

  // Primary: server-rendered HTML. Playwright only ever renders the profile
  // header plus a notifications tray for Facebook, so the HTTP path is both
  // richer and cheaper here.
  let selected: {
    postUrl: string | null;
    likes: number;
    comments: number;
    shares: number;
    text: string;
    time: string | null;
    views: number | null;
  }[] = [];

  const htmlResult = await scrapeProfilePostsViaHtml(fbUrl, cookies);
  console.log(`  html: ${htmlResult.posts.length} posts from ${htmlResult.htmlLength.toLocaleString()} bytes`);
  selected = htmlResult.posts.slice(0, POST_COUNT).map((p) => ({
    postUrl: p.url,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    text: p.text,
    time: p.createdAt,
    views: p.views,
  }));

  // Fall back to the orchestrator only when HTML yields nothing at all.
  if (!selected.length) {
    const { data: posts, attempts } = await scrapePosts({
      target: fbUrl,
      cookies,
      method: "auto",
      pages: 3,
      limit: POST_COUNT,
    });
    for (const a of attempts) {
      console.log(`  ${a.method}: ${a.ok ? `${a.count} posts in ${a.ms}ms` : `failed — ${a.error}`}`);
    }
    selected = posts.slice(0, POST_COUNT).map((p) => ({
      postUrl: p.postUrl,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      text: p.text,
      time: p.time,
      views: null,
    }));
  }

  if (!selected.length) throw new Error("No posts retrieved from Facebook — see attempt log above.");
  for (const [i, p] of selected.entries()) {
    console.log(
      `  ${i + 1}. likes=${String(p.likes).padStart(6)} comments=${String(p.comments).padStart(5)} shares=${String(p.shares).padStart(5)}  ${p.postUrl ?? "(no permalink)"}`,
    );
  }

  console.log(`\nharvesting comments…`);
  const rows: Record<string, unknown>[] = [];
  const longRows: Record<string, unknown>[] = [];
  const reconciliation: { url: string; counter: number; retrieved: number }[] = [];

  for (const [i, p] of selected.entries()) {
    let threaded: Record<string, unknown>[] = [];
    if (p.postUrl) {
      try {
        const { data: comments } = await scrapeComments({
          postUrl: p.postUrl,
          cookies,
          method: "auto",
          limit: COMMENTS_PER_POST,
          withReplies: true,
          ordering: "all",
        });
        threaded = comments.map(toJsonComment);
        for (const c of comments) {
          const push = (x: FbScrapedComment, parent: string) =>
            longRows.push({
              ac_no: mla.ac_no,
              mla_name: mla.mla_name,
              post_url: p.postUrl,
              parent_comment_id: parent,
              comment_id: x.commentId,
              commenter_name: x.commenterName,
              commenter_url: x.commenterUrl ?? "",
              comment_text: x.commentText.replace(/\s+/g, " "),
              comment_likes: x.commentReactionCount,
              comment_created_at: x.commentTime ?? "",
              depth: x.depth,
            });
          push(c, "");
          for (const r of c.replies ?? []) push(r, c.commentId);
        }
      } catch (e: any) {
        console.log(`    post ${i + 1}: comment fetch failed — ${e?.message ?? e}`);
      }
    }
    const retrieved = countAll(threaded);
    reconciliation.push({ url: p.postUrl ?? "", counter: p.comments, retrieved });
    console.log(`    post ${i + 1}: ${retrieved} comments retrieved (counter says ${p.comments})`);

    rows.push({
      ac_no: mla.ac_no,
      mla_name: mla.mla_name,
      post_url: p.postUrl ?? "",
      likes_count: p.likes,
      // Reconciled to what was actually retrieved, matching the IG pipeline.
      comments_count_reported: retrieved,
      // Facebook's rendered feed does not reliably expose video view counts.
      views_or_plays: "not_exposed_by_facebook",
      // Unlike Instagram, Facebook DOES expose shares.
      shares_count: p.shares,
      caption: (p.text ?? "").replace(/\s+/g, " "),
      comments_json: JSON.stringify(threaded),
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const slug = String(mla.mla_name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const writeTo = (path: string, data: Record<string, unknown>[]) => {
    const fields = Object.keys(data[0] ?? { note: "" });
    const csv = Papa.unparse({ fields, data: data.map((r) => fields.map((f) => r[f] ?? "")) });
    writeFileSync(path, `﻿${csv}`, "utf8");
    return path;
  };

  const widePath = writeTo(designatedPath(String(mla.ac_no), String(mla.mla_name)), rows);
  const longPath = longRows.length
    ? writeTo(join(OUT_DIR, `fb_mla_ac${mla.ac_no}_${slug}_comments_long.csv`), longRows)
    : "(none)";

  console.log(`\n=== RESULT ===`);
  console.log(`  posts            : ${rows.length}`);
  console.log(`  comments total   : ${longRows.length}`);
  console.log(`  wide (${rows.length} rows)    : ${widePath}`);
  console.log(`  long             : ${longPath}`);

  console.log(`\n=== RECONCILIATION ===`);
  for (const r of reconciliation) {
    console.log(`  counter=${String(r.counter).padStart(5)}  retrieved=${String(r.retrieved).padStart(5)}  ${r.url.slice(0, 60)}`);
  }

  const over = rows.filter((r) => String(r.comments_json).length > EXCEL_CELL_LIMIT);
  if (over.length) {
    console.log(`\n  NOTE: ${over.length}/${rows.length} comments_json cells exceed Excel's display limit.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nFAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
