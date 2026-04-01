import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { getPublishQueue } from "@/server/queue/queues";
import { getPlatformMetadata } from "@/server/services/media/rules-engine";

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

      await db
        .from("publish_jobs")
        .update({ status: "dead" })
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

  getStats: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: jobs, error } = await db
        .from("publish_jobs")
        .select("status, content_posts!inner(brand_id)")
        .eq("content_posts.brand_id", input.brandId);

      const all = error ? [] : (jobs || []);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return {
        queued: all.filter((j: any) => j.status === "queued").length,
        processing: all.filter((j: any) => j.status === "processing").length,
        completed: all.filter((j: any) => j.status === "completed").length,
        failed: all.filter((j: any) => j.status === "failed").length,
        dead: all.filter((j: any) => j.status === "dead").length,
      };
    }),
});
