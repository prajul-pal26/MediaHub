/**
 * CJP "School Theek Karo Abhiyan" — Uttar Pradesh harvest.
 *
 * Produces three CSVs (YouTube / Instagram / Facebook) of campaign content,
 * filtered to Uttar Pradesh and to the current campaign window.
 *
 * Run:
 *   KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
 *     npx tsx scripts/cjp/harvest.ts
 *
 * Per-platform reality (measured, not assumed):
 *   YouTube   — full keyword search via our own scraper, optionally enriched
 *               with exact stats from the Data API using the stored OAuth token.
 *   Instagram — hashtag search via the live stored session.
 *   Facebook  — NO keyword/hashtag search exists (Meta removed it) and Google
 *               does not index post content, so this harvests named target
 *               pages instead. Requires a live session; without one the CSV is
 *               written with the targets listed and status=session_required.
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
import {
  searchYouTubeMulti,
  fetchVideoStats,
  type YtVideo,
} from "../../src/server/services/youtube/search";
import { fetchHashtagMedia, InstaAuthError } from "../../src/server/services/instagram/fetcher";
import { scrapePosts } from "../../src/server/services/facebook/orchestrator";
import { establishGraphqlSession } from "../../src/server/services/facebook/graphql-scraper";
import { classify, passesStrict, type Classification } from "./classify";
import { EVENT_TAGS, IG_TAGS, OUTPUT_DIR, YT_QUERIES } from "./config";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/**
 * Facebook pages to harvest once a session is live. Handles verified by search,
 * not guessed. Facebook removed public hashtag/keyword search, so naming pages
 * is the only route in.
 */
const FB_TARGETS = [
  { handle: "CockroachJantaParty", note: "CJP official page — VERIFIED (~14.6k likes)" },
  { handle: "dmhamirpur", note: "District Magistrate Hamirpur UP — VERIFIED; the office children marched to" },
  { handle: "AAPUttarPradesh", note: "AAP UP — VERIFIED; runs the separate School Bachao Andolan" },
  { handle: "thehindu", note: "VERIFIED; carries CJP video coverage" },
  { handle: "abplive", note: "VERIFIED; posted on Dipke arriving in Lucknow" },
  { handle: "aajtak", note: "National Hindi news — covers CJP" },
  { handle: "dainikjagran", note: "Hindi daily — strong UP coverage" },
  { handle: "amarujala", note: "Hindi daily — UP coverage" },
];

/**
 * Real Facebook post URLs confirmed present in search results. Included so the
 * CSV carries actual links even while the session is dead — engagement figures
 * stay blank until a live session can fetch them.
 */
const FB_SEED_POSTS = [
  {
    url: "https://www.facebook.com/abplive/posts/abhijeet-dipke-founder-of-the-cockroach-janta-party-cjp-arrived-in-lucknow-to-st/1523368829822731/",
    page: "abplive",
    text: "Abhijeet Dipke, founder of the Cockroach Janta Party (CJP), arrived in Lucknow — Uttar Pradesh",
  },
  {
    url: "https://www.facebook.com/thehindu/videos/watch-cockroach-janta-party-founder-abhijeet-dipke-says-the-partys-protest-at-ja/2225371511631447/",
    page: "thehindu",
    text: "Cockroach Janta Party founder Abhijeet Dipke on the party's protest at Jantar Mantar",
  },
];

function eventTagsFor(text: string): string[] {
  return EVENT_TAGS.filter((e) => e.pattern.test(text)).map((e) => e.tag);
}

function flat(c: Classification) {
  return {
    relevance_score: c.score,
    campaign_tier: c.campaignTier,
    is_campaign: c.isCampaign,
    campaign_evidence: c.campaignEvidence.join(" | "),
    school_evidence: c.schoolEvidence.join(" | "),
    noise_evidence: c.noiseEvidence.join(" | "),
    is_up_related: c.isUp,
    up_confidence: c.upConfidence,
    up_evidence: c.upEvidence.join(" | "),
    other_state_evidence: c.otherStateEvidence.join(" | "),
    is_recent: c.isRecent,
    age_days: c.ageDays ?? "",
  };
}

function writeCsv(name: string, rows: Record<string, unknown>[]): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${name}.csv`);
  if (!rows.length) {
    writeFileSync(path, "﻿no_rows\nNo rows passed the campaign + Uttar Pradesh + recency filter\n", "utf8");
    return path;
  }
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const csv = Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => r[f] ?? "")) });
  writeFileSync(path, `﻿${csv}`, "utf8");
  return path;
}

// ── YouTube ────────────────────────────────────────────────────────────────
async function youtubeAccessToken(): Promise<string | null> {
  const { data: acct } = await db
    .from("social_accounts")
    .select("access_token_encrypted, refresh_token_encrypted")
    .eq("platform", "youtube")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (!acct?.access_token_encrypted) return null;

  let token: string | null = null;
  try {
    token = decrypt(acct.access_token_encrypted);
  } catch {
    return null;
  }

  // Probe cheaply; refresh only if the stored token is stale.
  const probe = await fetchVideoStats(["dQw4w9WgXcQ"], { accessToken: token });
  if (!probe.error) return token;

  if (!acct.refresh_token_encrypted) return null;
  const { data: cred } = await db
    .from("platform_credentials")
    .select("client_id_encrypted, client_secret_encrypted")
    .eq("platform", "youtube")
    .maybeSingle();
  if (!cred) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: decrypt(cred.client_id_encrypted),
        client_secret: decrypt(cred.client_secret_encrypted),
        refresh_token: decrypt(acct.refresh_token_encrypted),
        grant_type: "refresh_token",
      }),
    });
    const json: any = await res.json().catch(() => null);
    return json?.access_token ?? null;
  } catch {
    return null;
  }
}

async function harvestYouTube() {
  console.log(`\n=== YOUTUBE — ${YT_QUERIES.length} queries ===`);
  const { videos, errors } = await searchYouTubeMulti(YT_QUERIES, {
    limit: 45,
    hl: "hi",
    gl: "IN",
    maxPages: 2,
  });
  console.log(`  raw unique videos: ${videos.length}${errors.length ? `, ${errors.length} query errors` : ""}`);
  for (const e of errors) console.log(`    ! "${e.query}": ${e.error}`);

  // Exact stats + real publishedAt beat scraped relative dates for filtering.
  const token = await youtubeAccessToken();
  let statsMap = new Map<string, any>();
  if (token) {
    const { stats, error } = await fetchVideoStats(videos.map((v) => v.videoId), { accessToken: token });
    if (error) console.log(`  API enrichment unavailable: ${error}`);
    else {
      statsMap = stats;
      console.log(`  API enriched ${stats.size}/${videos.length} videos with exact stats`);
    }
  } else {
    console.log("  API enrichment skipped (no usable YouTube token) — using scraped values");
  }

  const rows: Record<string, unknown>[] = [];
  const all: Record<string, unknown>[] = [];

  for (const v of videos as (YtVideo & { matchedQueries: string[] })[]) {
    const s = statsMap.get(v.videoId);
    const published = s?.publishedAt ?? v.publishedEstimate;
    const text = [v.title, v.description, v.channelName, s?.description, (s?.tags ?? []).join(" ")]
      .filter(Boolean)
      .join(" ");
    const c = classify(text, published, {
      views: s?.viewCount ?? v.viewCount,
      likes: s?.likeCount,
      comments: s?.commentCount,
    });

    const row = {
      platform: "youtube",
      url: v.url,
      video_id: v.videoId,
      title: s?.title ?? v.title,
      channel: s?.channelTitle ?? v.channelName,
      channel_url: v.channelUrl ?? "",
      published_at: published ?? "",
      published_text: v.publishedText ?? "",
      content_type: v.isShort ? "short/reel" : v.isLive ? "live" : "video",
      duration: v.durationText ?? "",
      views: s?.viewCount ?? v.viewCount ?? "",
      likes: s?.likeCount ?? "",
      comments: s?.commentCount ?? "",
      hashtags: (text.match(/#[\wऀ-ॿ]+/g) ?? []).join(" "),
      event_tags: eventTagsFor(text).join(" | "),
      matched_queries: v.matchedQueries.join(" | "),
      data_source: s ? "scrape+api" : "scrape",
      ...flat(c),
    };
    all.push(row);
    if (passesStrict(c)) rows.push(row);
  }

  rows.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  all.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  console.log(`  passed strict filter (campaign + UP + recent): ${rows.length}/${all.length}`);
  return { rows, all };
}

// ── Instagram ──────────────────────────────────────────────────────────────
async function harvestInstagram() {
  console.log(`\n=== INSTAGRAM — ${IG_TAGS.length} hashtags ===`);
  const { data: sess } = await db
    .from("insta_sessions")
    .select("id, label, session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sess?.session_id_encrypted) {
    console.log("  no active Instagram session — skipping");
    return { rows: [], all: [], status: "session_required" as const };
  }

  let session: string;
  try {
    session = decrypt(sess.session_id_encrypted);
  } catch {
    console.log("  session could not be decrypted — skipping");
    return { rows: [], all: [], status: "decrypt_failed" as const };
  }

  const rows: Record<string, unknown>[] = [];
  const all: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let dead = false;

  for (const tag of IG_TAGS) {
    if (dead) break;
    try {
      const r = await fetchHashtagMedia(tag, session, 45);
      console.log(`  #${tag}: ${r.items.length} items (tag total ${r.mediaCount ?? "?"})`);

      for (const item of r.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const caption = item.caption ?? "";
        const owner = item.ownerUsername ?? "";
        const text = `${caption} ${owner} #${tag}`;
        const published =
          typeof item.takenAt === "number" ? new Date(item.takenAt * 1000).toISOString() : null;

        const c = classify(text, published, {
          views: item.views,
          likes: item.likes,
          comments: item.comments,
        });

        const row = {
          platform: "instagram",
          url: item.url,
          shortcode: item.shortcode,
          content_type: item.kind,
          account: owner,
          account_url: owner ? `https://www.instagram.com/${owner}/` : "",
          published_at: published ?? "",
          caption: caption.replace(/\s+/g, " ").slice(0, 500),
          views: item.views ?? "",
          likes: item.likes,
          comments: item.comments,
          media_url: item.videoUrl ?? item.displayUrl ?? "",
          hashtags: (caption.match(/#[\wऀ-ॿ]+/g) ?? []).join(" "),
          event_tags: eventTagsFor(text).join(" | "),
          matched_hashtag: tag,
          data_source: "ig_web_api",
          ...flat(c),
        };
        all.push(row);
        if (passesStrict(c)) rows.push(row);
      }
    } catch (err: any) {
      if (err instanceof InstaAuthError) {
        console.log(`  #${tag}: session died — ${err.message}`);
        dead = true;
      } else {
        console.log(`  #${tag}: ${err?.message ?? "failed"}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  rows.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  all.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  console.log(`  passed strict filter: ${rows.length}/${all.length}`);
  return { rows, all, status: dead ? ("session_died" as const) : ("ok" as const) };
}

// ── Facebook ───────────────────────────────────────────────────────────────
async function harvestFacebook() {
  console.log(`\n=== FACEBOOK — ${FB_TARGETS.length} target pages ===`);
  console.log("  note: Facebook has no keyword/hashtag search; harvesting named pages only");

  const { data: sess } = await db
    .from("fb_sessions")
    .select("id, label, cookie_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let cookies: string | null = null;
  let sessionLive = false;
  if (sess?.cookie_encrypted) {
    try {
      cookies = decrypt(sess.cookie_encrypted);
      await establishGraphqlSession(cookies);
      sessionLive = true;
      console.log("  session: LIVE");
    } catch (err: any) {
      console.log(`  session: DEAD — ${err?.message ?? "unknown"}`);
    }
  } else {
    console.log("  session: none stored");
  }

  if (!sessionLive || !cookies) {
    // Emit real seed posts plus the target list, so the file carries actual
    // links now and becomes fully harvestable the moment cookies land.
    const seeds = FB_SEED_POSTS.map((s) => {
      const c = classify(s.text, new Date().toISOString(), {});
      return {
        platform: "facebook",
        row_kind: "confirmed_post",
        url: s.url,
        page: s.page,
        text: s.text,
        likes: "",
        comments: "",
        shares: "",
        status: "link_verified_metrics_pending",
        note: "Found via search; engagement needs a live Facebook session",
        ...flat(c),
      };
    });
    const targets = FB_TARGETS.map((t) => ({
      platform: "facebook",
      row_kind: "page_target",
      url: `https://www.facebook.com/${t.handle}`,
      page: t.handle,
      text: "",
      status: "session_required",
      note: t.note,
      instruction: "Add fresh c_user+xs cookies in Settings → Facebook, then re-run this harvest",
    }));
    const rows = [...seeds, ...targets];
    return { rows, all: rows, status: "session_required" as const };
  }

  const rows: Record<string, unknown>[] = [];
  const all: Record<string, unknown>[] = [];

  for (const target of FB_TARGETS) {
    try {
      const { data: posts, source } = await scrapePosts({
        target: target.handle,
        cookies,
        method: "auto",
        pages: 2,
        limit: 25,
      });
      console.log(`  ${target.handle}: ${posts.length} posts via ${source ?? "none"}`);

      for (const p of posts) {
        const text = `${p.text} ${p.username ?? ""}`;
        const c = classify(text, p.time, {
          views: null,
          likes: p.likes,
          comments: p.comments,
        });
        const row = {
          platform: "facebook",
          url: p.postUrl ?? "",
          post_id: p.postId,
          page: target.handle,
          account: p.username ?? "",
          published_at: p.time ?? "",
          text: p.text.replace(/\s+/g, " ").slice(0, 500),
          likes: p.likes,
          comments: p.comments,
          shares: p.shares,
          image: p.image ?? "",
          link: p.link ?? "",
          hashtags: (p.text.match(/#[\wऀ-ॿ]+/g) ?? []).join(" "),
          event_tags: eventTagsFor(text).join(" | "),
          data_source: source ?? "",
          ...flat(c),
        };
        all.push(row);
        if (passesStrict(c)) rows.push(row);
      }
    } catch (err: any) {
      console.log(`  ${target.handle}: ${err?.message ?? "failed"}`);
    }
  }

  rows.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  console.log(`  passed strict filter: ${rows.length}/${all.length}`);
  return { rows, all, status: "ok" as const };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("CJP School Theek Karo Abhiyan — Uttar Pradesh harvest");
  console.log(`started ${new Date().toISOString()}`);

  const yt = await harvestYouTube();
  const ig = await harvestInstagram();
  const fb = await harvestFacebook();

  const written = [
    writeCsv("cjp_school_youtube", yt.rows),
    writeCsv("cjp_school_insta", ig.rows),
    writeCsv("cjp_school_facebook", fb.rows),
    // Unfiltered companions, so the filter itself is auditable.
    writeCsv("cjp_school_youtube_all", yt.all),
    writeCsv("cjp_school_insta_all", ig.all),
    writeCsv("cjp_school_facebook_all", fb.all),
  ];

  console.log("\n=== WRITTEN ===");
  for (const p of written) console.log(`  ${p}`);
  console.log("\n=== SUMMARY ===");
  console.log(`  youtube  : ${yt.rows.length} strict / ${yt.all.length} total`);
  console.log(`  instagram: ${ig.rows.length} strict / ${ig.all.length} total  [${ig.status}]`);
  console.log(`  facebook : ${fb.rows.length} strict / ${fb.all.length} total  [${fb.status}]`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
