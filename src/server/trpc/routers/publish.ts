import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { getValidActions, getPlatformMetadata } from "@/server/services/media/rules-engine";
import { getPublishQueue } from "@/server/queue/queues";
import { logAudit } from "@/server/services/audit";

const actionSchema = z.enum(["ig_post", "ig_reel", "ig_story", "ig_carousel", "yt_video", "yt_short", "li_post", "li_article", "fb_post", "fb_reel", "fb_story", "tt_video", "tw_post", "sc_story"]);

export const publishRouter = router({
  // Get all data needed for publish page
  getPublishData: protectedProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: group, error } = await db
        .from("media_groups")
        .select("*, media_assets(*)")
        .eq("id", input.groupId)
        .single();

      if (error || !group) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });
      }

      assertBrandAccess(profile, group.brand_id);

      // Get social accounts for this brand
      const { data: accounts } = await db
        .from("social_accounts")
        .select("*")
        .eq("brand_id", group.brand_id)
        .eq("is_active", true);

      // Get valid actions per asset
      const assetsWithActions = (group.media_assets || []).map((asset: any) => ({
        ...asset,
        validActions: getValidActions(asset, group.variant_count),
      }));

      // Get previous publish jobs for this group (completed/processing/queued)
      const { data: previousJobs } = await db
        .from("content_posts")
        .select("id, status, publish_jobs(id, asset_id, social_account_id, action, status, platform_post_id)")
        .eq("group_id", input.groupId)
        .in("status", ["published", "publishing", "scheduled"]);

      // Flatten all previous jobs
      const flatPreviousJobs = (previousJobs || []).flatMap((post: any) =>
        (post.publish_jobs || []).map((j: any) => ({
          assetId: j.asset_id,
          socialAccountId: j.social_account_id,
          action: j.action,
          status: j.status,
          platformPostId: j.platform_post_id,
        }))
      );

      return {
        group: { ...group, media_assets: assetsWithActions },
        accounts: (accounts || []).reduce((acc: any, a: any) => {
          if (!acc[a.platform]) acc[a.platform] = [];
          acc[a.platform].push(a);
          return acc;
        }, {}),
        previousJobs: flatPreviousJobs,
      };
    }),

  // Get valid actions for a specific asset
  getValidActions: protectedProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: asset } = await db
        .from("media_assets")
        .select("*, group:media_groups(variant_count, brand_id)")
        .eq("id", input.assetId)
        .single();

      if (!asset) throw new TRPCError({ code: "NOT_FOUND" });
      if (asset.group?.brand_id) assertBrandAccess(profile, asset.group.brand_id);

      return getValidActions(asset, asset.group?.variant_count || 1);
    }),

  // Schedule publishing
  schedule: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        scheduledAt: z.string().nullable(), // null = publish now
        jobs: z.array(
          z.object({
            assetId: z.string().uuid(),
            socialAccountId: z.string().uuid(),
            action: actionSchema,
            resizeOption: z.enum(["auto_crop", "blur_bg", "custom_crop", "keep_original"]).nullable(),
          })
        ),
        captionOverrides: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get group for brand_id and metadata
      const { data: group } = await db
        .from("media_groups")
        .select("brand_id, caption, tags, title, description")
        .eq("id", input.groupId)
        .single();

      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, group.brand_id);

      const status = input.scheduledAt ? "scheduled" : "publishing";

      // Create content_post
      const { data: post, error: postError } = await db
        .from("content_posts")
        .insert({
          group_id: input.groupId,
          brand_id: group.brand_id,
          scheduled_by: profile.id,
          status,
          caption_overrides: input.captionOverrides || {},
          scheduled_at: input.scheduledAt || new Date().toISOString(),
          source: "click",
        })
        .select()
        .single();

      if (postError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: postError.message });

      // Create publish_jobs and queue them
      const queue = getPublishQueue();
      const jobResults = [];
      const jobErrors: string[] = [];

      for (const job of input.jobs) {
        const platformMeta = getPlatformMetadata(
          job.action,
          group.caption || "",
          group.tags || [],
          group.title,
          group.description,
          input.captionOverrides,
          job.socialAccountId
        );

        const { data: publishJob, error: jobError } = await db
          .from("publish_jobs")
          .insert({
            post_id: post.id,
            asset_id: job.assetId,
            social_account_id: job.socialAccountId,
            action: job.action,
            resize_option: job.resizeOption,
            status: "queued",
          })
          .select()
          .single();

        if (jobError) {
          jobErrors.push(`Job for asset ${job.assetId} / account ${job.socialAccountId}: ${jobError.message}`);
          continue;
        }

        // Queue in BullMQ
        const delay = input.scheduledAt
          ? Math.max(0, new Date(input.scheduledAt).getTime() - Date.now())
          : 0;

        await queue.add(
          `publish-${publishJob.id}`,
          {
            publishJobId: publishJob.id,
            postId: post.id,
            assetId: job.assetId,
            socialAccountId: job.socialAccountId,
            action: job.action,
            resizeOption: job.resizeOption,
            groupId: input.groupId,
            platformMeta,
          },
          { delay }
        );

        jobResults.push(publishJob);
      }

      // If all jobs failed, throw an error
      if (jobResults.length === 0 && jobErrors.length > 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `All publish jobs failed to create: ${jobErrors.join("; ")}`,
        });
      }

      // Update media group status
      await db
        .from("media_groups")
        .update({ status: input.scheduledAt ? "scheduled" : "published" })
        .eq("id", input.groupId);

      logAudit({ orgId: profile.org_id, userId: profile.id, action: input.scheduledAt ? "post.schedule" : "post.publish", resourceType: "content_post", resourceId: post.id, metadata: { jobCount: jobResults.length } });
      return { postId: post.id, jobCount: jobResults.length, failedCount: jobErrors.length, errors: jobErrors.length > 0 ? jobErrors : undefined };
    }),

  // Save as draft (no queue)
  saveDraft: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        jobs: z.array(
          z.object({
            assetId: z.string().uuid(),
            socialAccountId: z.string().uuid(),
            action: actionSchema,
            resizeOption: z.enum(["auto_crop", "blur_bg", "custom_crop", "keep_original"]).nullable(),
          })
        ),
        captionOverrides: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: group } = await db
        .from("media_groups")
        .select("brand_id")
        .eq("id", input.groupId)
        .single();

      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, group.brand_id);

      const { data: post, error } = await db
        .from("content_posts")
        .insert({
          group_id: input.groupId,
          brand_id: group.brand_id,
          scheduled_by: profile.id,
          status: "draft",
          caption_overrides: input.captionOverrides || {},
          source: "click",
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      for (const job of input.jobs) {
        await db.from("publish_jobs").insert({
          post_id: post.id,
          asset_id: job.assetId,
          social_account_id: job.socialAccountId,
          action: job.action,
          resize_option: job.resizeOption,
          status: "queued",
        });
      }

      return { postId: post.id };
    }),

  // List scheduled posts for calendar
  listScheduled: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        startDate: z.string(),
        endDate: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("content_posts")
        .select("*, media_groups(title, tags), publish_jobs(action, social_account_id, status, social_accounts:social_account_id(platform, platform_username))")
        .eq("brand_id", input.brandId)
        .gte("scheduled_at", input.startDate)
        .lte("scheduled_at", input.endDate)
        .in("status", ["scheduled", "publishing", "published", "failed", "draft"])
        .order("scheduled_at", { ascending: true });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data || [];
    }),

  // Reschedule a post
  reschedule: protectedProcedure
    .input(
      z.object({
        postId: z.string().uuid(),
        newScheduledAt: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Fetch post to verify brand access
      const { data: post } = await db
        .from("content_posts")
        .select("brand_id")
        .eq("id", input.postId)
        .single();

      if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
      assertBrandAccess(profile, post.brand_id);

      const { error } = await db
        .from("content_posts")
        .update({ scheduled_at: input.newScheduledAt })
        .eq("id", input.postId);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Update BullMQ jobs: remove old queued jobs and re-add with new delay
      try {
        const { getPublishQueue } = await import("@/server/queue/queues");
        const publishQueue = getPublishQueue();

        // Get post with group data for rebuilding platformMeta
        const { data: postData } = await db
          .from("content_posts")
          .select("id, group_id, caption_overrides, media_groups:group_id(id, caption, tags, title, description)")
          .eq("id", input.postId)
          .single();

        const group = (postData as any)?.media_groups;

        // Get all queued publish_jobs for this post
        const { data: pendingJobs } = await db
          .from("publish_jobs")
          .select("id, asset_id, social_account_id, action, resize_option, post_id")
          .eq("post_id", input.postId)
          .eq("status", "queued");

        const delay = Math.max(0, new Date(input.newScheduledAt).getTime() - Date.now());

        for (const pj of pendingJobs || []) {
          // Try to remove the old job
          try {
            const existingJob = await publishQueue.getJob(`publish-${pj.id}`);
            if (existingJob) await existingJob.remove();
          } catch {
            // Job may not exist in queue yet
          }

          // Rebuild platformMeta from group data
          const platformMeta = group
            ? getPlatformMetadata(
                pj.action,
                group.caption || "",
                group.tags || [],
                group.title,
                group.description,
                postData?.caption_overrides
              )
            : {};

          await publishQueue.add(`publish-${pj.id}`, {
            publishJobId: pj.id,
            postId: pj.post_id,
            assetId: pj.asset_id,
            socialAccountId: pj.social_account_id,
            action: pj.action,
            resizeOption: pj.resize_option,
            groupId: postData?.group_id || "",
            platformMeta,
          }, {
            jobId: `publish-${pj.id}`,
            delay,
          });
        }
      } catch (e: any) {
        console.error("[reschedule] Failed to update BullMQ jobs:", e.message);
        // Non-fatal: DB is updated, queue update is best-effort
      }

      return { success: true };
    }),
});
