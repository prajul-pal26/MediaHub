import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { chatCompletion } from "@/lib/llm";

// ─── Helpers ───

async function resolveAccountPlatforms(db: any, rows: any[]): Promise<Record<string, string>> {
  const accountIds = [...new Set(rows.map((r: any) => r.social_account_id).filter(Boolean))];
  if (accountIds.length === 0) return {};

  const { data: accounts } = await db
    .from("social_accounts")
    .select("id, platform")
    .in("id", accountIds);

  const map: Record<string, string> = {};
  for (const acc of accounts || []) {
    map[acc.id] = acc.platform;
  }
  return map;
}

function buildPlatformComparison(rows: any[], accountPlatforms: Record<string, string>) {
  const platMap: Record<string, { views: number; likes: number; comments: number; shares: number; impressions: number; posts: Set<string> }> = {};

  for (const h of rows) {
    const platform = accountPlatforms[h.social_account_id] || "unknown";
    if (!platMap[platform]) platMap[platform] = { views: 0, likes: 0, comments: 0, shares: 0, impressions: 0, posts: new Set() };
    const p = platMap[platform];
    p.views += h.views || 0;
    p.likes += h.likes || 0;
    p.comments += h.comments || 0;
    p.shares += h.shares || 0;
    p.impressions += h.impressions || 0;
    p.posts.add(h.post_id);
  }

  return Object.entries(platMap).map(([platform, data]) => ({
    platform,
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    impressions: data.impressions,
    posts: data.posts.size,
    engagement: data.views > 0 ? Math.round((data.likes + data.comments + data.shares) / data.views * 10000) / 100 : 0,
  }));
}

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

      // Check cache: return existing prediction if less than 7 days old and group unchanged
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: cached } = await db
        .from("performance_predictions")
        .select("*")
        .eq("group_id", input.groupId)
        .eq("platform", input.platform)
        .eq("action", input.action)
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cached) {
        return { ...cached, cached: true };
      }

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
        maxTokens: 1024,
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

  getBrandSentiment: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data: sentiments } = await db
        .from("comment_sentiments")
        .select("*, content_posts(id, group_id, media_groups:group_id(title, caption))")
        .eq("brand_id", input.brandId)
        .order("analyzed_at", { ascending: false });

      if (!sentiments || sentiments.length === 0) {
        return {
          overall: { positive: 0, negative: 0, neutral: 0 },
          purchaseIntentCount: 0,
          questionsNeedingResponse: 0,
          posts: [],
          topThemes: { positive: [] as string[], negative: [] as string[] },
        };
      }

      // Aggregate across all posts
      let totalPositive = 0, totalNegative = 0, totalNeutral = 0;
      let purchaseIntent = 0, questions = 0;
      const posThemes: Record<string, number> = {};
      const negThemes: Record<string, number> = {};
      const posts: any[] = [];

      for (const s of sentiments) {
        totalPositive += s.positive_count || 0;
        totalNegative += s.negative_count || 0;
        totalNeutral += s.neutral_count || 0;
        purchaseIntent += s.purchase_intent_signals || 0;
        questions += s.questions_count || 0;

        for (const t of (s.top_positive_themes as string[]) || []) {
          posThemes[t] = (posThemes[t] || 0) + 1;
        }
        for (const t of (s.top_negative_themes as string[]) || []) {
          negThemes[t] = (negThemes[t] || 0) + 1;
        }

        const post = s.content_posts as any;
        const group = post?.media_groups;
        posts.push({
          postId: s.post_id,
          title: group?.title || group?.caption?.slice(0, 60) || "Untitled post",
          positive: s.positive_count || 0,
          negative: s.negative_count || 0,
          neutral: s.neutral_count || 0,
          summary: s.summary,
        });
      }

      return {
        overall: { positive: totalPositive, negative: totalNegative, neutral: totalNeutral },
        purchaseIntentCount: purchaseIntent,
        questionsNeedingResponse: questions,
        posts,
        topThemes: {
          positive: Object.entries(posThemes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t),
          negative: Object.entries(negThemes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t),
        },
      };
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

      // Map DB column names to what the UI expects
      return (data || []).map((d: any) => ({
        ...d,
        handle: d.competitor_handle,
        post_count: d.posts_count,
        avg_engagement: d.avg_engagement_rate,
        last_updated: d.fetched_at,
      }));
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

      // postId may be a publish_job id (from per-job analytics view) or a content_post id
      const { data: job } = await db
        .from("publish_jobs")
        .select("id, post_id, content_posts(brand_id)")
        .eq("id", input.postId)
        .maybeSingle();

      let brandId: string;
      let contentPostId: string;
      let deleteJobOnly = false;

      if (job) {
        // It's a publish_job id — delete just this job + its analytics
        brandId = (job.content_posts as any).brand_id;
        contentPostId = job.post_id;
        deleteJobOnly = true;
      } else {
        // It's a content_post id — delete the entire post
        const { data: post } = await db
          .from("content_posts")
          .select("id, brand_id")
          .eq("id", input.postId)
          .single();
        if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
        brandId = post.brand_id;
        contentPostId = post.id;
      }

      assertBrandAccess(profile, brandId);

      if (!["super_admin", "agency_admin", "brand_owner"].includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only brand owners and admins can delete published content" });
      }

      if (deleteJobOnly) {
        // Delete just this job's analytics and the job itself
        await db.from("post_analytics").delete().eq("publish_job_id", input.postId);
        await db.from("post_analytics_history").delete().eq("publish_job_id", input.postId);
        await db.from("publish_jobs").delete().eq("id", input.postId);

        // If no more jobs remain for this post, delete the content_post too
        const { data: remaining } = await db.from("publish_jobs").select("id").eq("post_id", contentPostId);
        if (!remaining || remaining.length === 0) {
          await db.from("post_analytics").delete().eq("post_id", contentPostId);
          await db.from("content_posts").delete().eq("id", contentPostId);
        }
      } else {
        // Delete entire post with all jobs and analytics
        await db.from("post_analytics").delete().eq("post_id", contentPostId);
        await db.from("publish_jobs").delete().eq("post_id", contentPostId);
        await db.from("content_posts").delete().eq("id", contentPostId);
      }

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

      // Query publish_jobs directly (one row per job = one row in analytics)
      // Exclude stories — ephemeral content with no lasting analytics
      let jobQuery = db
        .from("publish_jobs")
        .select(`
          id, post_id, action, platform_post_id, social_account_id, status, completed_at,
          content_posts!inner(id, group_id, status, published_at, source, caption_overrides, brand_id)
        `, { count: "exact" })
        .eq("content_posts.brand_id", input.brandId)
        .in("content_posts.status", ["published", "partial_published"])
        .eq("status", "completed")
        .not("action", "like", "%_story")
        .order("completed_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + input.limit - 1);

      if (input.platform) {
        jobQuery = jobQuery.ilike("action", `${input.platform}%`);
      }

      const { data: jobs, error, count } = await jobQuery;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      const contentTypeMap: Record<string, string> = {
        ig_post: "Image Post", ig_reel: "Reel", ig_story: "Story", ig_carousel: "Carousel",
        yt_video: "Video", yt_short: "Short",
        li_post: "Post", li_article: "Article",
        fb_post: "Post", fb_reel: "Reel", fb_story: "Story",
        tt_video: "Video", tw_post: "Post", sc_story: "Story",
      };

      // Batch-fetch all needed social accounts
      const accountIds = [...new Set((jobs || []).map((j: any) => j.social_account_id).filter(Boolean))];
      let accountMap: Record<string, any> = {};
      if (accountIds.length > 0) {
        const { data: accs } = await db
          .from("social_accounts")
          .select("id, platform, platform_username")
          .in("id", accountIds);
        for (const a of accs || []) accountMap[a.id] = a;
      }

      // Batch-fetch all needed media groups
      const groupIds = [...new Set((jobs || []).map((j: any) => j.content_posts?.group_id).filter(Boolean))];
      let groupMap: Record<string, any> = {};
      if (groupIds.length > 0) {
        const { data: groups } = await db
          .from("media_groups")
          .select("id, title, caption")
          .in("id", groupIds);
        for (const g of groups || []) groupMap[g.id] = g;
      }

      const results = [];
      for (const job of jobs || []) {
        const post = job.content_posts as any;
        const account = accountMap[job.social_account_id] || {};

        // Get analytics for this specific publish_job
        const { data: analyticsRow } = await db
          .from("post_analytics")
          .select("*")
          .eq("publish_job_id", job.id)
          .maybeSingle();

        // Fallback: try by post_id + social_account_id for legacy rows
        let a = analyticsRow;
        if (!a) {
          const { data: legacyRow } = await db
            .from("post_analytics")
            .select("*")
            .eq("post_id", post.id)
            .eq("social_account_id", job.social_account_id)
            .is("publish_job_id", null)
            .maybeSingle();
          a = legacyRow;
        }

        // Determine title — prefer caption over title for display
        const overrides = post.caption_overrides || {};
        const group = post.group_id ? groupMap[post.group_id] : null;

        // Priority: action-specific caption > media group caption > caption override > media group title > "Untitled"
        const actionCaption = overrides[`${job.action}_${job.social_account_id}_caption`];
        let title = actionCaption
          || group?.caption?.slice(0, 80)
          || overrides.caption?.slice(0, 80)
          || group?.title
          || "Untitled";

        // Permalink
        let permalink = overrides.permalink || overrides[`${job.action}_${job.social_account_id}_permalink`] || "";
        if (!permalink && a?.platform_specific?.permalink) permalink = a.platform_specific.permalink;

        const views = a?.views || 0;
        const likes = a?.likes || 0;
        const comments = a?.comments || 0;
        const shares = a?.shares || 0;

        results.push({
          id: job.id, // Use publish_job id as unique row id
          post_id: post.id,
          title,
          permalink,
          source: post.source,
          published_at: post.published_at || job.completed_at,
          platform: account.platform || "unknown",
          account_name: account.platform_username || "Unknown",
          action: job.action,
          content_type: contentTypeMap[job.action] || job.action,
          views,
          likes,
          comments,
          shares,
          saves: a?.saves || 0,
          reach: a?.reach || 0,
          impressions: a?.impressions || 0,
          clicks: a?.clicks || 0,
          retention_rate: a?.retention_rate || 0,
          watch_time_seconds: a?.watch_time_seconds || 0,
          engagement_rate: views > 0
            ? Math.round(((likes + comments + shares) / views) * 10000) / 100
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

  // ━━━ Best Posting Times ━━━

  getBestPostingTimes: protectedProcedure
    .input(z.object({ brandId: z.string().uuid(), platform: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      let query = db
        .from("trend_snapshots")
        .select("platform, best_posting_times, weekly_plan, snapshot_date")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false });

      if (input.platform) {
        query = query.eq("platform", input.platform);
      }

      const { data, error } = await query.limit(10);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Deduplicate: keep latest per platform
      const seen = new Set<string>();
      const results = (data || []).filter((s: any) => {
        if (seen.has(s.platform)) return false;
        seen.add(s.platform);
        return true;
      }).map((s: any) => ({
        platform: s.platform,
        bestPostingTimes: s.best_posting_times || [],
        weeklyPlan: s.weekly_plan || [],
        snapshotDate: s.snapshot_date,
      }));

      // Also include draft media that could be published
      const { data: draftMedia } = await db
        .from("media_groups")
        .select("id, title, caption, status, variant_count")
        .eq("brand_id", input.brandId)
        .in("status", ["available", "draft"])
        .order("created_at", { ascending: false })
        .limit(10);

      return {
        platforms: results,
        draftMedia: (draftMedia || []).map((m: any) => ({
          id: m.id,
          title: m.title || m.caption?.slice(0, 60) || "Untitled",
          variants: m.variant_count || 0,
        })),
      };
    }),

  // ━━━ Post Progress (time-series for growth charts) ━━━

  getPostProgress: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // postId is now a publish_job_id — look up the content_post through it
      const { data: job } = await db
        .from("publish_jobs")
        .select("id, post_id, content_posts(brand_id, published_at)")
        .eq("id", input.postId)
        .single();

      // Fallback: try as content_post id (for legacy/imported data)
      let brandId: string;
      let publishJobId: string | null = null;
      let contentPostId: string;

      if (job) {
        const post = job.content_posts as any;
        brandId = post.brand_id;
        publishJobId = job.id;
        contentPostId = job.post_id;
      } else {
        const { data: post } = await db
          .from("content_posts")
          .select("id, brand_id")
          .eq("id", input.postId)
          .single();
        if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
        brandId = post.brand_id;
        contentPostId = post.id;
      }

      assertBrandAccess(profile, brandId);

      // Get history — prefer by publish_job_id, fallback to post_id
      let historyQuery = db
        .from("post_analytics_history")
        .select("views, likes, comments, shares, saves, reach, impressions, engagement_rate, retention_rate, snapshot_at")
        .order("snapshot_at", { ascending: true });

      if (publishJobId) {
        historyQuery = historyQuery.eq("publish_job_id", publishJobId);
      } else {
        historyQuery = historyQuery.eq("post_id", contentPostId);
      }

      const { data: history, error } = await historyQuery;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Get latest analytics
      let latestQuery = db
        .from("post_analytics")
        .select("views, likes, comments, shares, saves, reach, impressions, engagement_rate, retention_rate, fetched_at")
        .limit(1);

      if (publishJobId) {
        latestQuery = latestQuery.eq("publish_job_id", publishJobId);
      } else {
        latestQuery = latestQuery.eq("post_id", contentPostId);
      }

      const { data: latest } = await latestQuery.single();

      const snapshots = (history || []).map((h: any) => ({
        ...h,
        timestamp: h.snapshot_at,
      }));

      // Calculate growth rates (latest vs first snapshot)
      let growth = null;
      if (snapshots.length >= 2) {
        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        growth = {
          views: first.views > 0 ? Math.round((last.views - first.views) / first.views * 100) : last.views > 0 ? 100 : 0,
          likes: first.likes > 0 ? Math.round((last.likes - first.likes) / first.likes * 100) : last.likes > 0 ? 100 : 0,
          comments: first.comments > 0 ? Math.round((last.comments - first.comments) / first.comments * 100) : last.comments > 0 ? 100 : 0,
          shares: first.shares > 0 ? Math.round((last.shares - first.shares) / first.shares * 100) : last.shares > 0 ? 100 : 0,
        };
      }

      return {
        snapshots,
        latest: latest || null,
        publishedAt: post.published_at,
        totalSnapshots: snapshots.length,
        growth,
      };
    }),

  // ━━━ Analytics Time Series (for overview charts) ━━━

  getAnalyticsTimeSeries: protectedProcedure
    .input(z.object({
      brandId: z.string().uuid(),
      period: z.enum(["7d", "30d", "90d"]).default("30d"),
    }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const days = input.period === "7d" ? 7 : input.period === "30d" ? 30 : 90;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // Use RPC to get history with JOINs (avoids 414 URI Too Long)
      const { data: history } = await db.rpc("get_brand_analytics_history", {
        p_brand_id: input.brandId,
        p_since: since,
      });

      if (!history || history.length === 0) {
        // Fall back to current analytics via RPC
        const { data: currentAnalytics } = await db.rpc("get_brand_analytics", { p_brand_id: input.brandId });
        const rows = (currentAnalytics || []) as any[];
        const accountPlatforms: Record<string, string> = {};
        for (const r of rows) accountPlatforms[r.social_account_id] = r.platform || "unknown";
        const platComp = buildPlatformComparison(rows, accountPlatforms);
        return { daily: [], platformComparison: platComp, topPosts: [] };
      }

      // Platform already resolved by RPC — build lookup map
      const accountPlatforms: Record<string, string> = {};
      for (const h of history) accountPlatforms[h.social_account_id] = h.platform || "unknown";

      // 1. Daily aggregate time series (all platforms combined + per platform)
      const dailyMap: Record<string, Record<string, { views: number; likes: number; comments: number; shares: number; impressions: number; count: number }>> = {};

      for (const h of history) {
        const date = h.snapshot_at.slice(0, 10); // YYYY-MM-DD
        const platform = accountPlatforms[h.social_account_id] || "unknown";

        if (!dailyMap[date]) dailyMap[date] = {};
        if (!dailyMap[date]["all"]) dailyMap[date]["all"] = { views: 0, likes: 0, comments: 0, shares: 0, impressions: 0, count: 0 };
        if (!dailyMap[date][platform]) dailyMap[date][platform] = { views: 0, likes: 0, comments: 0, shares: 0, impressions: 0, count: 0 };

        // Use max per post per day (since each snapshot replaces previous, we want the day's peak)
        dailyMap[date]["all"].views += h.views || 0;
        dailyMap[date]["all"].likes += h.likes || 0;
        dailyMap[date]["all"].comments += h.comments || 0;
        dailyMap[date]["all"].shares += h.shares || 0;
        dailyMap[date]["all"].impressions += h.impressions || 0;
        dailyMap[date]["all"].count++;

        dailyMap[date][platform].views += h.views || 0;
        dailyMap[date][platform].likes += h.likes || 0;
        dailyMap[date][platform].comments += h.comments || 0;
        dailyMap[date][platform].shares += h.shares || 0;
        dailyMap[date][platform].impressions += h.impressions || 0;
        dailyMap[date][platform].count++;
      }

      // Deduplicate: take latest snapshot per post per day
      const daily = Object.entries(dailyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, platforms]) => ({
          date,
          ...Object.fromEntries(
            Object.entries(platforms).map(([platform, data]) => [
              platform,
              {
                views: data.views,
                likes: data.likes,
                comments: data.comments,
                shares: data.shares,
                impressions: data.impressions,
                engagement: data.views > 0 ? Math.round((data.likes + data.comments + data.shares) / data.views * 10000) / 100 : 0,
              },
            ])
          ),
        }));

      // 2. Platform comparison (totals per platform from latest snapshot)
      const platComp = buildPlatformComparison(history, accountPlatforms);

      // 3. Top performing posts
      const postTotals: Record<string, { views: number; likes: number; comments: number; shares: number; postId: string }> = {};
      for (const h of history) {
        if (!postTotals[h.post_id]) postTotals[h.post_id] = { views: 0, likes: 0, comments: 0, shares: 0, postId: h.post_id };
        // Use max values (latest snapshot has cumulative data)
        const p = postTotals[h.post_id];
        if (h.views > p.views) p.views = h.views;
        if (h.likes > p.likes) p.likes = h.likes;
        if (h.comments > p.comments) p.comments = h.comments;
        if (h.shares > p.shares) p.shares = h.shares;
      }

      const topPostIds = Object.values(postTotals)
        .sort((a, b) => b.views - a.views)
        .slice(0, 5);

      // Get post titles
      const topIds = topPostIds.map(p => p.postId);
      let topPosts: any[] = [];
      if (topIds.length > 0) {
        const { data: posts } = await db
          .from("content_posts")
          .select("id, group_id, media_groups:group_id(title, caption)")
          .in("id", topIds);

        topPosts = topPostIds.map(tp => {
          const post = (posts || []).find((p: any) => p.id === tp.postId);
          const group = (post as any)?.media_groups;
          return {
            ...tp,
            title: group?.title || group?.caption?.slice(0, 50) || "Untitled",
            platform: accountPlatforms[history.find((h: any) => h.post_id === tp.postId)?.social_account_id || ""] || "unknown",
          };
        });
      }

      return { daily, platformComparison: platComp, topPosts };
    }),

  // ━━━ Manual Analytics Refresh ━━━

  refreshAnalytics: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { Queue } = await import("bullmq");
      const { getQueueConnection } = await import("@/server/queue/connection");
      const analyticsQueue = new Queue("analytics-fetch", { connection: getQueueConnection() });

      await analyticsQueue.add("manual-refresh", { brandId: input.brandId }, {
        jobId: `analytics-manual-${input.brandId}-${Date.now()}`,
      });

      return { queued: true, message: "Analytics refresh started. Data will update shortly." };
    }),

  // ━━━ Trigger Trend Forecast (manual refresh) ━━━

  refreshTrendForecast: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { Queue } = await import("bullmq");
      const { getQueueConnection } = await import("@/server/queue/connection");
      const trendQueue = new Queue("trend-forecast", { connection: getQueueConnection() });

      await trendQueue.add("forecast-brand", { brandId: input.brandId }, {
        jobId: `forecast-${input.brandId}-${Date.now()}`,
      });

      return { queued: true, message: "Trend forecast started. Results will appear in a few seconds." };
    }),

  // ━━━ Analytics Summary (for overview page) ━━━

  getSummary: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Use RPC function to do the JOIN server-side (avoids 414 URI Too Long)
      const { data: all } = await db.rpc("get_brand_analytics", { p_brand_id: input.brandId });
      const rows = (all || []) as any[];

      // Group by platform
      const platformMap: Record<string, any[]> = {};
      for (const a of rows) {
        const platform = a.platform || "unknown";
        if (!platformMap[platform]) platformMap[platform] = [];
        platformMap[platform].push(a);
      }

      function aggregate(items: any[]) {
        // Only posts with retention_rate > 0 count for retention avg (YouTube only)
        const retentionItems = items.filter(a => (a.retention_rate || 0) > 0);
        // Only posts with views > 0 count for engagement avg
        const engageableItems = items.filter(a => (a.views || 0) > 0);

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
          retention_rate: retentionItems.length > 0
            ? Math.round(retentionItems.reduce((s, a) => s + a.retention_rate, 0) / retentionItems.length * 100) / 100
            : 0,
          watch_time_seconds: items.reduce((s, a) => s + (a.watch_time_seconds || 0), 0),
          engagement: engageableItems.length > 0
            ? Math.round(engageableItems.reduce((s, a) => {
                return s + ((a.likes || 0) + (a.comments || 0) + (a.shares || 0)) / a.views;
              }, 0) / engageableItems.length * 10000) / 100
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

  // ━━━ Export Data (aggregated for CSV/PDF) ━━━

  getExportData: protectedProcedure
    .input(z.object({
      brandId: z.string().uuid(),
      period: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
    }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const days = input.period === "7d" ? 7 : input.period === "30d" ? 30 : input.period === "90d" ? 90 : 365 * 10;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // Brand info
      const { data: brand } = await db.from("brands").select("name").eq("id", input.brandId).single();

      // Published posts with analytics
      const { data: posts } = await db
        .from("content_posts")
        .select("id, group_id, published_at, source, status")
        .eq("brand_id", input.brandId)
        .eq("status", "published")
        .gte("published_at", since)
        .order("published_at", { ascending: false });

      const postIds = (posts || []).map((p: any) => p.id);

      // Analytics
      let analytics: any[] = [];
      if (postIds.length > 0) {
        const { data } = await db.from("post_analytics")
          .select("post_id, social_account_id, views, likes, comments, shares, saves, reach, impressions, clicks, engagement_rate, retention_rate, watch_time_seconds, fetched_at")
          .in("post_id", postIds);
        analytics = data || [];
      }

      // Resolve platforms + account names
      const accountIds = [...new Set(analytics.map((a: any) => a.social_account_id).filter(Boolean))];
      let accounts: any[] = [];
      if (accountIds.length > 0) {
        const { data } = await db.from("social_accounts").select("id, platform, platform_username").in("id", accountIds);
        accounts = data || [];
      }
      const accountMap: Record<string, any> = {};
      for (const a of accounts) accountMap[a.id] = a;

      // Media group titles
      const groupIds = [...new Set((posts || []).map((p: any) => p.group_id).filter(Boolean))];
      let groups: any[] = [];
      if (groupIds.length > 0) {
        const { data } = await db.from("media_groups").select("id, title, caption").in("id", groupIds);
        groups = data || [];
      }
      const groupMap: Record<string, any> = {};
      for (const g of groups) groupMap[g.id] = g;

      // Publish jobs for content type
      let jobs: any[] = [];
      if (postIds.length > 0) {
        const { data } = await db.from("publish_jobs").select("post_id, action, social_account_id").in("post_id", postIds).eq("status", "completed");
        jobs = data || [];
      }
      const jobMap: Record<string, any> = {};
      for (const j of jobs) jobMap[`${j.post_id}_${j.social_account_id}`] = j;

      // Sentiment data
      let sentiments: any[] = [];
      if (postIds.length > 0) {
        const { data } = await db.from("comment_sentiments")
          .select("post_id, overall_sentiment, sentiment_score, positive_count, negative_count, neutral_count, summary")
          .in("post_id", postIds);
        sentiments = data || [];
      }
      const sentimentMap: Record<string, any> = {};
      for (const s of sentiments) sentimentMap[s.post_id] = s;

      // Build export rows
      const rows = analytics.map((a: any) => {
        const post = (posts || []).find((p: any) => p.id === a.post_id);
        const account = accountMap[a.social_account_id];
        const group = post?.group_id ? groupMap[post.group_id] : null;
        const job = jobMap[`${a.post_id}_${a.social_account_id}`];
        const sentiment = sentimentMap[a.post_id];

        return {
          title: group?.title || group?.caption?.slice(0, 60) || "Untitled",
          platform: account?.platform || "unknown",
          account: account?.platform_username || "—",
          contentType: job?.action || "—",
          publishedAt: post?.published_at || "—",
          source: post?.source || "—",
          views: a.views || 0,
          impressions: a.impressions || 0,
          likes: a.likes || 0,
          comments: a.comments || 0,
          shares: a.shares || 0,
          saves: a.saves || 0,
          reach: a.reach || 0,
          clicks: a.clicks || 0,
          engagementRate: a.engagement_rate || 0,
          retentionRate: a.retention_rate || 0,
          watchTimeSeconds: a.watch_time_seconds || 0,
          sentiment: sentiment?.overall_sentiment || "—",
          sentimentScore: sentiment?.sentiment_score || 0,
          sentimentSummary: sentiment?.summary || "",
          fetchedAt: a.fetched_at || "—",
        };
      });

      // Aggregate totals
      const totals = {
        posts: rows.length,
        views: rows.reduce((s, r) => s + r.views, 0),
        likes: rows.reduce((s, r) => s + r.likes, 0),
        comments: rows.reduce((s, r) => s + r.comments, 0),
        shares: rows.reduce((s, r) => s + r.shares, 0),
        saves: rows.reduce((s, r) => s + r.saves, 0),
        reach: rows.reduce((s, r) => s + r.reach, 0),
        impressions: rows.reduce((s, r) => s + r.impressions, 0),
        clicks: rows.reduce((s, r) => s + r.clicks, 0),
      };

      // Per-platform totals
      const platformTotals: Record<string, any> = {};
      for (const r of rows) {
        if (!platformTotals[r.platform]) platformTotals[r.platform] = { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, impressions: 0 };
        const p = platformTotals[r.platform];
        p.posts++; p.views += r.views; p.likes += r.likes; p.comments += r.comments; p.shares += r.shares; p.impressions += r.impressions;
      }

      return {
        brandName: brand?.name || "Unknown Brand",
        period: input.period,
        generatedAt: new Date().toISOString(),
        rows,
        totals,
        platformTotals,
      };
    }),
});
