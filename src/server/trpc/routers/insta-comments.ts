import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { decrypt } from "@/lib/encryption";
import { getRedis } from "@/lib/redis";
import { fetchInstagramProfile, fetchUserFeed } from "@/server/services/instagram/fetcher";

/**
 * Instagram comment harvesting.
 *
 * Harvests take minutes to days, so this router only enqueues work and reads
 * progress — the actual fetching happens in the BullMQ worker
 * ("insta-comment-harvest"), which streams progress into insta_comment_runs.
 * The dashboard polls `getRun` rather than holding a request open.
 */

const QUEUE_NAME = "insta-comment-harvest";

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
  capabilities: protectedProcedure.query(async ({ ctx }) => {
    const { count } = await ctx.db
      .from("insta_sessions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.profile!.org_id)
      .eq("status", "active");
    return { hasSession: (count ?? 0) > 0, activeSessions: count ?? 0 };
  }),

  /** Profile + newest posts, so the user can pick what to harvest. */
  listPosts: protectedProcedure
    .input(z.object({ username: z.string().min(1), limit: z.number().int().min(1).max(200).default(5) }))
    .mutation(async ({ ctx, input }) => {
      const { session } = await resolveSession(ctx.db, ctx.profile!.org_id);
      const username = input.username.trim().replace(/^@/, "");

      const profile = await fetchInstagramProfile(username, session);
      const feed = await fetchUserFeed(profile.id, session, input.limit);

      return {
        profile: {
          username: profile.username,
          fullName: profile.fullName,
          followers: profile.followers,
          postsCount: profile.postsCount,
          profilePic: profile.profilePic,
          isVerified: profile.isVerified,
        },
        posts: feed.items.slice(0, input.limit).map((p) => ({
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

  /** Create the run row and enqueue it for the worker. */
  startHarvest: protectedProcedure
    .input(
      z.object({
        username: z.string().min(1),
        mediaIds: z.array(z.string().min(1)).min(1).max(500),
        concurrency: z.number().int().min(1).max(8).default(5),
        includeReplies: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.profile!.org_id as string;

      // One active harvest per org — concurrent runs on one session invite a
      // checkpoint, and the worker already parallelises across posts.
      const { data: active } = await ctx.db
        .from("insta_comment_runs")
        .select("id")
        .eq("org_id", orgId)
        .in("status", ["queued", "running"])
        .limit(1)
        .maybeSingle();
      if (active?.id) {
        throw new Error(`A harvest is already running (${active.id}). Wait for it or cancel it first.`);
      }

      const { id: sessionId, session } = await resolveSession(ctx.db, orgId);
      const username = input.username.trim().replace(/^@/, "");

      // Re-read the selected posts so expected totals are trustworthy rather
      // than whatever the client last saw.
      const profile = await fetchInstagramProfile(username, session);
      const feed = await fetchUserFeed(profile.id, session, Math.max(input.mediaIds.length, 12));
      const wanted = new Set(input.mediaIds);
      const posts = feed.items
        .filter((p) => wanted.has(p.id))
        .map((p) => ({
          mediaId: p.id,
          shortcode: p.shortcode,
          url: p.url,
          kind: p.kind,
          commentCount: p.comments,
        }));

      if (!posts.length) {
        throw new Error("None of the selected posts could be resolved — reload the post list and retry.");
      }

      const expected = posts.reduce((a, p) => a + p.commentCount, 0);

      const { data: run, error } = await ctx.db
        .from("insta_comment_runs")
        .insert({
          org_id: orgId,
          user_id: ctx.profile!.id,
          session_id: sessionId,
          target_username: username,
          target_user_id: profile.id,
          post_limit: posts.length,
          concurrency: input.concurrency,
          include_replies: input.includeReplies,
          posts,
          status: "queued",
          expected_comments: expected,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      try {
        const { Queue } = await import("bullmq");
        const queue = new Queue(QUEUE_NAME, { connection: getRedis() });
        await queue.add(
          "harvest",
          { runId: run.id, orgId },
          { removeOnComplete: 50, removeOnFail: 50, attempts: 1 },
        );
        await queue.close();
      } catch (err: any) {
        await ctx.db
          .from("insta_comment_runs")
          .update({ status: "failed", error: `Could not enqueue: ${err?.message ?? err}` })
          .eq("id", run.id);
        throw new Error(`Could not enqueue the harvest: ${err?.message ?? err}`);
      }

      return { runId: run.id as string };
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
