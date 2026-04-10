import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { chatCompletion, resolveLlmConfig } from "@/lib/llm";

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
  // Use latest snapshot per post (max values) to avoid summing cumulative snapshots
  const postMax: Record<string, { views: number; likes: number; comments: number; shares: number; platform: string }> = {};
  for (const h of rows) {
    const platform = accountPlatforms[h.social_account_id] || "unknown";
    if (!postMax[h.post_id] || h.views > postMax[h.post_id].views) {
      postMax[h.post_id] = {
        views: h.views || 0,
        likes: h.likes || 0,
        comments: h.comments || 0,
        shares: h.shares || 0,
        platform,
      };
    }
  }

  // Aggregate by platform
  const platMap: Record<string, { views: number; likes: number; comments: number; shares: number; posts: number }> = {};
  for (const p of Object.values(postMax)) {
    if (!platMap[p.platform]) platMap[p.platform] = { views: 0, likes: 0, comments: 0, shares: 0, posts: 0 };
    const pm = platMap[p.platform];
    pm.views += p.views;
    pm.likes += p.likes;
    pm.comments += p.comments;
    pm.shares += p.shares;
    pm.posts++;
  }

  return Object.entries(platMap).map(([platform, data]) => ({
    platform,
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    posts: data.posts,
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
        .in("status", ["published", "partial_published"])
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

  // ━━━ Trend Forecast (fixed field mapping) ━━━

  getTrendForecast: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

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

  // ━━━ Content Recommendations (fixed: includes content_gaps) ━━━

  getContentRecommendations: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("trend_snapshots")
        .select("content_recommendations, content_gaps, weekly_plan, platform, snapshot_date")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116")
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return data || { content_recommendations: [], content_gaps: [], weekly_plan: [], platform: null, snapshot_date: null };
    }),

  // ━━━ Intelligence Dashboard (comprehensive) ━━━

  getIntelligenceDashboard: protectedProcedure
    .input(z.object({ brandId: z.string().uuid(), period: z.enum(["7d", "30d", "90d"]).default("30d") }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const periodDays = input.period === "7d" ? 7 : input.period === "90d" ? 90 : 30;
      const since = new Date();
      since.setDate(since.getDate() - periodDays);

      // 1. Get ALL content_categories fields (many were unused before)
      const { data: categories } = await db
        .from("content_categories")
        .select("primary_category, secondary_category, tone, topics, sentiment_score, predicted_engagement_score, actual_engagement_rate, prediction_accuracy, group_id, created_at")
        .eq("brand_id", input.brandId)
        .gte("created_at", since.toISOString());

      // 2. Get analytics for these groups
      const groupIds = [...new Set((categories || []).map((c: any) => c.group_id))];
      const analyticsMap: Record<string, any[]> = {};
      if (groupIds.length > 0) {
        const { data: posts } = await db.from("content_posts").select("id, group_id").in("group_id", groupIds);
        const postIds = (posts || []).map((p: any) => p.id);
        const postToGroup: Record<string, string> = {};
        for (const p of posts || []) postToGroup[p.id] = p.group_id;

        if (postIds.length > 0) {
          for (let i = 0; i < postIds.length; i += 200) {
            const chunk = postIds.slice(i, i + 200);
            const { data: analytics } = await db.from("post_analytics")
              .select("post_id, views, likes, comments, shares, engagement_rate")
              .in("post_id", chunk);
            for (const a of analytics || []) {
              const gid = postToGroup[a.post_id];
              if (!analyticsMap[gid]) analyticsMap[gid] = [];
              analyticsMap[gid].push(a);
            }
          }
        }
      }

      // 3. Content mix analysis (tone distribution, topic frequency, category proportions)
      const toneDistribution: Record<string, number> = {};
      const topicFrequency: Record<string, number> = {};
      const categoryProportions: Record<string, number> = {};
      let totalPredictionAccuracy = 0, accuracyCount = 0;
      let totalSentiment = 0, sentimentCount = 0;

      for (const cat of categories || []) {
        // Tone
        if (cat.tone) toneDistribution[cat.tone] = (toneDistribution[cat.tone] || 0) + 1;
        // Topics
        for (const topic of cat.topics || []) topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
        // Categories
        categoryProportions[cat.primary_category] = (categoryProportions[cat.primary_category] || 0) + 1;
        // Prediction accuracy
        if (cat.prediction_accuracy != null) { totalPredictionAccuracy += cat.prediction_accuracy; accuracyCount++; }
        // Sentiment
        if (cat.sentiment_score != null) { totalSentiment += cat.sentiment_score; sentimentCount++; }
      }

      // 4. Category performance (like getCategoryBreakdown but enriched)
      const prevSince = new Date();
      prevSince.setDate(prevSince.getDate() - periodDays * 2);
      const { data: prevCategories } = await db.from("content_categories")
        .select("primary_category").eq("brand_id", input.brandId)
        .gte("created_at", prevSince.toISOString()).lt("created_at", since.toISOString());

      const prevCounts: Record<string, number> = {};
      for (const c of prevCategories || []) prevCounts[c.primary_category] = (prevCounts[c.primary_category] || 0) + 1;

      const catPerf: Record<string, { postCount: number; totalViews: number; totalEng: number; totalShares: number; count: number; avgPrediction: number; predCount: number }> = {};
      for (const cat of categories || []) {
        if (!catPerf[cat.primary_category]) catPerf[cat.primary_category] = { postCount: 0, totalViews: 0, totalEng: 0, totalShares: 0, count: 0, avgPrediction: 0, predCount: 0 };
        const e = catPerf[cat.primary_category];
        e.postCount++;
        if (cat.predicted_engagement_score != null) { e.avgPrediction += cat.predicted_engagement_score; e.predCount++; }
        for (const a of analyticsMap[cat.group_id] || []) {
          e.totalViews += a.views || 0;
          e.totalEng += a.engagement_rate || 0;
          e.totalShares += a.shares || 0;
          e.count++;
        }
      }

      const categoryPerformance = Object.entries(catPerf).map(([category, d]) => ({
        category,
        postCount: d.postCount,
        avgViews: d.count > 0 ? Math.round(d.totalViews / d.count) : 0,
        avgEngagement: d.count > 0 ? Math.round((d.totalEng / d.count) * 100) / 100 : 0,
        avgShares: d.count > 0 ? Math.round(d.totalShares / d.count) : 0,
        avgPredictedScore: d.predCount > 0 ? Math.round(d.avgPrediction / d.predCount) : null,
        trend: prevCounts[category] ? Math.round(((d.postCount - prevCounts[category]) / prevCounts[category]) * 100) : null,
      })).sort((a, b) => b.avgEngagement - a.avgEngagement);

      // 5. Get latest trend snapshot (properly mapped for UI)
      const { data: snapshots, error: snapErr } = await db.from("trend_snapshots")
        .select("trending_categories, trending_topics, trending_formats, content_recommendations, content_gaps, weekly_plan, platform, snapshot_date")
        .eq("brand_id", input.brandId)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

      // PGRST116 = no rows found — that's fine, just means no forecast yet
      if (snapErr && snapErr.code !== "PGRST116")
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: snapErr.message });

      // Map trending data to UI-expected format
      const trendingCategories = ((snapshots?.trending_categories || []) as any[]).map((c: any) => ({
        name: c.category || c.name || "Unknown",
        score: c.score || 0,
        trend: c.trend === "declining" ? "falling" : c.trend || "stable",
      }));
      const trendingTopics = ((snapshots?.trending_topics || []) as any[]).map((t: any) => ({
        name: t.topic || t.name || "Unknown",
        score: t.score || 0,
        trend: "rising" as const, // topics returned without trend, but they're trending
      }));
      const trendingFormats = ((snapshots?.trending_formats || []) as any[]).map((f: any) => ({
        name: f.format || f.name || "Unknown",
        recommendation: f.recommendation || "",
        trend: "rising" as const,
      }));

      const contentRecommendations = ((snapshots?.content_recommendations || []) as any[]).map((rec: any) => {
        if (typeof rec === "string") return { text: rec };
        return rec;
      });
      const contentGaps = ((snapshots?.content_gaps || []) as any[]).map((gap: any) => {
        if (typeof gap === "string") return { text: gap };
        return gap;
      });
      const weeklyPlan = (snapshots?.weekly_plan || []) as any[];

      // 6. Performance predictions accuracy summary
      const { data: predictions } = await db.from("performance_predictions")
        .select("predicted_views_min, predicted_views_max, predicted_engagement_rate, actual_views, actual_engagement_rate, confidence_score, platform, created_at")
        .eq("brand_id", input.brandId)
        .not("actual_views", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);

      let viewsAccuracy = 0, engAccuracy = 0, predictionCount = 0;
      for (const p of predictions || []) {
        if (p.actual_views != null && p.predicted_views_min != null) {
          const mid = (p.predicted_views_min + p.predicted_views_max) / 2;
          if (mid > 0) {
            viewsAccuracy += Math.max(0, 1 - Math.abs(p.actual_views - mid) / mid);
            predictionCount++;
          }
        }
        if (p.actual_engagement_rate != null && p.predicted_engagement_rate != null && p.predicted_engagement_rate > 0) {
          engAccuracy += Math.max(0, 1 - Math.abs(p.actual_engagement_rate - p.predicted_engagement_rate) / p.predicted_engagement_rate);
        }
      }

      return {
        categoryPerformance,
        contentMix: {
          toneDistribution: Object.entries(toneDistribution).map(([tone, count]) => ({ tone, count })).sort((a, b) => b.count - a.count),
          topTopics: Object.entries(topicFrequency).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([topic, count]) => ({ topic, count })),
          categoryProportions: Object.entries(categoryProportions).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
          avgSentiment: sentimentCount > 0 ? Math.round((totalSentiment / sentimentCount) * 100) / 100 : null,
          totalPosts: (categories || []).length,
        },
        forecast: {
          categories: trendingCategories,
          topics: trendingTopics,
          formats: trendingFormats,
          snapshotDate: snapshots?.snapshot_date || null,
        },
        recommendations: contentRecommendations,
        contentGaps,
        weeklyPlan,
        predictionAccuracy: {
          avgViewsAccuracy: predictionCount > 0 ? Math.round((viewsAccuracy / predictionCount) * 100) : null,
          avgEngAccuracy: predictionCount > 0 ? Math.round((engAccuracy / predictionCount) * 100) : null,
          avgContentAccuracy: accuracyCount > 0 ? Math.round((totalPredictionAccuracy / accuracyCount) * 100) : null,
          totalPredictions: predictionCount,
        },
      };
    }),

  // ━━━ Content Strategy (on-demand LLM) ━━━

  getContentStrategy: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Gather all intelligence data
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

      const [catResult, analyticsResult, brandResult] = await Promise.all([
        db.from("content_categories")
          .select("primary_category, tone, topics, predicted_engagement_score, actual_engagement_rate, prediction_accuracy")
          .eq("brand_id", input.brandId).gte("created_at", ninetyDaysAgo),
        db.rpc("get_brand_analytics", { p_brand_id: input.brandId }),
        db.from("brands").select("name").eq("id", input.brandId).single(),
      ]);

      const categories = catResult.data || [];
      const analytics = (analyticsResult.data || []) as any[];
      const brandName = brandResult.data?.name || "Unknown";

      if (categories.length === 0 && analytics.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not enough data to generate strategy. Publish more content first." });
      }

      const llmConfig = await resolveLlmConfig(profile.id, profile.org_id, input.brandId);
      if (!llmConfig) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No LLM provider configured. Set up AI in Settings." });
      }

      // Build data summary for LLM
      const catCounts: Record<string, number> = {};
      const toneCounts: Record<string, number> = {};
      const topicCounts: Record<string, number> = {};
      let predictedVsActual: { predicted: number; actual: number }[] = [];

      for (const c of categories) {
        catCounts[c.primary_category] = (catCounts[c.primary_category] || 0) + 1;
        if (c.tone) toneCounts[c.tone] = (toneCounts[c.tone] || 0) + 1;
        for (const t of c.topics || []) topicCounts[t] = (topicCounts[t] || 0) + 1;
        if (c.predicted_engagement_score != null && c.actual_engagement_rate != null) {
          predictedVsActual.push({ predicted: c.predicted_engagement_score, actual: c.actual_engagement_rate });
        }
      }

      // Platform performance
      const platPerf: Record<string, { views: number; eng: number; count: number }> = {};
      for (const a of analytics) {
        const p = a.platform || "unknown";
        if (!platPerf[p]) platPerf[p] = { views: 0, eng: 0, count: 0 };
        platPerf[p].views += a.views || 0;
        platPerf[p].eng += a.engagement_rate || 0;
        platPerf[p].count++;
      }

      const result = await chatCompletion({
        systemPrompt: "You are an elite social media strategist. Analyze the data and return ONLY valid JSON, no markdown.",
        messages: [{
          role: "user",
          content: `Generate a content strategy for brand "${brandName}" based on this performance data.

**Content categories (${categories.length} posts, last 90 days):** ${JSON.stringify(catCounts)}
**Tone distribution:** ${JSON.stringify(toneCounts)}
**Top topics:** ${JSON.stringify(Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 15))}
**Platform performance:** ${JSON.stringify(Object.entries(platPerf).map(([p, d]) => ({ platform: p, posts: d.count, avgViews: d.count > 0 ? Math.round(d.views / d.count) : 0, avgEng: d.count > 0 ? Math.round(d.eng / d.count * 100) / 100 : 0 })))}
**Prediction accuracy (${predictedVsActual.length} samples):** ${predictedVsActual.length > 0 ? `avg predicted=${Math.round(predictedVsActual.reduce((s, p) => s + p.predicted, 0) / predictedVsActual.length)}, avg actual=${Math.round(predictedVsActual.reduce((s, p) => s + p.actual, 0) / predictedVsActual.length * 100) / 100}` : "No data"}

Return JSON:
{
  "strategySummary": "3-4 sentence overview of the brand's content performance and strategic direction",
  "strengths": ["What's working well (2-3 items)"],
  "weaknesses": ["What needs improvement (2-3 items)"],
  "opportunities": [
    { "title": "Short title", "description": "1-2 sentence actionable opportunity", "priority": "high"|"medium"|"low", "platform": "instagram|youtube|linkedin|all" }
  ],
  "contentIdeas": [
    { "title": "Content idea title", "category": "educational|entertainment|etc", "platform": "best platform", "format": "reel|post|video|story|carousel", "whyItWorks": "1 sentence" }
  ],
  "toneAdvice": "1-2 sentences on how to adjust tone based on what's performing",
  "topicGaps": ["Topics the brand should explore but hasn't"]
}

Provide 3-5 opportunities, 4-6 content ideas, and 3-5 topic gaps. Be specific to the data.`,
        }],
        configOverride: llmConfig,
        maxTokens: 2048,
      });

      const content = result.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse AI response" });

      return JSON.parse(jsonMatch[0]);
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

  // ━━━ Detailed Sentiment (per-platform, trend, comments) ━━━

  getDetailedSentiment: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // 1. Get all comment_sentiments with post info
      const { data: sentiments } = await db
        .from("comment_sentiments")
        .select("*, content_posts(id, group_id, published_at, media_groups:group_id(title, caption))")
        .eq("brand_id", input.brandId)
        .order("analyzed_at", { ascending: false });

      // 2. Get platform_comments for this brand (recent 500 for analysis)
      const { data: comments } = await db
        .from("platform_comments")
        .select("id, post_id, social_account_id, platform, author_username, comment_text, comment_timestamp, like_count, reply_count, status, sentiment")
        .eq("brand_id", input.brandId)
        .order("comment_timestamp", { ascending: false })
        .limit(500);

      // 3. Get social accounts for mapping
      const { data: accounts } = await db
        .from("social_accounts")
        .select("id, platform, platform_username")
        .eq("brand_id", input.brandId)
        .eq("is_active", true);

      const accountMap: Record<string, { platform: string; username: string }> = {};
      for (const a of accounts || []) {
        accountMap[a.id] = { platform: a.platform, username: a.platform_username || "unknown" };
      }

      const allComments = comments || [];
      const allSentiments = sentiments || [];

      // ── Overall aggregates ──
      let totalPositive = 0, totalNegative = 0, totalNeutral = 0;
      let purchaseIntent = 0, questions = 0;
      let totalScore = 0, scoreCount = 0;
      const posThemes: Record<string, number> = {};
      const negThemes: Record<string, number> = {};
      const posts: any[] = [];

      for (const s of allSentiments) {
        totalPositive += s.positive_count || 0;
        totalNegative += s.negative_count || 0;
        totalNeutral += s.neutral_count || 0;
        purchaseIntent += s.purchase_intent_signals || 0;
        questions += s.questions_count || 0;
        if (s.sentiment_score != null) { totalScore += s.sentiment_score; scoreCount++; }

        for (const t of (s.top_positive_themes as string[]) || []) posThemes[t] = (posThemes[t] || 0) + 1;
        for (const t of (s.top_negative_themes as string[]) || []) negThemes[t] = (negThemes[t] || 0) + 1;

        const post = s.content_posts as any;
        const group = post?.media_groups;
        posts.push({
          postId: s.post_id,
          title: group?.title || group?.caption?.slice(0, 60) || "Untitled post",
          positive: s.positive_count || 0,
          negative: s.negative_count || 0,
          neutral: s.neutral_count || 0,
          sentiment: s.overall_sentiment || "neutral",
          score: s.sentiment_score || 0,
          summary: s.summary || "",
          publishedAt: post?.published_at || null,
          analyzedAt: s.analyzed_at,
        });
      }

      const avgScore = scoreCount > 0 ? Math.round((totalScore / scoreCount) * 100) / 100 : 0;

      // ── Per-platform breakdown (from actual comments) ──
      const platformBreakdown: Record<string, { positive: number; negative: number; neutral: number; question: number; total: number }> = {};
      for (const c of allComments) {
        const p = c.platform || "unknown";
        if (!platformBreakdown[p]) platformBreakdown[p] = { positive: 0, negative: 0, neutral: 0, question: 0, total: 0 };
        platformBreakdown[p].total++;
        const s = c.sentiment || "neutral";
        if (s === "positive") platformBreakdown[p].positive++;
        else if (s === "negative") platformBreakdown[p].negative++;
        else if (s === "question") platformBreakdown[p].question++;
        else platformBreakdown[p].neutral++;
      }

      // ── Per-account breakdown ──
      const accountBreakdown: Record<string, { platform: string; username: string; positive: number; negative: number; neutral: number; question: number; total: number }> = {};
      for (const c of allComments) {
        const accId = c.social_account_id;
        if (!accId) continue;
        if (!accountBreakdown[accId]) {
          const acc = accountMap[accId] || { platform: c.platform || "unknown", username: "unknown" };
          accountBreakdown[accId] = { platform: acc.platform, username: acc.username, positive: 0, negative: 0, neutral: 0, question: 0, total: 0 };
        }
        accountBreakdown[accId].total++;
        const s = c.sentiment || "neutral";
        if (s === "positive") accountBreakdown[accId].positive++;
        else if (s === "negative") accountBreakdown[accId].negative++;
        else if (s === "question") accountBreakdown[accId].question++;
        else accountBreakdown[accId].neutral++;
      }

      // ── Weekly sentiment trend (from comments by timestamp) ──
      const weeklyTrend: Record<string, { positive: number; negative: number; neutral: number; total: number }> = {};
      for (const c of allComments) {
        const d = new Date(c.comment_timestamp);
        // Get Monday of that week
        const day = d.getUTCDay();
        const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d);
        monday.setUTCDate(diff);
        const weekKey = monday.toISOString().slice(0, 10);

        if (!weeklyTrend[weekKey]) weeklyTrend[weekKey] = { positive: 0, negative: 0, neutral: 0, total: 0 };
        weeklyTrend[weekKey].total++;
        const s = c.sentiment || "neutral";
        if (s === "positive") weeklyTrend[weekKey].positive++;
        else if (s === "negative") weeklyTrend[weekKey].negative++;
        else weeklyTrend[weekKey].neutral++;
      }

      const trend = Object.entries(weeklyTrend)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12) // last 12 weeks max
        .map(([week, data]) => ({ week, ...data }));

      // ── Notable comments ──
      const topLiked = [...allComments]
        .filter((c) => c.like_count > 0)
        .sort((a, b) => b.like_count - a.like_count)
        .slice(0, 5)
        .map((c) => ({
          id: c.id,
          platform: c.platform,
          author: c.author_username,
          text: c.comment_text.slice(0, 200),
          likes: c.like_count,
          sentiment: c.sentiment,
          timestamp: c.comment_timestamp,
        }));

      const recentQuestions = allComments
        .filter((c: any) => c.sentiment === "question")
        .slice(0, 5)
        .map((c: any) => ({
          id: c.id,
          platform: c.platform,
          author: c.author_username,
          text: c.comment_text.slice(0, 200),
          likes: c.like_count,
          status: c.status,
          timestamp: c.comment_timestamp,
        }));

      const recentNegative = allComments
        .filter((c: any) => c.sentiment === "negative")
        .slice(0, 5)
        .map((c: any) => ({
          id: c.id,
          platform: c.platform,
          author: c.author_username,
          text: c.comment_text.slice(0, 200),
          likes: c.like_count,
          status: c.status,
          timestamp: c.comment_timestamp,
        }));

      // ── Comment stats ──
      const commentStats = {
        total: allComments.length,
        unread: allComments.filter((c: any) => c.status === "unread").length,
        replied: allComments.filter((c: any) => c.status === "replied").length,
        flagged: allComments.filter((c: any) => c.status === "flagged").length,
      };

      return {
        overall: { positive: totalPositive, negative: totalNegative, neutral: totalNeutral },
        avgScore,
        purchaseIntentCount: purchaseIntent,
        questionsCount: questions,
        posts,
        topThemes: {
          positive: Object.entries(posThemes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t),
          negative: Object.entries(negThemes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t),
        },
        platformBreakdown: Object.entries(platformBreakdown).map(([platform, data]) => ({ platform, ...data })),
        accountBreakdown: Object.entries(accountBreakdown).map(([accountId, data]) => ({ accountId, ...data })),
        trend,
        notable: { topLiked, recentQuestions, recentNegative },
        commentStats,
      };
    }),

  // ━━━ Sentiment AI Insights (on-demand LLM analysis) ━━━

  getSentimentInsights: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Gather data for LLM analysis
      const { data: sentiments } = await db
        .from("comment_sentiments")
        .select("overall_sentiment, sentiment_score, positive_count, negative_count, neutral_count, top_positive_themes, top_negative_themes, purchase_intent_signals, questions_count, summary")
        .eq("brand_id", input.brandId)
        .order("analyzed_at", { ascending: false })
        .limit(20);

      const { data: recentComments } = await db
        .from("platform_comments")
        .select("platform, comment_text, like_count, sentiment")
        .eq("brand_id", input.brandId)
        .order("comment_timestamp", { ascending: false })
        .limit(40);

      if ((!sentiments || sentiments.length === 0) && (!recentComments || recentComments.length === 0)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No sentiment data available to analyze. Publish content and wait for comments." });
      }

      const llmConfig = await resolveLlmConfig(profile.id, profile.org_id, input.brandId);
      if (!llmConfig) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No LLM provider configured. Set up AI in Settings to get insights." });
      }

      // Build context for LLM
      const sentimentSummary = (sentiments || []).map((s: any) => ({
        sentiment: s.overall_sentiment,
        score: s.sentiment_score,
        positive: s.positive_count,
        negative: s.negative_count,
        neutral: s.neutral_count,
        posThemes: s.top_positive_themes,
        negThemes: s.top_negative_themes,
        purchaseIntent: s.purchase_intent_signals,
        questions: s.questions_count,
        summary: s.summary,
      }));

      const commentSamples = (recentComments || []).map((c: any) => ({
        platform: c.platform,
        text: c.comment_text.slice(0, 150),
        likes: c.like_count,
        sentiment: c.sentiment,
      }));

      const result = await chatCompletion({
        systemPrompt: "You are a social media analytics expert. Analyze the audience sentiment data and return ONLY valid JSON, no markdown or explanation.",
        messages: [{
          role: "user",
          content: `Analyze this brand's audience sentiment data and provide actionable insights.\n\n**Post-level sentiment summaries (${sentimentSummary.length} posts):**\n${JSON.stringify(sentimentSummary, null, 2)}\n\n**Recent comment samples (${commentSamples.length}):**\n${JSON.stringify(commentSamples, null, 2)}\n\nReturn JSON in this exact format:\n{\n  "moodSummary": "2-3 sentence summary of the overall audience mood and how it's trending",\n  "insights": [\n    {\n      "type": "strength" | "concern" | "opportunity",\n      "title": "Short insight title",\n      "description": "1-2 sentence actionable explanation"\n    }\n  ],\n  "contentAdvice": [\n    "Specific actionable tip for improving audience sentiment"\n  ],\n  "audiencePersonality": "One short phrase describing the typical audience vibe (e.g., 'Enthusiastic early adopters', 'Critical but loyal community')"\n}\n\nProvide 3-5 insights and 2-4 content tips. Be specific to the data, not generic.`,
        }],
        configOverride: llmConfig,
        maxTokens: 2048,
      });

      const content = result.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse AI response" });
      }

      return JSON.parse(jsonMatch[0]);
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
        const platformActionPrefix: Record<string, string> = {
          instagram: "ig_", youtube: "yt_", linkedin: "li_", facebook: "fb_",
          tiktok: "tt_", twitter: "tw_", snapchat: "sc_",
        };
        const prefix = platformActionPrefix[input.platform] || `${input.platform}_`;
        jobQuery = jobQuery.ilike("action", `${prefix}%`);
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

        // Use max(views, impressions) for the display value — avoids double-counting
        // IG images: views == impressions, Reels: views only, YouTube: views == impressions
        const views = Math.max(a?.views || 0, a?.impressions || 0);
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
          avg_view_duration: a?.avg_view_duration_seconds || 0,
          // Use stored engagement_rate if available, else compute from views/likes/comments/shares
          engagement_rate: (a?.engagement_rate || 0) > 0
            ? a.engagement_rate
            : (views > 0 ? Math.round(((likes + comments + shares) / views) * 10000) / 100 : 0),
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
      let publishedAt: string | null = null;

      if (job) {
        const contentPost = job.content_posts as any;
        brandId = contentPost.brand_id;
        publishedAt = contentPost.published_at;
        publishJobId = job.id;
        contentPostId = job.post_id;
      } else {
        const { data: post } = await db
          .from("content_posts")
          .select("id, brand_id, published_at")
          .eq("id", input.postId)
          .single();
        if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
        brandId = post.brand_id;
        publishedAt = post.published_at;
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
        publishedAt,
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

      // 1. Deduplicate: keep only the LATEST snapshot per post per day
      //    Analytics snapshots are cumulative (100 → 120 → 150 views), so summing them
      //    would massively inflate numbers. Take the last snapshot per post per day.
      const postDayLatest: Record<string, any> = {}; // key: "postId|date"
      for (const h of history) {
        const date = h.snapshot_at.slice(0, 10);
        const key = `${h.post_id}|${date}`;
        if (!postDayLatest[key] || h.snapshot_at > postDayLatest[key].snapshot_at) {
          postDayLatest[key] = h;
        }
      }
      const dedupedRows = Object.values(postDayLatest);

      // 2. Aggregate deduplicated rows into daily totals per platform
      const dailyMap: Record<string, Record<string, { views: number; likes: number; comments: number; shares: number; count: number }>> = {};
      for (const h of dedupedRows) {
        const date = (h.snapshot_at as string).slice(0, 10);
        const platform = accountPlatforms[h.social_account_id] || "unknown";

        if (!dailyMap[date]) dailyMap[date] = {};
        if (!dailyMap[date]["all"]) dailyMap[date]["all"] = { views: 0, likes: 0, comments: 0, shares: 0, count: 0 };
        if (!dailyMap[date][platform]) dailyMap[date][platform] = { views: 0, likes: 0, comments: 0, shares: 0, count: 0 };

        dailyMap[date]["all"].views += h.views || 0;
        dailyMap[date]["all"].likes += h.likes || 0;
        dailyMap[date]["all"].comments += h.comments || 0;
        dailyMap[date]["all"].shares += h.shares || 0;
        dailyMap[date]["all"].count++;

        dailyMap[date][platform].views += h.views || 0;
        dailyMap[date][platform].likes += h.likes || 0;
        dailyMap[date][platform].comments += h.comments || 0;
        dailyMap[date][platform].shares += h.shares || 0;
        dailyMap[date][platform].count++;
      }

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

      // Get post titles — imported posts (source=api) have group_id=null, title in caption_overrides
      const topIds = topPostIds.map(p => p.postId);
      let topPosts: any[] = [];
      if (topIds.length > 0) {
        const { data: posts } = await db
          .from("content_posts")
          .select("id, group_id, caption_overrides, media_groups:group_id(title, caption)")
          .in("id", topIds);

        // Also fetch permalinks from post_analytics for these posts
        const { data: analyticsRows } = await db
          .from("post_analytics")
          .select("post_id, platform_specific")
          .in("post_id", topIds);
        const permalinkMap: Record<string, string> = {};
        for (const ar of analyticsRows || []) {
          if (ar.platform_specific?.permalink && !permalinkMap[ar.post_id]) {
            permalinkMap[ar.post_id] = ar.platform_specific.permalink;
          }
        }

        topPosts = topPostIds.map(tp => {
          const post = (posts || []).find((p: any) => p.id === tp.postId);
          const group = (post as any)?.media_groups;
          const overrides = (post as any)?.caption_overrides || {};
          const title = group?.caption?.slice(0, 60)
            || overrides.caption?.slice(0, 60)
            || group?.title
            || "Untitled";
          return {
            ...tp,
            title,
            permalink: overrides.permalink || permalinkMap[tp.postId] || "",
            platform: accountPlatforms[history.find((h: any) => h.post_id === tp.postId)?.social_account_id || ""] || "unknown",
          };
        });
      }

      return { daily, platformComparison: platComp, topPosts };
    }),

  // ━━━ Manual Analytics Refresh ━━━

  refreshAnalytics: protectedProcedure
    .input(z.object({ brandId: z.string().uuid(), platform: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { Queue } = await import("bullmq");
      const { getQueueConnection } = await import("@/server/queue/connection");
      const analyticsQueue = new Queue("analytics-fetch", { connection: getQueueConnection() });

      await analyticsQueue.add("manual-refresh", { brandId: input.brandId, platform: input.platform }, {
        jobId: `analytics-manual-${input.brandId}-${input.platform || "all"}-${Date.now()}`,
      });

      const platformLabel = input.platform ? input.platform.charAt(0).toUpperCase() + input.platform.slice(1) : "all platforms";
      return { queued: true, message: `Analytics refresh started for ${platformLabel}. Data will update shortly.` };
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
      // Group by account (platform/@username)
      const accountMap: Record<string, any[]> = {};
      for (const a of rows) {
        const platform = a.platform || "unknown";
        if (!platformMap[platform]) platformMap[platform] = [];
        platformMap[platform].push(a);

        const accountKey = `${platform}/@${a.platform_username || "unknown"}`;
        if (!accountMap[accountKey]) accountMap[accountKey] = [];
        accountMap[accountKey].push(a);
      }

      function aggregate(items: any[]) {
        // Only posts with retention_rate > 0 count for retention avg (YouTube only)
        const retentionItems = items.filter(a => (a.retention_rate || 0) > 0);
        // Only posts with avg_view_duration > 0 count for avg duration (YouTube only)
        const durationItems = items.filter(a => (a.avg_view_duration_seconds || 0) > 0);
        // Posts with views > 0 count for engagement avg
        const engageableItems = items.filter(a => (a.views || 0) > 0);
        // Posts with watch_time > 0 count for avg watch time (IG/FB per-post averages)
        const watchTimeItems = items.filter(a => (a.watch_time_seconds || 0) > 0);

        return {
          posts: items.length,
          // Use max(views, impressions) per row to avoid double-counting:
          // Instagram images store views == impressions (same value), YouTube stores views == impressions
          views: items.reduce((s, a) => s + Math.max(a.views || 0, a.impressions || 0), 0),
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
          // Total watch time (sum) — meaningful for YouTube (estimatedMinutesWatched)
          watch_time_seconds: items.reduce((s, a) => s + (a.watch_time_seconds || 0), 0),
          // Avg watch time per post — meaningful for IG/FB (ig_reels_avg_watch_time / post_video_avg_time_watched)
          avg_watch_time_seconds: watchTimeItems.length > 0
            ? Math.round(watchTimeItems.reduce((s, a) => s + a.watch_time_seconds, 0) / watchTimeItems.length)
            : 0,
          avg_view_duration_seconds: durationItems.length > 0
            ? Math.round(durationItems.reduce((s, a) => s + a.avg_view_duration_seconds, 0) / durationItems.length)
            : 0,
          // Use stored engagement_rate if available, else compute from views/likes/comments/shares
          engagement: engageableItems.length > 0
            ? Math.round(engageableItems.reduce((s, a) => {
                const rate = a.engagement_rate > 0
                  ? a.engagement_rate
                  : ((a.likes || 0) + (a.comments || 0) + (a.shares || 0)) / a.views * 100;
                return s + rate;
              }, 0) / engageableItems.length * 100) / 100
            : 0,
        };
      }

      const total = aggregate(all);
      const byPlatform: Record<string, ReturnType<typeof aggregate>> = {};
      for (const [platform, items] of Object.entries(platformMap)) {
        byPlatform[platform] = aggregate(items);
      }
      const byAccount: Record<string, ReturnType<typeof aggregate>> = {};
      for (const [accountKey, items] of Object.entries(accountMap)) {
        byAccount[accountKey] = aggregate(items);
      }

      return { total, byPlatform, byAccount };
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
        .select("id, group_id, published_at, source, status, caption_overrides")
        .eq("brand_id", input.brandId)
        .in("status", ["published", "partial_published"])
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
        const overrides = post?.caption_overrides || {};
        const job = jobMap[`${a.post_id}_${a.social_account_id}`];
        const sentiment = sentimentMap[a.post_id];

        return {
          title: group?.caption?.slice(0, 60) || overrides.caption?.slice(0, 60) || group?.title || "Untitled",
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

  // ━━━ Smart Best Times (per-account, data-driven + LLM fallback) ━━━

  getSmartBestTimes: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // 1. Get all active social accounts for this brand
      const { data: accounts } = await db
        .from("social_accounts")
        .select("id, platform, platform_username, platform_user_id, is_active")
        .eq("brand_id", input.brandId)
        .eq("is_active", true);

      if (!accounts || accounts.length === 0) {
        return { accounts: [], hasAnyData: false };
      }

      // 2. Get all published posts with their analytics + published_at for this brand (last 90 days)
      const since = new Date();
      since.setDate(since.getDate() - 90);

      const { data: posts } = await db
        .from("content_posts")
        .select("id, published_at")
        .eq("brand_id", input.brandId)
        .in("status", ["published", "partial_published"])
        .gte("published_at", since.toISOString())
        .not("published_at", "is", null);

      const postIds = (posts || []).map((p: any) => p.id);
      const postDateMap: Record<string, string> = {};
      for (const p of posts || []) {
        postDateMap[p.id] = p.published_at;
      }

      // 3. Get analytics rows linked to these posts, grouped by social_account_id
      let analyticsRows: any[] = [];
      if (postIds.length > 0) {
        // Batch fetch in chunks of 200 to avoid URI issues
        for (let i = 0; i < postIds.length; i += 200) {
          const chunk = postIds.slice(i, i + 200);
          const { data } = await db
            .from("post_analytics")
            .select("post_id, social_account_id, views, likes, comments, shares, saves, engagement_rate")
            .in("post_id", chunk);
          if (data) analyticsRows.push(...data);
        }
      }

      // 4. Group analytics by account, attach published_at from posts
      const accountDataMap: Record<string, { publishedAt: string; views: number; likes: number; comments: number; shares: number; saves: number; engagement_rate: number }[]> = {};

      for (const row of analyticsRows) {
        const accId = row.social_account_id;
        if (!accId || !postDateMap[row.post_id]) continue;
        if (!accountDataMap[accId]) accountDataMap[accId] = [];
        accountDataMap[accId].push({
          publishedAt: postDateMap[row.post_id],
          views: row.views || 0,
          likes: row.likes || 0,
          comments: row.comments || 0,
          shares: row.shares || 0,
          saves: row.saves || 0,
          engagement_rate: row.engagement_rate || 0,
        });
      }

      // 5. Analyze each account
      const MIN_POSTS_FOR_DATA = 5;
      const results: any[] = [];
      const accountsNeedingLlm: { id: string; platform: string; username: string }[] = [];

      for (const acc of accounts) {
        const dataPoints = accountDataMap[acc.id] || [];

        if (dataPoints.length >= MIN_POSTS_FOR_DATA) {
          // Data-driven analysis: bucket by day-of-week + hour, rank by engagement
          const slots: Record<string, { totalEngagement: number; totalViews: number; count: number }> = {};

          for (const dp of dataPoints) {
            const dt = new Date(dp.publishedAt);
            const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const day = dayNames[dt.getUTCDay()];
            const hour = dt.getUTCHours().toString().padStart(2, "0") + ":00";
            const key = `${day}|${hour}`;

            if (!slots[key]) slots[key] = { totalEngagement: 0, totalViews: 0, count: 0 };
            const s = slots[key];
            // Use stored engagement_rate if available, else compute
            const eng = dp.engagement_rate > 0
              ? dp.engagement_rate
              : dp.views > 0
                ? ((dp.likes + dp.comments + dp.shares) / dp.views) * 100
                : 0;
            s.totalEngagement += eng;
            s.totalViews += dp.views;
            s.count++;
          }

          // Rank slots by average engagement
          const ranked = Object.entries(slots)
            .map(([key, val]) => {
              const [day, hour] = key.split("|");
              return {
                day,
                time: hour,
                avgEngagement: Math.round((val.totalEngagement / val.count) * 100) / 100,
                avgViews: Math.round(val.totalViews / val.count),
                postCount: val.count,
              };
            })
            .sort((a, b) => b.avgEngagement - a.avgEngagement);

          // Pick top slots — up to 3 unique days, best time per day
          const bestByDay: Record<string, typeof ranked[0]> = {};
          for (const slot of ranked) {
            if (!bestByDay[slot.day] && Object.keys(bestByDay).length < 5) {
              bestByDay[slot.day] = slot;
            }
          }

          // Overall best engagement for boost calculation
          const overallAvgEng = dataPoints.reduce((s, dp) => {
            const eng = dp.engagement_rate > 0
              ? dp.engagement_rate
              : dp.views > 0 ? ((dp.likes + dp.comments + dp.shares) / dp.views) * 100 : 0;
            return s + eng;
          }, 0) / dataPoints.length;

          const bestTimes = Object.values(bestByDay).map((slot) => ({
            day: slot.day,
            time: slot.time,
            avgEngagement: slot.avgEngagement,
            avgViews: slot.avgViews,
            postCount: slot.postCount,
            boost: overallAvgEng > 0
              ? Math.round(((slot.avgEngagement - overallAvgEng) / overallAvgEng) * 100)
              : 0,
          }));

          // Sort by day order
          const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
          bestTimes.sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day));

          results.push({
            accountId: acc.id,
            platform: acc.platform,
            username: acc.platform_username || acc.platform_user_id || "Unknown",
            source: "data" as const,
            totalPosts: dataPoints.length,
            bestTimes,
            topSlot: ranked[0] || null,
          });
        } else {
          // Not enough data — need LLM
          accountsNeedingLlm.push({
            id: acc.id,
            platform: acc.platform,
            username: acc.platform_username || acc.platform_user_id || "Unknown",
          });
        }
      }

      // 6. LLM fallback for accounts without enough data
      if (accountsNeedingLlm.length > 0) {
        try {
          const llmConfig = await resolveLlmConfig(profile.id, profile.org_id, input.brandId);
          if (llmConfig) {
            const accountList = accountsNeedingLlm
              .map((a) => `- ${a.platform} (@${a.username})`)
              .join("\n");

            const llmResult = await chatCompletion({
              systemPrompt: `You are a social media expert. Return ONLY valid JSON, no markdown or explanation.`,
              messages: [
                {
                  role: "user",
                  content: `I need the best posting times for these social media accounts that have no historical data yet:\n\n${accountList}\n\nFor each account, suggest the top 3-5 best days and times (in UTC, 24h format like "14:00") to post for maximum engagement.\n\nReturn JSON in this exact format:\n{\n  "accounts": [\n    {\n      "platform": "instagram",\n      "username": "@example",\n      "bestTimes": [\n        { "day": "Monday", "time": "14:00", "reason": "brief reason" },\n        { "day": "Wednesday", "time": "18:00", "reason": "brief reason" }\n      ]\n    }\n  ]\n}`,
                },
              ],
              configOverride: llmConfig,
              maxTokens: 2048,
            });

            // Parse LLM response
            const content = llmResult.choices?.[0]?.message?.content || "";
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              for (const llmAcc of parsed.accounts || []) {
                // Match back to our account list
                const match = accountsNeedingLlm.find(
                  (a) => a.platform === llmAcc.platform && `@${a.username}` === llmAcc.username
                ) || accountsNeedingLlm.find(
                  (a) => a.platform === llmAcc.platform
                );

                if (match) {
                  results.push({
                    accountId: match.id,
                    platform: match.platform,
                    username: match.username,
                    source: "ai" as const,
                    totalPosts: 0,
                    bestTimes: (llmAcc.bestTimes || []).map((bt: any) => ({
                      day: bt.day,
                      time: bt.time,
                      reason: bt.reason || "",
                      avgEngagement: 0,
                      avgViews: 0,
                      postCount: 0,
                      boost: 0,
                    })),
                    topSlot: null,
                  });
                  // Remove from needing list so we don't duplicate
                  const idx = accountsNeedingLlm.indexOf(match);
                  if (idx >= 0) accountsNeedingLlm.splice(idx, 1);
                }
              }
            }
          }
        } catch (err) {
          console.error("[smart-best-times] LLM fallback failed:", err);
          // LLM failed — still add accounts with empty results
        }

        // Any accounts not covered by LLM response
        for (const acc of accountsNeedingLlm) {
          results.push({
            accountId: acc.id,
            platform: acc.platform,
            username: acc.username,
            source: "no_data" as const,
            totalPosts: 0,
            bestTimes: [],
            topSlot: null,
          });
        }
      }

      return {
        accounts: results,
        hasAnyData: results.some((r) => r.source === "data"),
      };
    }),
});
