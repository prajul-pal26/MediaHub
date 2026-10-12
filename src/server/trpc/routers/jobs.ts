import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { getPublishQueue } from "@/server/queue/queues";
import { getPlatformMetadata } from "@/server/services/media/rules-engine";

// Classify a publish action into the coarse content type shown on the queue
// dashboard. Reels/shorts are short-form vertical video; everything else
// (feed posts, carousels, long-form video, articles, stories) is a "post".
export function categorizeAction(action: string): "reel" | "post" {
  return /reel|short/i.test(action || "") ? "reel" : "post";
}

// Normalize a raw job status into one of the four queue buckets. "dead"
// (exhausted retries / cancelled) is surfaced alongside "failed".
function statusBucket(
  status: string
): "queued" | "processing" | "completed" | "failed" | "cancelled" {
  if (status === "processing") return "processing";
  if (status === "completed") return "completed";
  // 'cancelled' is a USER action, not a failure. Lumping it in with 'failed'
  // made a deliberately-stopped run look broken: 700 cancelled jobs rendered as
  // red "failed" next to only 20 that genuinely exhausted their retries.
  // 'dead' stays in failed — that IS retries exhausted.
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "dead") return "failed";
  return "queued";
}

type QueueCounts = {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
};
const emptyCounts = (): QueueCounts => ({
  queued: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
});

export const jobsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        status: z.string().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);
      const offset = (input.page - 1) * input.limit;

      let query = db
        .from("publish_jobs")
        .select(
          "*, content_posts!inner(brand_id, group_id, media_groups:group_id(title)), social_accounts:social_account_id(platform, platform_username), media_assets:asset_id(file_name, file_type)",
          { count: "exact" }
        )
        .eq("content_posts.brand_id", input.brandId)
        .order("created_at", { ascending: false })
        .range(offset, offset + input.limit - 1);

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data, error, count } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return { jobs: data || [], total: count || 0 };
    }),

  retry: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: job } = await db
        .from("publish_jobs")
        .select("*, content_posts!inner(brand_id, group_id, caption_overrides, media_groups:group_id(caption, tags, title, description))")
        .eq("id", input.jobId)
        .single();

      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, job.content_posts.brand_id);

      // Prevent retrying a job that already succeeded
      if (job.status === "completed" && job.platform_post_id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This job was already published successfully" });
      }

      // Reset status and re-queue
      await db
        .from("publish_jobs")
        .update({ status: "queued", attempt_count: 0, error_message: null })
        .eq("id", input.jobId);

      // Build platform metadata from the media group
      const group = job.content_posts.media_groups;
      const platformMeta = group
        ? getPlatformMetadata(
            job.action,
            group.caption || "",
            group.tags || [],
            group.title,
            group.description,
            job.content_posts.caption_overrides
          )
        : {};

      const queue = getPublishQueue();
      await queue.add(`publish-${job.id}`, {
        publishJobId: job.id,
        postId: job.post_id,
        assetId: job.asset_id,
        socialAccountId: job.social_account_id,
        action: job.action,
        resizeOption: job.resize_option,
        groupId: job.content_posts.group_id || "",
        platformMeta,
      });

      return { success: true };
    }),

  cancel: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Verify brand access via the post
      const { data: job } = await db
        .from("publish_jobs")
        .select("content_posts!inner(brand_id)")
        .eq("id", input.jobId)
        .single();

      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, job.content_posts.brand_id);

      // 'cancelled', not 'dead': 'dead' means the job ran and exhausted its
      // retries, and the UI colours that red. A job the user stopped was never
      // attempted and must not read as a failure.
      await db
        .from("publish_jobs")
        .update({ status: "cancelled" })
        .eq("id", input.jobId)
        .in("status", ["queued"]);

      // Try to remove from BullMQ
      try {
        const queue = getPublishQueue();
        const bullJob = await queue.getJob(`publish-${input.jobId}`);
        if (bullJob) await bullJob.remove();
      } catch {
        // Job may not exist in queue
      }

      return { success: true };
    }),

  // Queue dashboard stats: the same Queued/Processing/Completed/Failed counts,
  // split by content type (Post vs Reel). `overall` keeps the brand-wide totals.
  getStats: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: jobs, error } = await db
        .from("publish_jobs")
        .select("status, action, content_posts!inner(brand_id)")
        .eq("content_posts.brand_id", input.brandId);

      const all = error ? [] : (jobs || []);

      const overall = emptyCounts();
      const post = emptyCounts();
      const reel = emptyCounts();

      for (const job of all as any[]) {
        const bucket = statusBucket(job.status);
        overall[bucket]++;
        (categorizeAction(job.action) === "reel" ? reel : post)[bucket]++;
      }

      return { overall, post, reel };
    }),

  // Retry every failed/dead job for a media group (optionally only the Post or
  // Reel ones). Re-queues each job the same way the single-job `retry` does.
  retryGroupFailed: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        category: z.enum(["all", "post", "reel"]).default("all"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Authorize via the media group's brand.
      const { data: group } = await db
        .from("media_groups")
        .select("brand_id")
        .eq("id", input.groupId)
        .single();
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, group.brand_id);

      // Pull all failed/dead jobs for the group with the data needed to re-queue.
      const { data: jobs, error } = await db
        .from("publish_jobs")
        .select(
          "id, action, post_id, asset_id, social_account_id, resize_option, platform_post_id, status, " +
            "content_posts!inner(group_id, caption_overrides, media_groups:group_id(caption, tags, title, description))"
        )
        .eq("content_posts.group_id", input.groupId)
        .in("status", ["failed", "dead", "cancelled"]);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      const queue = getPublishQueue();
      let retried = 0;

      for (const job of (jobs || []) as any[]) {
        // Never re-publish a job that actually succeeded.
        if (job.status === "completed" && job.platform_post_id) continue;
        if (input.category !== "all" && categorizeAction(job.action) !== input.category) continue;

        await db
          .from("publish_jobs")
          .update({ status: "queued", attempt_count: 0, error_message: null })
          .eq("id", job.id);

        const mg = job.content_posts?.media_groups;
        const platformMeta = mg
          ? getPlatformMetadata(
              job.action,
              mg.caption || "",
              mg.tags || [],
              mg.title,
              mg.description,
              job.content_posts.caption_overrides
            )
          : {};

        await queue.add(`publish-${job.id}`, {
          publishJobId: job.id,
          postId: job.post_id,
          assetId: job.asset_id,
          socialAccountId: job.social_account_id,
          action: job.action,
          resizeOption: job.resize_option,
          groupId: input.groupId,
          platformMeta,
        });

        retried++;
      }

      return { success: true, retried };
    }),

  // Per-media breakdown: one entry per media group that has publish jobs, with
  // its own Queued/Processing/Completed/Failed counts split into Post and Reel.
  listGroups: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: jobsData, error } = await db
        .from("publish_jobs")
        .select("status, action, content_posts!inner(brand_id, group_id)")
        .eq("content_posts.brand_id", input.brandId);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Accumulate per-group, per-category counts.
      const groupMap = new Map<
        string,
        { post: QueueCounts; reel: QueueCounts; total: number }
      >();

      for (const job of (jobsData || []) as any[]) {
        const groupId = job.content_posts?.group_id;
        if (!groupId) continue;
        if (!groupMap.has(groupId)) {
          groupMap.set(groupId, { post: emptyCounts(), reel: emptyCounts(), total: 0 });
        }
        const entry = groupMap.get(groupId)!;
        const bucket = statusBucket(job.status);
        entry[categorizeAction(job.action)][bucket]++;
        entry.total++;
      }

      const groupIds = [...groupMap.keys()];
      if (groupIds.length === 0) return { groups: [] };

      // Explicit columns, and NOT `media_assets(*)`.
      //
      // `media_assets.metadata` holds a base64 data URL of the whole original
      // (see UploadForm's thumbnail), so `*` made this response **6.58 MB** —
      // measured. MediaLibrary polls this every 5s and only reads the job
      // counts, so that was ~1.3 MB/s of transfer plus a 6.5 MB JSON.parse on
      // the main thread every five seconds, which is what made the Media
      // Library feel slow. The queue card needs only enough to build a
      // thumbnail URL (`/api/media/<id>?variant=thumb`), never the blob itself.
      const { data: metaRows } = await db
        .from("media_groups")
        .select(
          "id, title, variant_count, created_at, status, media_assets(id, file_type, sort_order)"
        )
        .in("id", groupIds);

      const meta = new Map<string, any>();
      for (const row of metaRows || []) meta.set(row.id, row);

      const groups = groupIds
        .map((id) => {
          const entry = groupMap.get(id)!;
          const m = meta.get(id) || {};
          const hasPost = entry.post.queued + entry.post.processing + entry.post.completed + entry.post.failed > 0;
          const hasReel = entry.reel.queued + entry.reel.processing + entry.reel.completed + entry.reel.failed > 0;
          return {
            ...m,
            id,
            title: m.title || "Untitled",
            variant_count: m.variant_count ?? 1,
            created_at: m.created_at || null,
            status: m.status || "available",
            media_assets: m.media_assets || [],
            totalJobs: entry.total,
            hasPost,
            hasReel,
            post: entry.post,
            reel: entry.reel,
          };
        })
        .sort((a, b) => {
          const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
          const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
          return tb - ta;
        });

      return { groups };
    }),
});
