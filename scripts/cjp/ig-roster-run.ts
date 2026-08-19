/**
 * Roster-wide Instagram harvest: every serving MLA with an instagram_profile.
 *
 * Designed to survive a long unattended run:
 *   - RESUMABLE   — an MLA whose designated file already holds >= POST_COUNT
 *                   rows is skipped, so a restart doesn't redo finished work.
 *   - ISOLATED    — a private/deleted/renamed account is logged and skipped;
 *                   it never aborts the run.
 *   - PACED       — accounts are spaced apart, and comment paging inside each
 *                   MLA shares one adaptive governor.
 *   - HONEST      — a dead session aborts immediately rather than writing 100
 *                   empty files that look like "these MLAs have no posts".
 *
 *   CONCURRENCY is per-MLA (across that MLA's posts). Accounts themselves run
 *   sequentially: one session, and hammering many accounts at once is what
 *   actually triggers a checkpoint.
 *
 * Usage:
 *   KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
 *     npx tsx scripts/cjp/ig-roster-run.ts [postCount] [startFrom]
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import {
  fetchInstagramProfile,
  fetchUserFeed,
  InstaAuthError,
  InstaRateLimitError,
} from "../../src/server/services/instagram/fetcher";
import {
  harvestManyPosts,
  CommentRateGovernor,
} from "../../src/server/services/instagram/comments";

const MLA_ROOT = "/Users/pranjul/workspace/governance_report/Current MLA";
const ROSTER = join(MLA_ROOT, "up_mla_403.csv");
const OUT_DIR = "cjp_output";
const LOG = join(OUT_DIR, "ig_roster_run.log");
const SUMMARY = join(OUT_DIR, "ig_roster_summary.csv");

const POST_COUNT = Number(process.argv[2] || 10);
const START_FROM = Number(process.argv[3] || 0);
/** Parallel workers across one MLA's posts. Measured safe at 5. */
const CONCURRENCY = 5;
/** Gap between accounts — 131 accounts back-to-back is not the same as one. */
const ACCOUNT_DELAY_MS = 5_000;
/** Consecutive auth failures before we conclude the session is gone. */
const AUTH_FAIL_LIMIT = 3;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string) {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG, stamped + "\n");
  } catch {
    /* logging must never break the run */
  }
}

function usernameFromUrl(url: string): string {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(url || "");
  return (m?.[1] ?? "").replace(/\/+$/, "");
}

function designatedPath(acNo: string, name: string): string {
  return join(MLA_ROOT, "instagram", `${acNo}_${String(name).trim().replace(/\s+/g, "_")}.csv`);
}

/** Rows already present in a designated file (0 when missing/empty). */
function existingRowCount(path: string): number {
  try {
    if (!existsSync(path) || statSync(path).size === 0) return 0;
    const parsed = Papa.parse(readFileSync(path, "utf8"), { header: true, skipEmptyLines: true });
    return parsed.data.length;
  } catch {
    return 0;
  }
}

interface Outcome {
  ac_no: string;
  mla_name: string;
  username: string;
  status: "ok" | "skipped_done" | "private" | "not_found" | "no_posts" | "error";
  posts: number;
  comments: number;
  seconds: number;
  note: string;
}

async function harvestOne(
  mla: Record<string, string>,
  session: string,
): Promise<Outcome> {
  const username = usernameFromUrl(mla.instagram_profile);
  const base: Outcome = {
    ac_no: mla.ac_no,
    mla_name: mla.mla_name,
    username,
    status: "error",
    posts: 0,
    comments: 0,
    seconds: 0,
    note: "",
  };
  const t0 = Date.now();

  const profile = await fetchInstagramProfile(username, session);
  if (profile.isPrivate) {
    return { ...base, status: "private", seconds: (Date.now() - t0) / 1000, note: "account is private" };
  }

  const feed = await fetchUserFeed(profile.id, session, POST_COUNT);
  const posts = feed.items.slice(0, POST_COUNT);
  if (!posts.length) {
    return { ...base, status: "no_posts", seconds: (Date.now() - t0) / 1000, note: "feed returned nothing" };
  }

  const { results } = await harvestManyPosts(
    posts.map((p) => p.id),
    session,
    { concurrency: CONCURRENCY, includeReplies: true, governor: new CommentRateGovernor() },
  );
  const byMedia = new Map(results.map((r) => [r.mediaId, r]));

  const rows = posts.map((p) => {
    const comments = byMedia.get(p.id)?.comments ?? [];

    // Thread replies under their parents so the JSON mirrors the conversation.
    const byParent = new Map<string, typeof comments>();
    for (const c of comments) {
      if (c.depth === 1 && c.parentId) {
        const arr = byParent.get(c.parentId) ?? [];
        arr.push(c);
        byParent.set(c.parentId, arr);
      }
    }
    const shape = (c: (typeof comments)[number]) => ({
      id: c.id,
      username: c.username,
      full_name: c.fullName,
      text: c.text,
      likes: c.likeCount,
      created_at: c.createdAt,
      verified: c.isVerified,
      profile_url: c.username ? `https://www.instagram.com/${c.username}/` : null,
    });
    const threaded = comments
      .filter((c) => c.depth === 0)
      .map((c) => ({ ...shape(c), replies: (byParent.get(c.id) ?? []).map(shape) }));

    return {
      ac_no: mla.ac_no,
      mla_name: mla.mla_name,
      post_url: p.url,
      likes_count: p.likes,
      // Reconciled to what was actually retrieved, matching the single-MLA pipeline.
      comments_count_reported: comments.length,
      views_or_plays: p.views ?? "",
      shares_count: "not_exposed_by_instagram",
      caption: (p.caption ?? "").replace(/\s+/g, " "),
      comments_json: JSON.stringify(threaded),
    };
  });

  const fields = Object.keys(rows[0]);
  const csv = Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => (r as any)[f] ?? "")) });
  writeFileSync(designatedPath(String(mla.ac_no), String(mla.mla_name)), `﻿${csv}`, "utf8");

  return {
    ...base,
    status: "ok",
    posts: rows.length,
    comments: rows.reduce((a, r) => a + r.comments_count_reported, 0),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    note: `${posts.filter((p) => p.kind === "reel").length} reels`,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const roster = Papa.parse<Record<string, string>>(readFileSync(ROSTER, "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data;
  const targets = roster
    .filter((r) => (r.instagram_profile ?? "").trim() && usernameFromUrl(r.instagram_profile))
    .slice(START_FROM);

  log(`=== Instagram roster run ===`);
  log(`targets=${targets.length}  posts_per_mla=${POST_COUNT}  concurrency=${CONCURRENCY}`);

  const { data: sess } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sess?.session_id_encrypted) throw new Error("No active Instagram session");
  const session = decrypt(sess.session_id_encrypted);

  const outcomes: Outcome[] = [];
  let authFails = 0;
  const startedAt = Date.now();

  for (const [i, mla] of targets.entries()) {
    const label = `${i + 1}/${targets.length} ac_no=${mla.ac_no} ${mla.mla_name}`;
    const path = designatedPath(String(mla.ac_no), String(mla.mla_name));

    if (existingRowCount(path) >= POST_COUNT) {
      log(`SKIP  ${label} — already has >= ${POST_COUNT} rows`);
      outcomes.push({
        ac_no: mla.ac_no,
        mla_name: mla.mla_name,
        username: usernameFromUrl(mla.instagram_profile),
        status: "skipped_done",
        posts: 0,
        comments: 0,
        seconds: 0,
        note: "resume skip",
      });
      continue;
    }

    try {
      const out = await harvestOne(mla, session);
      outcomes.push(out);
      authFails = 0;
      const icon = out.status === "ok" ? "OK   " : "WARN ";
      log(`${icon} ${label} — ${out.status} posts=${out.posts} comments=${out.comments} ${out.seconds}s ${out.note}`);
    } catch (err: any) {
      const message = String(err?.message ?? err);

      if (err instanceof InstaAuthError || /login_required|not logged in/i.test(message)) {
        authFails += 1;
        log(`AUTH  ${label} — ${message} (${authFails}/${AUTH_FAIL_LIMIT})`);
        outcomes.push({
          ac_no: mla.ac_no,
          mla_name: mla.mla_name,
          username: usernameFromUrl(mla.instagram_profile),
          status: "error",
          posts: 0,
          comments: 0,
          seconds: 0,
          note: `auth: ${message}`,
        });
        if (authFails >= AUTH_FAIL_LIMIT) {
          log(`ABORT — ${AUTH_FAIL_LIMIT} consecutive auth failures; the session is gone.`);
          log(`        Add a fresh session in Settings → Instagram, then re-run to resume.`);
          break;
        }
        await sleep(30_000);
        continue;
      }

      if (err instanceof InstaRateLimitError) {
        log(`RATE  ${label} — rate limited; cooling off 120s`);
        await sleep(120_000);
      }

      const status: Outcome["status"] = /not found|404/i.test(message) ? "not_found" : "error";
      outcomes.push({
        ac_no: mla.ac_no,
        mla_name: mla.mla_name,
        username: usernameFromUrl(mla.instagram_profile),
        status,
        posts: 0,
        comments: 0,
        seconds: 0,
        note: message.slice(0, 160),
      });
      log(`FAIL  ${label} — ${message.slice(0, 120)}`);
    }

    // Persist the summary as we go so a kill still leaves a usable report.
    const fields = ["ac_no", "mla_name", "username", "status", "posts", "comments", "seconds", "note"];
    writeFileSync(
      SUMMARY,
      `﻿${Papa.unparse({ fields, data: outcomes.map((o) => fields.map((f) => (o as any)[f] ?? "")) })}`,
      "utf8",
    );

    if (i < targets.length - 1) await sleep(ACCOUNT_DELAY_MS);
  }

  const mins = (Date.now() - startedAt) / 60000;
  const by = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  log(`\n=== DONE in ${mins.toFixed(1)} min ===`);
  log(`  ok=${by("ok")} skipped=${by("skipped_done")} private=${by("private")} not_found=${by("not_found")} no_posts=${by("no_posts")} error=${by("error")}`);
  log(`  posts=${outcomes.reduce((a, o) => a + o.posts, 0)}  comments=${outcomes.reduce((a, o) => a + o.comments, 0)}`);
  log(`  summary: ${SUMMARY}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log(`FATAL: ${e?.message ?? e}`);
    process.exit(1);
  });
