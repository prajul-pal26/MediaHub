import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { decrypt } from "@/lib/encryption";
import { getRedis } from "@/lib/redis";
import { fetchInstagramProfile, fetchUserFeed } from "@/server/services/instagram/fetcher";
import { assertInstagramDriveDestination, instagramExportDestinations, loadInstagramProfileSheet, syncInstagramProfileSheet } from "@/server/services/instagram/drive-export";

/**
 * Instagram comment harvesting.
 *
 * Harvests take minutes to days, so this router only enqueues work and reads
 * progress — the actual fetching happens in the BullMQ worker
 * ("insta-comment-harvest"), which streams progress into insta_comment_runs.
 * The dashboard polls `getRun` rather than holding a request open.
 */

const QUEUE_NAME = "insta-comment-harvest";

/**
 * Link discovery and comment collection are deliberately separate phases.
 * A profile/feed request writes durable candidates first; the background
 * comment worker later consumes those rows without asking Instagram for the
 * feed again.  This keeps an already-discovered post/reel retryable even when
 * it has since moved beyond the account's newest feed page.
 */
async function saveDiscoveredMedia(
  db: any,
  orgId: string,
  targetUsername: string,
  media: Array<{
    id: string;
    shortcode: string;
    url: string;
    kind: string;
    likes: number;
    comments: number;
  }>,
) {
  const rows = media
    .filter((item) => item.id)
    .map((item) => ({
      org_id: orgId,
      target_username: targetUsername,
      media_id: item.id,
      shortcode: item.shortcode || null,
      media_url: item.url || null,
      media_kind: item.kind || null,
      likes_count: Number.isFinite(item.likes) ? item.likes : null,
      comments_count_reported: Number.isFinite(item.comments) ? item.comments : null,
      // Do not include comment state/count JSON here: an updated link scan must
      // never erase comments that a previous comment job already checkpointed.
    }));
  if (!rows.length) return 0;
  const { error } = await db
    .from("insta_comment_media")
    .upsert(rows, { onConflict: "org_id,target_username,media_id" });
  if (error) throw new Error(`Could not save Instagram media links: ${error.message}`);
  return rows.length;
}

async function ensureNoActiveHarvest(db: any, orgId: string, exceptRunId?: string) {
  let query = db
    .from("insta_comment_runs")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["queued", "running"])
    .limit(2);
  if (exceptRunId) query = query.neq("id", exceptRunId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  if (data?.[0]?.id) throw new Error("An Instagram comment harvest is already running. Wait for it to finish or cancel it first.");
}

async function enqueueHarvest(runId: string, orgId: string) {
  try {
    const { Queue } = await import("bullmq");
    const queue = new Queue(QUEUE_NAME, { connection: getRedis() });
    await queue.add("harvest", { runId, orgId }, { removeOnComplete: 50, removeOnFail: 50, attempts: 1 });
    await queue.close();
  } catch (error: any) {
    throw new Error(`Could not enqueue the harvest: ${error?.message ?? error}`);
  }
}

async function resolveSession(db: any, orgId: string): Promise<{ id: string; session: string }> {
  const { data } = await db
    .from("insta_sessions")
    .select("id, session_id_encrypted")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.session_id_encrypted) {
    throw new Error("No active Instagram session. Add one in Settings → Instagram.");
  }
  try {
    return { id: data.id, session: decrypt(data.session_id_encrypted) };
  } catch {
    throw new Error("Stored Instagram session could not be decrypted — re-add it in Settings.");
  }
}

export const instaCommentsRouter = router({
  exportDestinations: protectedProcedure.query(({ ctx }) => instagramExportDestinations(ctx.profile!)),

  /**
   * The reusable Instagram profile workspace.  Link discovery writes here
   * before a comment job is ever enqueued, so this list remains useful when a
   * user returns later to collect or retry comments.  It deliberately reads
   * Supabase only; Drive is an export destination, not a second mutable source
   * of truth for the scraper.
   */
  savedProfiles: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(1000).default(250) }))
    .query(async ({ ctx, input }) => {
      const orgId = ctx.profile!.org_id;
      const { data: media, error: mediaError } = await ctx.db
        .from("insta_comment_media")
        .select("target_username, media_kind, comments_count_reported, comments_scraped_count, updated_at, drive_synced_at")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false })
        .limit(10_000);
      if (mediaError) throw new Error(mediaError.message);

      const { data: runs, error: runError } = await ctx.db
        .from("insta_comment_runs")
        .select("target_username, status, drive_export_status, drive_exported_at, created_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(5_000);
      if (runError) throw new Error(runError.message);

      const workspaces = new Map<string, {
        username: string;
        mediaCount: number;
        postCount: number;
        reelCount: number;
        reportedComments: number;
        scrapedComments: number;
        updatedAt: string | null;
        latestRunStatus: string | null;
        driveSyncedAt: string | null;
      }>();
      for (const row of media ?? []) {
        const username = String((row as any).target_username ?? "").toLowerCase();
        if (!username) continue;
        const current = workspaces.get(username) ?? {
          username,
          mediaCount: 0,
          postCount: 0,
          reelCount: 0,
          reportedComments: 0,
          scrapedComments: 0,
          updatedAt: null,
          latestRunStatus: null,
          driveSyncedAt: null,
        };
        current.mediaCount += 1;
        if ((row as any).media_kind === "reel") current.reelCount += 1;
        else current.postCount += 1;
        current.reportedComments += Number((row as any).comments_count_reported ?? 0) || 0;
        current.scrapedComments += Number((row as any).comments_scraped_count ?? 0) || 0;
        if (!current.updatedAt || String((row as any).updated_at) > current.updatedAt) current.updatedAt = (row as any).updated_at;
        if (!current.driveSyncedAt || String((row as any).drive_synced_at ?? "") > current.driveSyncedAt) current.driveSyncedAt = (row as any).drive_synced_at ?? current.driveSyncedAt;
        workspaces.set(username, current);
      }
      for (const run of runs ?? []) {
        const current = workspaces.get(String((run as any).target_username ?? "").toLowerCase());
        if (!current) continue;
        if (!current.latestRunStatus) current.latestRunStatus = (run as any).status ?? null;
        if (!current.driveSyncedAt && (run as any).drive_export_status === "saved") {
          current.driveSyncedAt = (run as any).drive_exported_at ?? (run as any).created_at ?? null;
        }
      }
      return [...workspaces.values()]
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, input.limit);
    }),

  /** Explicit local-workspace → native Google Sheet sync. */
  syncProfile: protectedProcedure
    .input(z.object({ username: z.string().min(1), brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const saved = await syncInstagramProfileSheet(ctx.profile!, {
        brandId: input.brandId,
        username: input.username,
      });
      const username = input.username.trim().replace(/^@/, "").toLowerCase();
      const { error } = await ctx.db.from("insta_comment_media").update({
        drive_sheet_id: saved.id,
        drive_sheet_url: saved.url,
        drive_synced_at: new Date().toISOString(),
      }).eq("org_id", ctx.profile!.org_id).eq("target_username", username);
      if (error) throw new Error(`Sheet was updated but sync state could not be saved: ${error.message}`);
      return saved;
    }),

  /** Explicit cache refresh used when a saved profile is opened from the list. */
  loadProfileFromSheet: protectedProcedure
    .input(z.object({ username: z.string().min(1), brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => loadInstagramProfileSheet(ctx.profile!, input)),

  capabilities: protectedProcedure.query(async ({ ctx }) => {
    const { count } = await ctx.db
      .from("insta_sessions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.profile!.org_id)
      .eq("status", "active");
    return { hasSession: (count ?? 0) > 0, activeSessions: count ?? 0 };
  }),

  /** Discover a profile's newest links and persist them before any comments run. */
  listPosts: protectedProcedure
    .input(z.object({ username: z.string().min(1), limit: z.number().int().min(1).max(200).default(5) }))
    .mutation(async ({ ctx, input }) => {
      const { session } = await resolveSession(ctx.db, ctx.profile!.org_id);
      const username = input.username.trim().replace(/^@/, "").toLowerCase();

      const profile = await fetchInstagramProfile(username, session);
      const feed = await fetchUserFeed(profile.id, session, input.limit);
      const discovered = feed.items.slice(0, input.limit);
      const saved = await saveDiscoveredMedia(ctx.db, ctx.profile!.org_id, profile.username, discovered);

      return {
        profile: {
          username: profile.username,
          fullName: profile.fullName,
          followers: profile.followers,
          postsCount: profile.postsCount,
          profilePic: profile.profilePic,
          isVerified: profile.isVerified,
        },
        saved,
        posts: discovered.map((p) => ({
          mediaId: p.id,
          shortcode: p.shortcode,
          url: p.url,
          kind: p.kind,
          publishedAt: p.takenAt ? new Date(p.takenAt * 1000).toISOString() : null,
          likes: p.likes,
          commentCount: p.comments,
        })),
      };
    }),

  /** Read the durable link workspace. This never contacts Instagram. */
  listSavedMedia: protectedProcedure
    .input(z.object({ username: z.string().min(1), limit: z.number().int().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const username = input.username.trim().replace(/^@/, "").toLowerCase();
      const { data, error } = await ctx.db
        .from("insta_comment_media")
        .select("media_id, shortcode, media_url, media_kind, likes_count, comments_count_reported, comments_scraped_count, comments_top_level_count, comments_reply_count, comments_status, comments_stop_reason, comments_error, updated_at")
        .eq("org_id", ctx.profile!.org_id)
        .eq("target_username", username)
        .order("updated_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row: any) => ({
        mediaId: row.media_id,
        shortcode: row.shortcode,
        url: row.media_url,
        kind: row.media_kind,
        likes: row.likes_count,
        commentCount: row.comments_count_reported,
        scrapedCount: row.comments_scraped_count,
        topLevelCount: row.comments_top_level_count,
        replyCount: row.comments_reply_count,
        status: row.comments_status,
        stopReason: row.comments_stop_reason,
        error: row.comments_error,
        updatedAt: row.updated_at,
      }));
    }),

  /** Create the run row and enqueue it for the worker. */
  startHarvest: protectedProcedure
    .input(
      z.object({
        username: z.string().min(1),
        mediaIds: z.array(z.string().min(1)).min(1).max(500),
        driveBrandId: z.string().uuid().optional(),
        /** 0 means all available comments; a positive value caps each post. */
        commentLimit: z.number().int().min(0).max(500).default(0),
        // Instagram throttles at the account level. A bounded five-post pool
        // is fast while remaining materially safer than browser-style fanout.
        concurrency: z.number().int().min(1).max(5).default(3),
        includeReplies: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.profile!.org_id as string;
      if (input.driveBrandId) await assertInstagramDriveDestination(ctx.profile!, input.driveBrandId);

      // One account-scoped harvest at a time; its worker has its own bounded
      // per-post pool and shared rate governor.
      await ensureNoActiveHarvest(ctx.db, orgId);

      const { id: sessionId } = await resolveSession(ctx.db, orgId);
      const username = input.username.trim().replace(/^@/, "").toLowerCase();

      const wanted = new Set(input.mediaIds);
      const { data: savedMedia, error: savedMediaError } = await ctx.db
        .from("insta_comment_media")
        .select("media_id, shortcode, media_url, media_kind, likes_count, comments_count_reported")
        .eq("org_id", orgId)
        .eq("target_username", username)
        .in("media_id", [...wanted]);
      if (savedMediaError) throw new Error(savedMediaError.message);
      const posts: Array<{
        mediaId: string;
        shortcode: string | null;
        url: string | null;
        kind: string | null;
        commentCount: number;
        likes: number | null;
        publishedAt: null;
      }> = (savedMedia ?? []).map((post: any) => ({
        mediaId: post.media_id,
        shortcode: post.shortcode,
        url: post.media_url,
        kind: post.media_kind,
        commentCount: typeof post.comments_count_reported === "number" ? post.comments_count_reported : 0,
        likes: post.likes_count,
        publishedAt: null,
      }));

      if (!posts.length) {
        throw new Error("None of the selected posts are saved yet. Load the profile links first, then start comment collection.");
      }

      const expected = posts.reduce((a, p) => a + p.commentCount, 0);

      const { data: run, error } = await ctx.db
        .from("insta_comment_runs")
        .insert({
          org_id: orgId,
          user_id: ctx.profile!.id,
          session_id: sessionId,
          target_username: username,
          target_user_id: null,
          post_limit: posts.length,
          concurrency: input.concurrency,
          include_replies: input.includeReplies,
          drive_brand_id: input.driveBrandId ?? null,
          comment_limit: input.commentLimit,
          posts,
          status: "queued",
          expected_comments: expected,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      try {
        await enqueueHarvest(run.id, orgId);
      } catch (err: any) {
        await ctx.db
          .from("insta_comment_runs")
          .update({ status: "failed", error: `Could not enqueue: ${err?.message ?? err}` })
          .eq("id", run.id);
        throw new Error(`Could not enqueue the harvest: ${err?.message ?? err}`);
      }

      return { runId: run.id as string };
    }),

  /** Retry only selected incomplete posts in their existing durable run.
   * The run's unique comment IDs keep previously checkpointed comments, and
   * the worker merges newly visible comments rather than creating a second
   * disconnected result set. */
  retryRun: protectedProcedure
    .input(z.object({
      runId: z.string().uuid(),
      postIds: z.array(z.string().min(1)).min(1).max(50).optional(),
      minDelta: z.number().int().min(0).optional(),
      maxDelta: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.profile!.org_id as string;
      const { data: run, error } = await ctx.db
        .from("insta_comment_runs")
        .select("id, posts, progress, status")
        .eq("id", input.runId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!run) throw new Error("Instagram harvest run not found.");
      if (["queued", "running"].includes(run.status)) throw new Error("This Instagram harvest is already running.");
      await ensureNoActiveHarvest(ctx.db, orgId, run.id);
      await resolveSession(ctx.db, orgId);

      const requested = input.postIds ? new Set(input.postIds) : null;
      const progress = (run.progress as any)?.perPost ?? {};
      const selected = (Array.isArray(run.posts) ? run.posts : []).filter((post: any) => {
        if (!post?.mediaId) return false;
        if (requested) return requested.has(post.mediaId);
        const item = progress[post.mediaId];
        const reported = typeof item?.reportedCount === "number" ? item.reportedCount : post.commentCount;
        const scraped = typeof item?.scrapedCount === "number" ? item.scrapedCount : 0;
        const delta = Math.max(0, (reported ?? 0) - scraped);
        return delta >= (input.minDelta ?? 1) && delta <= (input.maxDelta ?? Number.MAX_SAFE_INTEGER);
      });
      if (!selected.length) return { runId: null, total: 0 };

      const { error: updateError } = await ctx.db
        .from("insta_comment_runs")
        .update({
          status: "queued",
          retry_media_ids: selected.map((post: any) => post.mediaId),
          error: null,
          started_at: null,
          completed_at: null,
        })
        .eq("id", run.id)
        .eq("org_id", orgId);
      if (updateError) throw new Error(updateError.message);
      try {
        await enqueueHarvest(run.id, orgId);
      } catch (error: any) {
        await ctx.db.from("insta_comment_runs").update({ status: run.status, retry_media_ids: null, error: error.message }).eq("id", run.id).eq("org_id", orgId);
        throw error;
      }
      return { runId: run.id as string, total: selected.length };
    }),

  getRun: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("insta_comment_runs")
        .select("*")
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Run not found");
      return data;
    }),

  listRuns: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("insta_comment_runs")
        .select(
          "id, target_username, status, expected_comments, total_comments, coverage_pct, request_count, throttle_count, throughput_per_sec, duration_ms, error, created_at, started_at, completed_at, post_limit",
        )
        .eq("org_id", ctx.profile!.org_id)
        .order("created_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),

  getComments: protectedProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        search: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      let query = ctx.db
        .from("insta_comments")
        .select(
          "post_media_id, post_shortcode, comment_id, comment_text, comment_created_at, comment_likes, depth, parent_comment_id, commenter_username, commenter_full_name, commenter_verified",
          { count: "exact" },
        )
        .eq("run_id", input.runId)
        .eq("org_id", ctx.profile!.org_id);

      if (input.search?.trim()) {
        const term = input.search.trim().replace(/[%,]/g, "");
        query = query.or(`comment_text.ilike.%${term}%,commenter_username.ilike.%${term}%`);
      }

      const { data, count, error } = await query
        .order("comment_likes", { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);
      if (error) throw new Error(error.message);
      return { rows: data ?? [], total: count ?? 0 };
    }),

  /** Full export for CSV/JSON download. Paged internally to dodge row caps. */
  exportRun: protectedProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rows: any[] = [];
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await ctx.db
          .from("insta_comments")
          .select(
            "post_media_id, post_shortcode, comment_id, comment_text, comment_created_at, comment_likes, depth, parent_comment_id, commenter_username, commenter_full_name, commenter_user_id, commenter_verified",
          )
          .eq("run_id", input.runId)
          .eq("org_id", ctx.profile!.org_id)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < PAGE) break;
      }
      return { rows };
    }),

  /** Cooperative cancel — the worker checks status between pages. */
  cancelRun: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("insta_comment_runs")
        .update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id)
        .in("status", ["queued", "running"]);
      if (error) throw new Error(error.message);
      return { ok: true };
    }),

  deleteRun: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("insta_comment_runs")
        .delete()
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }),
});
