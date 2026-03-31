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
});
