import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { generateCommentReply } from "@/server/services/threads/reply-generator";

export const threadsRouter = router({
  // ━━━ List Comments (Thread Inbox) ━━━
  listComments: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        platform: z.enum(["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat", "all"]).default("all"),
        status: z.enum(["unread", "read", "replied", "archived", "flagged", "all"]).default("all"),
        sentiment: z.enum(["positive", "negative", "neutral", "question", "all"]).default("all"),
        search: z.string().optional(),
        postId: z.string().uuid().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const offset = (input.page - 1) * input.limit;

      let query = db
        .from("platform_comments")
        .select(
          "*, social_accounts(id, platform, platform_username), comment_replies(id, reply_text, status, sent_at, replied_by), content_posts(id, group_id, media_groups:group_id(title, caption))",
          { count: "exact" }
        )
        .eq("brand_id", input.brandId)
        .eq("is_hidden", false)
        .is("platform_parent_comment_id", null)
        .order("comment_timestamp", { ascending: false })
        .range(offset, offset + input.limit - 1);

      if (input.platform !== "all") query = query.eq("platform", input.platform);
      if (input.status !== "all") query = query.eq("status", input.status);
      if (input.sentiment !== "all") query = query.eq("sentiment", input.sentiment);
      if (input.postId) query = query.eq("post_id", input.postId);
      if (input.search) query = query.ilike("comment_text", `%${input.search}%`);

      const { data, error, count } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Flatten post context for easy frontend access
      const comments = (data || []).map((c: any) => {
        const post = c.content_posts;
        const group = post?.media_groups;
        return {
          ...c,
          post_title: group?.title || group?.caption?.slice(0, 60) || (post ? "Untitled post" : null),
          post_group_id: post?.group_id || null,
        };
      });

      return {
        comments,
        total: count || 0,
        page: input.page,
        totalPages: Math.ceil((count || 0) / input.limit),
      };
    }),

  // ━━━ Get Thread Detail (single comment + all replies) ━━━
  getThread: protectedProcedure
    .input(z.object({ commentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: comment, error } = await db
        .from("platform_comments")
        .select(
          "*, social_accounts(id, platform, platform_username, platform_metadata), comment_replies(id, reply_text, status, sent_at, error_message, replied_by, template_id, created_at)"
        )
        .eq("id", input.commentId)
        .single();

      if (error || !comment)
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });

      assertBrandAccess(profile, comment.brand_id);

      // Get post info if linked
      let postInfo = null;
      if (comment.post_id) {
        const { data: post } = await db
          .from("content_posts")
          .select("id, group_id, published_at, source")
          .eq("id", comment.post_id)
          .single();

        if (post?.group_id) {
          const { data: group } = await db
            .from("media_groups")
            .select("title, caption")
            .eq("id", post.group_id)
            .single();
          postInfo = { ...post, title: group?.title || group?.caption?.slice(0, 60) || "Untitled" };
        } else if (post) {
          postInfo = { ...post, title: "Imported post" };
        }
      }

      // Fetch nested platform replies (other users' replies to this comment)
      const { data: platformReplies } = await db
        .from("platform_comments")
        .select("id, platform, author_username, author_avatar_url, author_profile_url, comment_text, comment_timestamp, like_count, sentiment, platform_comment_id")
        .eq("platform_parent_comment_id", comment.platform_comment_id)
        .eq("platform", comment.platform)
        .eq("brand_id", comment.brand_id)
        .order("comment_timestamp", { ascending: true });

      // Mark as read if unread
      if (comment.status === "unread") {
        await db
          .from("platform_comments")
          .update({ status: "read" })
          .eq("id", input.commentId);
      }

      return { ...comment, postInfo, platformReplies: platformReplies || [] };
    }),

  // ━━━ Reply to Comment ━━━
  replyToComment: protectedProcedure
    .input(
      z.object({
        commentId: z.string().uuid(),
        replyText: z.string().min(1).max(2200),
        templateId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: comment } = await db
        .from("platform_comments")
        .select("id, brand_id, platform, platform_comment_id, platform_post_id, social_account_id, author_username")
        .eq("id", input.commentId)
        .single();

      if (!comment)
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });

      assertBrandAccess(profile, comment.brand_id);

      // Substitute template variables
      const replyText = input.replyText
        .replace(/\{\{author\}\}/gi, comment.author_username || "")
        .replace(/\{\{platform\}\}/gi, comment.platform || "");

      // Create reply record
      const { data: reply, error } = await db
        .from("comment_replies")
        .insert({
          comment_id: input.commentId,
          brand_id: comment.brand_id,
          replied_by: profile.id,
          reply_text: replyText,
          template_id: input.templateId || null,
          status: "pending",
        })
        .select()
        .single();

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Update template use_count
      if (input.templateId) {
        const { data: tmpl } = await db
          .from("reply_templates")
          .select("use_count")
          .eq("id", input.templateId)
          .single();
        if (tmpl) {
          await db
            .from("reply_templates")
            .update({ use_count: (tmpl.use_count || 0) + 1 })
            .eq("id", input.templateId);
        }
      }

      // Update comment status to replied
      await db
        .from("platform_comments")
        .update({ status: "replied" })
        .eq("id", input.commentId);

      return reply;
    }),

  // ━━━ Bulk Reply (drag-and-drop multiple comments with same reply) ━━━
  bulkReply: protectedProcedure
    .input(
      z.object({
        commentIds: z.array(z.string().uuid()).min(1).max(50),
        replyText: z.string().min(1).max(2200),
        templateId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Verify all comments belong to accessible brands
      const { data: comments } = await db
        .from("platform_comments")
        .select("id, brand_id, platform, platform_comment_id, platform_post_id, social_account_id, author_username")
        .in("id", input.commentIds);

      if (!comments || comments.length === 0)
        throw new TRPCError({ code: "NOT_FOUND", message: "No comments found" });

      // Check brand access for all
      const brandIds: string[] = [...new Set<string>(comments.map((c: any) => String(c.brand_id)))];
      for (const bid of brandIds) {
        assertBrandAccess(profile, bid);
      }

      // Create reply records for all (with template variable substitution)
      const replies = comments.map((comment: any) => ({
        comment_id: comment.id,
        brand_id: comment.brand_id,
        replied_by: profile.id,
        reply_text: input.replyText
          .replace(/\{\{author\}\}/gi, comment.author_username || "")
          .replace(/\{\{platform\}\}/gi, comment.platform || ""),
        template_id: input.templateId || null,
        status: "pending",
      }));

      const { data: inserted, error } = await db
        .from("comment_replies")
        .insert(replies)
        .select();

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Mark all as replied
      await db
        .from("platform_comments")
        .update({ status: "replied" })
        .in("id", input.commentIds);

      return { count: inserted?.length || 0, replies: inserted };
    }),

  // ━━━ Update Comment Status ━━━
  updateStatus: protectedProcedure
    .input(
      z.object({
        commentIds: z.array(z.string().uuid()).min(1),
        status: z.enum(["unread", "read", "replied", "archived", "flagged"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Verify access
      const { data: comments } = await db
        .from("platform_comments")
        .select("id, brand_id")
        .in("id", input.commentIds);

      if (!comments || comments.length === 0)
        throw new TRPCError({ code: "NOT_FOUND" });

      const brandIds: string[] = [...new Set<string>(comments.map((c: any) => String(c.brand_id)))];
      for (const bid of brandIds) {
        assertBrandAccess(profile, bid);
      }

      const { error } = await db
        .from("platform_comments")
        .update({ status: input.status })
        .in("id", input.commentIds);

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return { updated: comments.length };
    }),

  // ━━━ Get Inbox Stats ━━━
  getStats: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: comments } = await db
        .from("platform_comments")
        .select("status, platform, sentiment")
        .eq("brand_id", input.brandId)
        .eq("is_hidden", false)
        .is("platform_parent_comment_id", null);

      const all = comments || [];
      const byStatus: Record<string, number> = {};
      const byPlatform: Record<string, number> = {};
      const bySentiment: Record<string, number> = {};

      for (const c of all) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
        if (c.sentiment) bySentiment[c.sentiment] = (bySentiment[c.sentiment] || 0) + 1;
      }

      return {
        total: all.length,
        unread: byStatus["unread"] || 0,
        read: byStatus["read"] || 0,
        replied: byStatus["replied"] || 0,
        archived: byStatus["archived"] || 0,
        flagged: byStatus["flagged"] || 0,
        byPlatform,
        bySentiment,
      };
    }),

  // ━━━ Reply Templates CRUD ━━━
  listTemplates: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        category: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      let query = db
        .from("reply_templates")
        .select("*")
        .eq("brand_id", input.brandId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (input.category) query = query.eq("category", input.category);

      const { data, error } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || [];
    }),

  createTemplate: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        name: z.string().min(1).max(100),
        body: z.string().min(1).max(2200),
        category: z.enum(["general", "thanks", "question", "promotion", "support", "custom"]).default("general"),
        variables: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("reply_templates")
        .insert({
          brand_id: input.brandId,
          created_by: profile.id,
          name: input.name,
          body: input.body,
          category: input.category,
          variables: input.variables || [],
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data;
    }),

  updateTemplate: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        body: z.string().min(1).max(2200).optional(),
        category: z.enum(["general", "thanks", "question", "promotion", "support", "custom"]).optional(),
        sortOrder: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: template } = await db
        .from("reply_templates")
        .select("brand_id")
        .eq("id", input.id)
        .single();

      if (!template) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, template.brand_id);

      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (input.name !== undefined) updates.name = input.name;
      if (input.body !== undefined) updates.body = input.body;
      if (input.category !== undefined) updates.category = input.category;
      if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder;

      const { data, error } = await db
        .from("reply_templates")
        .update(updates)
        .eq("id", input.id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data;
    }),

  deleteTemplate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: template } = await db
        .from("reply_templates")
        .select("brand_id")
        .eq("id", input.id)
        .single();

      if (!template) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, template.brand_id);

      await db
        .from("reply_templates")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", input.id);

      return { success: true };
    }),

  // ━━━ Auto-Reply Settings ━━━
  getAutoReplySettings: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: brand } = await db
        .from("brands")
        .select("settings")
        .eq("id", input.brandId)
        .single();

      const settings = (brand?.settings || {}) as Record<string, any>;
      return {
        enabled: settings.auto_reply_enabled || false,
        tone: settings.auto_reply_tone || "friendly",
        maxRepliesPerHour: settings.auto_reply_max_per_hour || 20,
        excludeSentiments: settings.auto_reply_exclude_sentiments || [],
        customInstructions: settings.auto_reply_instructions || "",
      };
    }),

  updateAutoReplySettings: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        enabled: z.boolean(),
        tone: z.enum(["friendly", "professional", "casual", "witty", "empathetic"]).optional(),
        maxRepliesPerHour: z.number().min(1).max(100).optional(),
        excludeSentiments: z.array(z.string()).optional(),
        customInstructions: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Get current settings
      const { data: brand } = await db
        .from("brands")
        .select("settings")
        .eq("id", input.brandId)
        .single();

      const currentSettings = (brand?.settings || {}) as Record<string, any>;
      const updatedSettings = {
        ...currentSettings,
        auto_reply_enabled: input.enabled,
        ...(input.tone !== undefined && { auto_reply_tone: input.tone }),
        ...(input.maxRepliesPerHour !== undefined && { auto_reply_max_per_hour: input.maxRepliesPerHour }),
        ...(input.excludeSentiments !== undefined && { auto_reply_exclude_sentiments: input.excludeSentiments }),
        ...(input.customInstructions !== undefined && { auto_reply_instructions: input.customInstructions }),
      };

      const { error } = await db
        .from("brands")
        .update({ settings: updatedSettings })
        .eq("id", input.brandId);

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return { success: true, settings: updatedSettings };
    }),

  // ━━━ Generate AI Reply ━━━
  generateReply: protectedProcedure
    .input(
      z.object({
        commentId: z.string().uuid(),
        tone: z.string().optional(),
        customInstructions: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Fetch comment with linked data
      const { data: comment, error } = await db
        .from("platform_comments")
        .select("id, brand_id, platform, comment_text, author_username, sentiment, post_id, social_account_id")
        .eq("id", input.commentId)
        .single();

      if (error || !comment)
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });

      assertBrandAccess(profile, comment.brand_id);

      // Get brand name
      const { data: brand } = await db
        .from("brands")
        .select("name, org_id, settings")
        .eq("id", comment.brand_id)
        .single();

      if (!brand)
        throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });

      // Get post caption if linked
      let postCaption: string | undefined;
      if (comment.post_id) {
        const { data: post } = await db
          .from("content_posts")
          .select("group_id")
          .eq("id", comment.post_id)
          .single();
        if (post?.group_id) {
          const { data: group } = await db
            .from("media_groups")
            .select("caption")
            .eq("id", post.group_id)
            .single();
          postCaption = group?.caption || undefined;
        }
      }

      const settings = (brand.settings || {}) as Record<string, any>;

      const generatedText = await generateCommentReply({
        comment: {
          text: comment.comment_text,
          author: comment.author_username,
          platform: comment.platform,
          sentiment: comment.sentiment,
        },
        postCaption,
        brandName: brand.name,
        tone: input.tone || settings.auto_reply_tone || "friendly",
        customInstructions: input.customInstructions || settings.auto_reply_instructions || undefined,
        userId: profile.id,
        orgId: brand.org_id,
        brandId: comment.brand_id,
      });

      return { generatedText };
    }),

  // ━━━ Trigger Manual Comment Sync ━━━
  syncComments: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { getCommentSyncQueue } = await import("@/server/queue/queues");
      const syncQueue = getCommentSyncQueue();

      await syncQueue.add("sync-brand", { brandId: input.brandId }, { jobId: `sync-${input.brandId}-${Date.now()}` });

      return { queued: true, message: "Comment sync started" };
    }),
});
