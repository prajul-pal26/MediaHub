import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { chatCompletion } from "@/lib/llm";

// ─── Analytics Router ───

export const analyticsRouter = router({
  // ━━━ Category Breakdown ━━━

  getCategoryBreakdown: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        period: z.enum(["7d", "30d", "90d"]).default("30d"),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const periodDays = input.period === "7d" ? 7 : input.period === "90d" ? 90 : 30;
      const since = new Date();
      since.setDate(since.getDate() - periodDays);
      const prevSince = new Date();
      prevSince.setDate(prevSince.getDate() - periodDays * 2);

      // Get categories with post analytics for the current period
      const { data: categories, error } = await db
        .from("content_categories")
        .select("primary_category, group_id, predicted_engagement_score, created_at")
        .eq("brand_id", input.brandId)
        .gte("created_at", since.toISOString());

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Get analytics for the groups in these categories
      const groupIds = [...new Set((categories || []).map((c: any) => c.group_id))];

      let analyticsMap: Record<string, any[]> = {};
      if (groupIds.length > 0) {
        const { data: posts } = await db
          .from("content_posts")
          .select("id, group_id")
          .in("group_id", groupIds);

        const postIds = (posts || []).map((p: any) => p.id);
        const postToGroup: Record<string, string> = {};
        for (const p of posts || []) {
          postToGroup[p.id] = p.group_id;
        }

        if (postIds.length > 0) {
          const { data: analytics } = await db
            .from("post_analytics")
            .select("post_id, views, likes, comments, shares, engagement_rate")
            .in("post_id", postIds);

          for (const a of analytics || []) {
            const gid = postToGroup[a.post_id];
            if (!analyticsMap[gid]) analyticsMap[gid] = [];
            analyticsMap[gid].push(a);
          }
        }
      }

      // Get previous period categories for trend calculation
      const { data: prevCategories } = await db
        .from("content_categories")
        .select("primary_category, group_id")
        .eq("brand_id", input.brandId)
        .gte("created_at", prevSince.toISOString())
        .lt("created_at", since.toISOString());

      const prevCounts: Record<string, number> = {};
      for (const c of prevCategories || []) {
        prevCounts[c.primary_category] = (prevCounts[c.primary_category] || 0) + 1;
      }

      // Aggregate by category
      const catMap: Record<string, { postCount: number; totalViews: number; totalEngagement: number; totalShares: number; analyticsCount: number }> = {};
      for (const cat of categories || []) {
        if (!catMap[cat.primary_category]) {
          catMap[cat.primary_category] = { postCount: 0, totalViews: 0, totalEngagement: 0, totalShares: 0, analyticsCount: 0 };
        }
        const entry = catMap[cat.primary_category];
        entry.postCount++;
        const groupAnalytics = analyticsMap[cat.group_id] || [];
        for (const a of groupAnalytics) {
          entry.totalViews += a.views || 0;
          entry.totalEngagement += a.engagement_rate || 0;
          entry.totalShares += a.shares || 0;
          entry.analyticsCount++;
        }
      }

      return Object.entries(catMap).map(([category, data]) => ({
        category,
        post_count: data.postCount,
        avg_views: data.analyticsCount > 0 ? Math.round(data.totalViews / data.analyticsCount) : 0,
        avg_engagement: data.analyticsCount > 0 ? Math.round((data.totalEngagement / data.analyticsCount) * 100) / 100 : 0,
        avg_shares: data.analyticsCount > 0 ? Math.round(data.totalShares / data.analyticsCount) : 0,
        trend: prevCounts[category]
          ? Math.round(((data.postCount - prevCounts[category]) / prevCounts[category]) * 100)
          : null,
      }));
    }),

  // ━━━ Performance Prediction ━━━

  getPrediction: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        platform: z.string(),
        action: z.string(),
        scheduledAt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get group and verify brand access
      const { data: group, error: groupErr } = await db
        .from("media_groups")
        .select("id, brand_id, title, caption, description, tags")
        .eq("id", input.groupId)
        .single();

      if (groupErr || !group)
        throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });

      assertBrandAccess(profile, group.brand_id);

      // Get content category for this group
      const { data: category } = await db
        .from("content_categories")
        .select("primary_category, secondary_category, tone, topics")
        .eq("group_id", input.groupId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      // Get historical data: average views by action for this brand
      const { data: historicalPosts } = await db
        .from("content_posts")
        .select("id, scheduled_at, published_at")
        .eq("brand_id", group.brand_id)
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(50);

      const postIds = (historicalPosts || []).map((p: any) => p.id);
      let avgViews = 0;
      let avgEngagement = 0;
      let recentPosts: any[] = [];

      if (postIds.length > 0) {
        const { data: analytics } = await db
          .from("post_analytics")
          .select("post_id, views, engagement_rate")
          .in("post_id", postIds);

        if (analytics && analytics.length > 0) {
          avgViews = Math.round(analytics.reduce((s: number, a: any) => s + (a.views || 0), 0) / analytics.length);
          avgEngagement = Math.round(analytics.reduce((s: number, a: any) => s + (a.engagement_rate || 0), 0) / analytics.length * 100) / 100;
        }

        // Last 5 similar posts (by action via publish_jobs)
        const { data: similarJobs } = await db
          .from("publish_jobs")
          .select("post_id, action")
          .in("post_id", postIds)
          .eq("action", input.action)
          .limit(5);

        if (similarJobs && similarJobs.length > 0) {
          const similarPostIds = similarJobs.map((j: any) => j.post_id);
          const { data: similarAnalytics } = await db
            .from("post_analytics")
            .select("post_id, views, likes, comments, shares, engagement_rate")
            .in("post_id", similarPostIds);

          recentPosts = (similarAnalytics || []).map((a: any) => ({
            views: a.views,
            likes: a.likes,
            comments: a.comments,
            shares: a.shares,
            engagement_rate: a.engagement_rate,
          }));
        }
      }

      const systemPrompt = `You are a social media performance prediction AI. Analyze the content details and historical performance data to predict how this post will perform. Return a JSON object with these fields:
- predicted_views_min (integer)
- predicted_views_max (integer)
- predicted_engagement_rate (float, 0-100)
- predicted_best_time (ISO timestamp, best time to post)
- confidence_score (float, 0-1)
- reasoning (string, 2-3 sentences explaining your prediction)
- suggestions (array of strings, 3-5 actionable improvement suggestions)

Respond ONLY with valid JSON, no markdown.`;

      const userMessage = `Content: "${group.title}"
Caption: "${group.caption || "N/A"}"
Tags: ${(group.tags || []).join(", ") || "none"}
Platform: ${input.platform}
Action: ${input.action}
Scheduled at: ${input.scheduledAt || "not set"}
Category: ${category?.primary_category || "uncategorized"}
Tone: ${category?.tone || "unknown"}
Topics: ${(category?.topics || []).join(", ") || "none"}
Historical avg views: ${avgViews}
Historical avg engagement: ${avgEngagement}%
Last 5 similar posts: ${JSON.stringify(recentPosts)}`;

      const result = await chatCompletion({
        systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        userId: profile.id,
        brandId: group.brand_id,
        orgId: profile.org_id,
      });

      const content = result.choices?.[0]?.message?.content || "{}";
      let prediction: any;
      try {
        prediction = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse LLM prediction response" });
      }

      // Save to performance_predictions
      const { data: saved, error: saveErr } = await db
        .from("performance_predictions")
        .insert({
          group_id: input.groupId,
          brand_id: group.brand_id,
          platform: input.platform,
          action: input.action,
          predicted_views_min: prediction.predicted_views_min || null,
          predicted_views_max: prediction.predicted_views_max || null,
          predicted_engagement_rate: prediction.predicted_engagement_rate || null,
          predicted_best_time: prediction.predicted_best_time || null,
          confidence_score: prediction.confidence_score || null,
          reasoning: prediction.reasoning || null,
          suggestions: prediction.suggestions || [],
        })
        .select()
        .single();

      if (saveErr)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: saveErr.message });

      return saved;
    }),

  // ━━━ Trend Forecast ━━━

  getTrendForecast: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Get the most recent snapshot per platform
      const { data, error } = await db
        .from("trend_snapshots")
        .select("*")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false })
        .limit(10);

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Deduplicate: keep only the latest per platform
      const seen = new Set<string>();
      const latest = (data || []).filter((s: any) => {
        if (seen.has(s.platform)) return false;
        seen.add(s.platform);
        return true;
      });

      return latest;
    }),

  // ━━━ Content Recommendations ━━━

  getContentRecommendations: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("trend_snapshots")
        .select("content_recommendations, weekly_plan, platform, snapshot_date")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116")
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || { content_recommendations: [], weekly_plan: [], platform: null, snapshot_date: null };
    }),

  // ━━━ Comment Sentiment ━━━

  getCommentSentiment: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Verify access via the post's brand
      const { data: post } = await db
        .from("content_posts")
        .select("brand_id")
        .eq("id", input.postId)
        .single();

      if (!post)
        throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });

      assertBrandAccess(profile, post.brand_id);

      const { data, error } = await db
        .from("comment_sentiments")
        .select("*")
        .eq("post_id", input.postId)
        .order("analyzed_at", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116")
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || null;
    }),

  // ━━━ Competitors ━━━

  getCompetitors: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("competitor_metrics")
        .select("*")
        .eq("brand_id", input.brandId)
        .order("fetched_at", { ascending: false });

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || [];
    }),

  addCompetitor: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        handle: z.string().min(1),
        platform: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("competitor_metrics")
        .insert({
          brand_id: input.brandId,
          competitor_handle: input.handle,
          platform: input.platform,
          followers: null,
          posts_count: null,
          avg_engagement_rate: null,
          avg_views_recent: null,
        })
        .select()
        .single();

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data;
    }),

  removeCompetitor: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        handle: z.string().min(1),
        platform: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { error } = await db
        .from("competitor_metrics")
        .delete()
        .eq("brand_id", input.brandId)
        .eq("competitor_handle", input.handle)
        .eq("platform", input.platform);

      if (error)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return { success: true };
    }),

  // ━━━ Suggested Calendar ━━━

  getSuggestedCalendar: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("trend_snapshots")
        .select("weekly_plan, platform, snapshot_date")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116")
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || { weekly_plan: [], platform: null, snapshot_date: null };
    }),

  // ━━━ Categorize Content (manual trigger) ━━━

  categorizeContent: protectedProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: group, error: groupErr } = await db
        .from("media_groups")
        .select("id, brand_id, title, caption, description, tags")
        .eq("id", input.groupId)
        .single();

      if (groupErr || !group)
        throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });

      assertBrandAccess(profile, group.brand_id);

      const systemPrompt = `You are a content categorization AI for social media. Analyze the given content and return a JSON object with:
- primary_category (string: one of "educational", "entertainment", "promotional", "behind_the_scenes", "user_generated", "news", "inspirational", "tutorial", "product_showcase", "lifestyle", "other")
- secondary_category (string or null, same options)
- tone (string: one of "professional", "casual", "humorous", "inspirational", "educational", "urgent", "emotional")
- topics (array of strings, 3-5 relevant topic keywords)
- sentiment_score (float -1 to 1, negative to positive)
- predicted_engagement_score (float 0-100, estimated engagement potential)

Respond ONLY with valid JSON, no markdown.`;

      const userMessage = `Title: "${group.title}"
Caption: "${group.caption || "N/A"}"
Description: "${group.description || "N/A"}"
Tags: ${(group.tags || []).join(", ") || "none"}`;

      const result = await chatCompletion({
        systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        userId: profile.id,
        brandId: group.brand_id,
        orgId: profile.org_id,
      });

      const content = result.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse LLM categorization response" });
      }

      // Upsert into content_categories
      const { data: saved, error: saveErr } = await db
        .from("content_categories")
        .upsert(
          {
            group_id: input.groupId,
            brand_id: group.brand_id,
            primary_category: parsed.primary_category || "other",
            secondary_category: parsed.secondary_category || null,
            tone: parsed.tone || null,
            topics: parsed.topics || [],
            sentiment_score: parsed.sentiment_score ?? null,
            predicted_engagement_score: parsed.predicted_engagement_score ?? null,
            analyzed_at: new Date().toISOString(),
          },
          { onConflict: "group_id" }
        )
        .select()
        .single();

      if (saveErr) {
        // If upsert fails (no unique constraint on group_id), do insert
        const { data: inserted, error: insertErr } = await db
          .from("content_categories")
          .insert({
            group_id: input.groupId,
            brand_id: group.brand_id,
            primary_category: parsed.primary_category || "other",
            secondary_category: parsed.secondary_category || null,
            tone: parsed.tone || null,
            topics: parsed.topics || [],
            sentiment_score: parsed.sentiment_score ?? null,
            predicted_engagement_score: parsed.predicted_engagement_score ?? null,
            analyzed_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (insertErr)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: insertErr.message });

        return inserted;
      }

      return saved;
    }),

  // ━━━ Delete Published Post (brand_owner + admins only) ━━━

  deletePost: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get the post and verify access
      const { data: post } = await db
        .from("content_posts")
        .select("id, brand_id, status")
        .eq("id", input.postId)
        .single();

      if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
      assertBrandAccess(profile, post.brand_id);

      // Only brand_owner, agency_admin, super_admin can delete
      if (!["super_admin", "agency_admin", "brand_owner"].includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only brand owners and admins can delete published content" });
      }

      // Delete analytics first, then jobs, then post
      await db.from("post_analytics").delete().eq("post_id", input.postId);
      await db.from("publish_jobs").delete().eq("post_id", input.postId);
      await db.from("content_posts").delete().eq("id", input.postId);

      return { success: true };
    }),

  // ━━━ Post Analytics (individual post stats) ━━━

  getPostAnalytics: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(50).default(20),
        platform: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const offset = (input.page - 1) * input.limit;

      // Get published content_posts with their analytics
      let query = db
        .from("content_posts")
        .select("id, group_id, status, published_at, source, caption_overrides", { count: "exact" })
        .eq("brand_id", input.brandId)
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .range(offset, offset + input.limit - 1);

      const { data: posts, error, count } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // For each post, get publish_jobs + analytics
      const results = [];
      for (const post of posts || []) {
        const { data: jobs } = await db
          .from("publish_jobs")
          .select("id, action, platform_post_id, social_account_id, status")
          .eq("post_id", post.id)
          .eq("status", "completed");

        // Get analytics for this post
        const { data: analytics } = await db
          .from("post_analytics")
          .select("*")
          .eq("post_id", post.id);

        // Get account info
        const accountIds = (jobs || []).map((j: any) => j.social_account_id).filter(Boolean);
        let accounts: any[] = [];
        if (accountIds.length > 0) {
          const { data: accs } = await db
            .from("social_accounts")
            .select("id, platform, platform_username")
            .in("id", accountIds);
          accounts = accs || [];
        }

        // Get media group title if exists
        let title = "Imported post";
        if (post.group_id) {
          const { data: group } = await db
            .from("media_groups")
            .select("title, caption")
            .eq("id", post.group_id)
            .maybeSingle();
          if (group) title = group.title || group.caption?.slice(0, 60) || "Untitled";
        }

        // Aggregate analytics
        const aa = analytics || [];
        const totalViews = aa.reduce((s: number, a: any) => s + (a.views || 0), 0);
        const totalLikes = aa.reduce((s: number, a: any) => s + (a.likes || 0), 0);
        const totalComments = aa.reduce((s: number, a: any) => s + (a.comments || 0), 0);
        const totalShares = aa.reduce((s: number, a: any) => s + (a.shares || 0), 0);
        const totalSaves = aa.reduce((s: number, a: any) => s + (a.saves || 0), 0);
        const totalReach = aa.reduce((s: number, a: any) => s + (a.reach || 0), 0);
        const totalImpressions = aa.reduce((s: number, a: any) => s + (a.impressions || 0), 0);
        const totalClicks = aa.reduce((s: number, a: any) => s + (a.clicks || 0), 0);
        const avgRetention = aa.length > 0 ? Math.round(aa.reduce((s: number, a: any) => s + (a.retention_rate || 0), 0) / aa.length * 100) / 100 : 0;
        const totalWatchTime = aa.reduce((s: number, a: any) => s + (a.watch_time_seconds || 0), 0);

        // Determine content type from action
        const action = (jobs || [])[0]?.action || "unknown";
        const contentTypeMap: Record<string, string> = {
          ig_post: "Image Post",
          ig_reel: "Reel",
          ig_story: "Story",
          ig_carousel: "Carousel",
          yt_video: "Video",
          yt_short: "Short",
          li_post: "Post",
          li_article: "Article",
        };

        results.push({
          id: post.id,
          title,
          source: post.source,
          published_at: post.published_at,
          platform: accounts[0]?.platform || "unknown",
          account_name: accounts[0]?.platform_username || "Unknown",
          action,
          content_type: contentTypeMap[action] || action,
          views: totalViews,
          likes: totalLikes,
          comments: totalComments,
          shares: totalShares,
          saves: totalSaves,
          reach: totalReach,
          impressions: totalImpressions,
          clicks: totalClicks,
          retention_rate: avgRetention,
          watch_time_seconds: totalWatchTime,
          engagement_rate: totalViews > 0
            ? Math.round(((totalLikes + totalComments + totalShares) / totalViews) * 10000) / 100
            : 0,
        });
      }

      return {
        posts: results,
        total: count || 0,
        page: input.page,
        totalPages: Math.ceil((count || 0) / input.limit),
      };
    }),

  // ━━━ Analytics Summary (for overview page) ━━━

  getSummary: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Query analytics through content_posts (brand-scoped, survives social account deletion)
      const { data: brandPosts } = await db
        .from("content_posts")
        .select("id")
        .eq("brand_id", input.brandId)
        .eq("status", "published");

      const brandPostIds = (brandPosts || []).map((p: any) => p.id);
      let all: any[] = [];

      if (brandPostIds.length > 0) {
        const { data: analytics } = await db
          .from("post_analytics")
          .select("post_id, views, likes, comments, shares, saves, reach, impressions, clicks, retention_rate, watch_time_seconds, social_account_id")
          .in("post_id", brandPostIds);
        all = (analytics || []) as any[];
      }

      // Determine platform per analytics row from publish_jobs
      const platformMap: Record<string, any[]> = {};
      for (const a of all) {
        let platform = "unknown";
        if (a.social_account_id) {
          // Try to get platform from social_accounts (may be deleted)
          const { data: acc } = await db
            .from("social_accounts")
            .select("platform")
            .eq("id", a.social_account_id)
            .maybeSingle();
          if (acc) platform = acc.platform;
        }
        if (platform === "unknown" && a.post_id) {
          // Fallback: infer platform from publish_jobs action
          const { data: job } = await db
            .from("publish_jobs")
            .select("action")
            .eq("post_id", a.post_id)
            .limit(1)
            .maybeSingle();
          if (job?.action) {
            if (job.action.startsWith("ig_")) platform = "instagram";
            else if (job.action.startsWith("yt_")) platform = "youtube";
            else if (job.action.startsWith("li_")) platform = "linkedin";
          }
        }
        if (!platformMap[platform]) platformMap[platform] = [];
        platformMap[platform].push(a);
      }

      function aggregate(items: any[]) {
        return {
          posts: items.length,
          views: items.reduce((s, a) => s + (a.views || 0), 0),
          likes: items.reduce((s, a) => s + (a.likes || 0), 0),
          comments: items.reduce((s, a) => s + (a.comments || 0), 0),
          shares: items.reduce((s, a) => s + (a.shares || 0), 0),
          saves: items.reduce((s, a) => s + (a.saves || 0), 0),
          reach: items.reduce((s, a) => s + (a.reach || 0), 0),
          impressions: items.reduce((s, a) => s + (a.impressions || 0), 0),
          clicks: items.reduce((s, a) => s + (a.clicks || 0), 0),
          retention_rate: items.length > 0
            ? Math.round(items.reduce((s, a) => s + (a.retention_rate || 0), 0) / items.length * 100) / 100
            : 0,
          watch_time_seconds: items.reduce((s, a) => s + (a.watch_time_seconds || 0), 0),
          engagement: items.length > 0
            ? Math.round(items.reduce((s, a) => {
                const views = a.views || 1;
                return s + ((a.likes || 0) + (a.comments || 0) + (a.shares || 0)) / views;
              }, 0) / items.length * 10000) / 100
            : 0,
        };
      }

      const total = aggregate(all);
      const byPlatform: Record<string, ReturnType<typeof aggregate>> = {};
      for (const [platform, items] of Object.entries(platformMap)) {
        byPlatform[platform] = aggregate(items);
      }

      return { total, byPlatform };
    }),
});
