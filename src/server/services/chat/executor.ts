import { getDb } from "@/lib/supabase/db";
import { isToolAllowed } from "./tools";
import { logAudit } from "@/server/services/audit";
import { getPlatformMetadata } from "@/server/services/media/rules-engine";

interface UserContext {
  userId: string;
  role: string;
  brandId: string;
  orgId: string;
}

export async function executeTool(
  toolName: string,
  toolArgs: any,
  ctx: UserContext
): Promise<{ success: boolean; result: any; error?: string }> {
  // Normalize tool name — LLMs sometimes add trailing spaces
  toolName = toolName.trim();

  // Defense in depth — double-check role
  if (!isToolAllowed(toolName, ctx.role)) {
    return { success: false, result: null, error: `Your role (${ctx.role}) cannot use ${toolName}.` };
  }

  const db = getDb();

  try {
    let result: any;

    switch (toolName) {
      case "list_media": {
        const { data } = await db.from("media_groups")
          .select("id, title, status, variant_count, tags, created_at, media_assets(file_type, width, height, aspect_ratio, duration_seconds)")
          .eq("brand_id", ctx.brandId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (toolArgs.search) {
          result = (data || []).filter((g: any) => g.title?.toLowerCase().includes(toolArgs.search.toLowerCase()));
        } else if (toolArgs.status) {
          result = (data || []).filter((g: any) => g.status === toolArgs.status);
        } else {
          result = data;
        }
        break;
      }

      case "get_media_details": {
        const { data } = await db.from("media_groups")
          .select("*, media_assets(*)")
          .eq("id", toolArgs.groupId)
          .single();

        // Fetch previous publish history for duplicate detection
        let previousPublishJobs: any[] = [];
        if (data?.id) {
          const { data: posts } = await db.from("content_posts")
            .select("id, status, publish_jobs(id, asset_id, social_account_id, action, status, platform_post_id)")
            .eq("group_id", data.id);
          previousPublishJobs = (posts || []).flatMap((p: any) =>
            (p.publish_jobs || []).map((j: any) => ({
              assetId: j.asset_id,
              socialAccountId: j.social_account_id,
              action: j.action,
              status: j.status,
              platformPostId: j.platform_post_id,
            }))
          );
        }

        result = { ...data, previousPublishJobs };
        break;
      }

      case "schedule_content": {
        console.log("[chat-executor] schedule_content args:", JSON.stringify(toolArgs));
        // Get the group's assets and metadata (caption, title, tags) for platformMeta
        const { data: groupAssets } = await db.from("media_groups")
          .select("brand_id, title, caption, tags, media_assets(id, file_name)")
          .eq("id", toolArgs.groupId)
          .single();

        // Build a lookup of valid asset IDs from this group
        const validAssetIds = new Set(
          (groupAssets?.media_assets || []).map((a: any) => a.id)
        );
        const defaultAssetId = groupAssets?.media_assets?.[0]?.id;

        if (!defaultAssetId) {
          return { success: false, result: null, error: "This media group has no assets to publish." };
        }

        // Resolve caption, title, tags from LLM args → group data → empty fallback
        const caption = toolArgs.caption || groupAssets?.caption || groupAssets?.title || "";
        const title = toolArgs.title || groupAssets?.title || "";
        const description = toolArgs.description || "";
        const tags: string[] = groupAssets?.tags
          ? (Array.isArray(groupAssets.tags) ? groupAssets.tags : [String(groupAssets.tags)])
          : [];

        // Build jobs — each action gets proper platform-aware metadata via the rules engine
        const jobs = [];
        for (const action of toolArgs.actions || []) {
          // LLM often sends groupId as assetId — always resolve to a real asset
          const assetId = (action.assetId && validAssetIds.has(action.assetId))
            ? action.assetId
            : defaultAssetId;
          if (!assetId) continue;

          // Use the same getPlatformMetadata() that Click Mode uses
          const platformMeta = getPlatformMetadata(
            action.action,
            caption,
            tags,
            title,
            description,
          );

          for (const accountId of action.accountIds || []) {
            jobs.push({
              assetId,
              socialAccountId: accountId,
              action: action.action,
              resizeOption: null,
              platformMeta,
            });
          }
        }

        // Create content post
        const status = toolArgs.scheduledAt ? "scheduled" : "publishing";

        const { data: post } = await db.from("content_posts").insert({
          group_id: toolArgs.groupId,
          brand_id: groupAssets?.brand_id || ctx.brandId,
          scheduled_by: ctx.userId,
          status,
          scheduled_at: toolArgs.scheduledAt || new Date().toISOString(),
          source: "chat",
        }).select().single();

        let queuedCount = 0;
        if (post) {
          const { getPublishQueue } = require("@/server/queue/queues");
          const queue = getPublishQueue();
          const delay = toolArgs.scheduledAt
            ? Math.max(0, new Date(toolArgs.scheduledAt).getTime() - Date.now())
            : 0;

          for (const job of jobs) {
            const { data: pj, error: pjError } = await db.from("publish_jobs").insert({
              post_id: post.id,
              asset_id: job.assetId,
              social_account_id: job.socialAccountId,
              action: job.action,
              resize_option: job.resizeOption,
              status: "queued",
            }).select().single();

            if (pjError) {
              console.error("[chat-executor] publish_jobs insert failed:", pjError.message, "assetId:", job.assetId);
            }

            // Queue in BullMQ so the worker picks it up
            if (pj) {
              queuedCount++;
              await queue.add(`publish-${pj.id}`, {
                publishJobId: pj.id,
                postId: post.id,
                assetId: job.assetId,
                socialAccountId: job.socialAccountId,
                action: job.action,
                resizeOption: job.resizeOption,
                groupId: toolArgs.groupId,
                platformMeta: job.platformMeta,
              }, { delay });
            }
          }
        }

        result = { postId: post?.id, jobCount: queuedCount, status };
        if (queuedCount === 0 && jobs.length > 0) {
          return { success: false, result: null, error: `Failed to create publish jobs. The asset or account may be invalid. Tried ${jobs.length} job(s) but none were inserted.` };
        }
        break;
      }

      case "get_analytics": {
        const { data: jobs } = await db.from("publish_jobs")
          .select("status, content_posts!inner(brand_id)")
          .eq("content_posts.brand_id", ctx.brandId);

        const { data: analytics } = await db.from("post_analytics")
          .select("views, likes, comments, shares, saves")
          .limit(100);

        const totals = (analytics || []).reduce((acc: any, a: any) => ({
          views: acc.views + (a.views || 0),
          likes: acc.likes + (a.likes || 0),
          comments: acc.comments + (a.comments || 0),
          shares: acc.shares + (a.shares || 0),
        }), { views: 0, likes: 0, comments: 0, shares: 0 });

        const allJobs = jobs || [];
        result = {
          totals,
          published: allJobs.filter((j: any) => j.status === "completed").length,
          scheduled: allJobs.filter((j: any) => j.status === "queued").length,
          failed: allJobs.filter((j: any) => j.status === "failed" || j.status === "dead").length,
        };
        break;
      }

      case "list_accounts": {
        const { data } = await db.from("social_accounts")
          .select("id, platform, platform_username, is_active")
          .eq("brand_id", ctx.brandId);
        result = data;
        break;
      }

      case "get_queue_status": {
        const { data } = await db.from("publish_jobs")
          .select("id, status, action, error_message, content_posts!inner(brand_id, media_groups:group_id(title)), social_accounts:social_account_id(platform, platform_username)")
          .eq("content_posts.brand_id", ctx.brandId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (toolArgs.status && toolArgs.status !== "all") {
          result = (data || []).filter((j: any) => j.status === toolArgs.status);
        } else {
          result = data;
        }
        break;
      }

      case "retry_failed": {
        await db.from("publish_jobs").update({ status: "queued", attempt_count: 0, error_message: null }).eq("id", toolArgs.jobId);
        result = { success: true, message: "Job re-queued" };
        break;
      }

      case "cancel_scheduled": {
        await db.from("publish_jobs").update({ status: "cancelled" }).eq("id", toolArgs.jobId).eq("status", "queued");
        result = { success: true, message: "Job cancelled" };
        break;
      }

      case "list_brands": {
        const { data } = await db.from("brands").select("id, name, setup_status").eq("org_id", ctx.orgId);
        result = data;
        break;
      }

      default:
        return { success: false, result: null, error: `Unknown tool: ${toolName}` };
    }

    // Audit log
    logAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "chat_tool_call",
      resourceType: "chat",
      source: "chat",
      metadata: { tool: toolName, args: toolArgs },
    });

    return { success: true, result };
  } catch (err: any) {
    return { success: false, result: null, error: err.message };
  }
}
