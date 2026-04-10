"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import {
  BarChart3, Brain, Heart, Users, Eye, MessageSquare,
  Share2, TrendingUp, MousePointer, Clock, Timer, Loader2, ArrowUpRight, ArrowDownRight, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn",
  facebook: "Facebook", tiktok: "TikTok", twitter: "X", snapchat: "Snapchat", unknown: "Other",
};

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "#C13584", youtube: "#FF0000", linkedin: "#0A66C2",
  facebook: "#1877F2", tiktok: "#010101", twitter: "#1DA1F2", snapchat: "#FFFC00", unknown: "#94a3b8",
};

// Distinct chart colors — optimized for readability on white/dark backgrounds
const CHART_COLORS: Record<string, string> = {
  instagram: "#C13584", youtube: "#FF4444", linkedin: "#0077B5",
  facebook: "#1877F2", tiktok: "#25F4EE", twitter: "#1DA1F2", snapchat: "#F7D800", unknown: "#94a3b8",
};

type Period = "7d" | "30d" | "90d";

export default function AnalyticsPage() {
  const { activeBrandId, loading } = useBrand();
  const [period, setPeriod] = useState<Period>("30d");

  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary } = trpc.analytics.getSummary.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const { data: timeSeries, isLoading: tsLoading, refetch: refetchTimeSeries } = trpc.analytics.getAnalyticsTimeSeries.useQuery(
    { brandId: activeBrandId!, period },
    { enabled: !!activeBrandId }
  );

  const refreshMutation = trpc.analytics.refreshAnalytics.useMutation({
    onSuccess: () => {
      toast.success("Analytics refresh started. Data will update in a few seconds.");
      // Refetch after a delay to allow the worker to process
      setTimeout(() => { refetchSummary(); refetchTimeSeries(); }, 8000);
    },
    onError: (error) => toast.error(error.message),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const total = summary?.total;
  const bp = summary?.byPlatform || {};
  const ba = summary?.byAccount || {};
  const daily = timeSeries?.daily || [];
  const platformComparison = timeSeries?.platformComparison || [];
  const topPosts = timeSeries?.topPosts || [];

  // Extract platforms present in the data
  const activePlatforms = Object.keys(bp).filter(p => p !== "unknown");

  // Build chart-friendly daily data with platform breakdown
  const chartDaily = daily.map((d: any) => {
    const entry: any = { date: d.date.slice(5) }; // MM-DD
    if (d.all) {
      entry.views = d.all.views;
      entry.likes = d.all.likes;
      entry.comments = d.all.comments;
      entry.engagement = d.all.engagement;
    }
    for (const platform of activePlatforms) {
      if (d[platform]) {
        entry[`${platform}_views`] = d[platform].views;
        entry[`${platform}_likes`] = d[platform].likes;
        entry[`${platform}_engagement`] = d[platform].engagement;
      }
    }
    return entry;
  });

  function formatWatchTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600 * 10) / 10}h`;
  }

  // Per-account metric breakdown with optional platform filter, value filter, and formatter
  function byAccountMetric(metric: string, opts?: { format?: (n: number) => string; skipZero?: boolean; platforms?: string[] }): Record<string, string> {
    const result: Record<string, string> = {};
    const fmt = opts?.format || ((n: number) => n.toLocaleString());
    for (const [accountKey, data] of Object.entries(ba)) {
      const platform = accountKey.split("/")[0];

      // Only include specific platforms if requested
      if (opts?.platforms && !opts.platforms.includes(platform)) continue;

      const val: number = (data as any)?.[metric] || 0;

      // Skip accounts with 0 for this metric if requested
      if (opts?.skipZero && val <= 0) continue;

      const [plat, ...rest] = accountKey.split("/");
      const label = `${PLATFORM_LABELS[plat] || plat}/${rest.join("/")}`;
      result[label] = fmt(val);
    }
    return result;
  }

  // Compute a filtered total for a metric across specific platforms
  function filteredTotal(metric: string, platforms: string[], mode: "sum" | "avg" = "sum"): number {
    const vals: number[] = [];
    for (const [accountKey, data] of Object.entries(ba)) {
      const platform = accountKey.split("/")[0];
      if (!platforms.includes(platform)) continue;
      const val = (data as any)?.[metric] || 0;
      if (mode === "avg" && val <= 0) continue;
      vals.push(val);
    }
    if (vals.length === 0) return 0;
    return mode === "sum"
      ? vals.reduce((s, v) => s + v, 0)
      : Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100;
  }

  function StatCard({ icon, label, value, sub }: {
    icon: React.ReactNode; label: string; value: string; sub?: Record<string, string>;
  }) {
    return (
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1">
            {icon}
            <p className="text-xl font-bold">{value}</p>
          </div>
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          {sub && Object.keys(sub).length > 0 && (
            <div className="space-y-0.5 border-t pt-1.5 mt-1">
              {Object.entries(sub).map(([p, v]) => (
                <div key={p} className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">{PLATFORM_LABELS[p] || p}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload) return null;
    return (
      <div className="bg-popover border rounded-lg shadow-lg p-3 text-xs">
        <p className="font-medium mb-1">{label}</p>
        {payload.map((p: any) => (
          <div key={p.name} className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="font-medium">{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics Overview</h1>
          <p className="text-muted-foreground">Performance across all platforms</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => activeBrandId && refreshMutation.mutate({ brandId: activeBrandId })}
            disabled={refreshMutation.isPending || !activeBrandId}
          >
            {refreshMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Refresh
          </Button>
          <div className="flex gap-1">
            {(["7d", "30d", "90d"] as Period[]).map((p) => (
              <Button key={p} variant={period === p ? "default" : "outline"} size="sm" onClick={() => setPeriod(p)}>
                {p}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {summaryLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-4 pb-3"><div className="h-7 w-16 bg-muted animate-pulse rounded mb-1" /><div className="h-4 w-20 bg-muted animate-pulse rounded" /></CardContent></Card>
          ))
        ) : (() => {
          // Build cards dynamically — only show cards that have data
          const fmtNum = (n: number) => n.toLocaleString();
          const fmtPct = (n: number) => `${n}%`;
          const fmtTime = (n: number) => n > 0 ? formatWatchTime(n) : "—";

          const cards: { icon: React.ReactNode; label: string; value: string; sub: Record<string, string> }[] = [
            { icon: <BarChart3 className="h-4 w-4 text-muted-foreground" />, label: "Total Posts", value: fmtNum(total?.posts || 0), sub: byAccountMetric("posts") },
            { icon: <Eye className="h-4 w-4 text-muted-foreground" />, label: "Total Views", value: fmtNum(total?.views || 0), sub: byAccountMetric("views") },
          ];

          // Reach — only if any account has reach > 0 (IG, FB have it; YT doesn't)
          const reachSub = byAccountMetric("reach", { skipZero: true });
          if (Object.keys(reachSub).length > 0) {
            cards.push({ icon: <Users className="h-4 w-4 text-muted-foreground" />, label: "Total Reach", value: fmtNum(total?.reach || 0), sub: reachSub });
          }

          cards.push(
            { icon: <Heart className="h-4 w-4 text-muted-foreground" />, label: "Total Likes", value: fmtNum(total?.likes || 0), sub: byAccountMetric("likes") },
            { icon: <MessageSquare className="h-4 w-4 text-muted-foreground" />, label: "Total Comments", value: fmtNum(total?.comments || 0), sub: byAccountMetric("comments") },
            { icon: <Share2 className="h-4 w-4 text-muted-foreground" />, label: "Total Shares", value: fmtNum(total?.shares || 0), sub: byAccountMetric("shares") },
          );

          // Saves — only platforms that track saves (Instagram)
          const savesSub = byAccountMetric("saves", { skipZero: true });
          if (Object.keys(savesSub).length > 0) {
            cards.push({ icon: <TrendingUp className="h-4 w-4 text-muted-foreground" />, label: "Total Saves", value: fmtNum(total?.saves || 0), sub: savesSub });
          }

          // Watch Time — YouTube only (sum of estimatedMinutesWatched per video)
          const ytPlatforms = ["youtube"];
          const wtSub = byAccountMetric("watch_time_seconds", { format: fmtTime, skipZero: true, platforms: ytPlatforms });
          if (Object.keys(wtSub).length > 0) {
            const ytWatchTotal = filteredTotal("watch_time_seconds", ytPlatforms, "sum");
            cards.push({ icon: <Clock className="h-4 w-4 text-muted-foreground" />, label: "Watch Time", value: fmtTime(ytWatchTotal), sub: wtSub });
          }

          // Avg Watch Time — IG/FB only (per-reel/video average)
          const igFbPlatforms = ["instagram", "facebook"];
          const avgWtSub = byAccountMetric("avg_watch_time_seconds", { format: fmtTime, skipZero: true, platforms: igFbPlatforms });
          if (Object.keys(avgWtSub).length > 0) {
            const avgWtTotal = filteredTotal("avg_watch_time_seconds", igFbPlatforms, "avg");
            cards.push({ icon: <Clock className="h-4 w-4 text-muted-foreground" />, label: "Avg Watch Time", value: fmtTime(avgWtTotal), sub: avgWtSub });
          }

          // Avg Duration — YouTube only (averageViewDuration)
          const durSub = byAccountMetric("avg_view_duration_seconds", { format: fmtTime, skipZero: true, platforms: ytPlatforms });
          if (Object.keys(durSub).length > 0) {
            const durTotal = filteredTotal("avg_view_duration_seconds", ytPlatforms, "avg");
            cards.push({ icon: <Timer className="h-4 w-4 text-muted-foreground" />, label: "Avg Duration", value: fmtTime(durTotal), sub: durSub });
          }

          // Avg Retention — YouTube only
          const retSub = byAccountMetric("retention_rate", { format: fmtPct, skipZero: true, platforms: ytPlatforms });
          if (Object.keys(retSub).length > 0) {
            const retTotal = filteredTotal("retention_rate", ytPlatforms, "avg");
            cards.push({ icon: <Eye className="h-4 w-4 text-muted-foreground" />, label: "Avg Retention", value: retTotal > 0 ? fmtPct(retTotal) : "—", sub: retSub });
          }

          // Avg Engagement — always show
          cards.push({ icon: <MousePointer className="h-4 w-4 text-muted-foreground" />, label: "Avg Engagement", value: fmtPct(total?.engagement || 0), sub: byAccountMetric("engagement", { format: fmtPct }) });

          return cards.map((c, i) => <StatCard key={i} {...c} />);
        })()}
      </div>

      {/* Views Growth Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Views Growth</CardTitle>
        </CardHeader>
        <CardContent>
          {tsLoading ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : chartDaily.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">No time-series data yet. Data is collected every 6 hours.</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartDaily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => {
                    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
                    return String(v);
                  }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                {activePlatforms.map(p => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={`${p}_views`}
                    name={PLATFORM_LABELS[p] || p}
                    stroke={CHART_COLORS[p] || "#8884d8"}
                    strokeWidth={2.5}
                    dot={{ r: 4, fill: CHART_COLORS[p] || "#8884d8" }}
                    activeDot={{ r: 6 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cross-Platform Comparison Bar Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Cross-Platform Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            {platformComparison.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">No platform data</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={platformComparison.map((p: any) => ({ ...p, name: PLATFORM_LABELS[p.platform] || p.platform }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Bar dataKey="views" name="Views" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="likes" name="Likes" fill="#ec4899" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="comments" name="Comments" fill="#f97316" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="shares" name="Shares" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Engagement Rate by Platform */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Engagement Rate by Platform</CardTitle>
          </CardHeader>
          <CardContent>
            {platformComparison.length === 0 ? (
              <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">No platform data</div>
            ) : (
              <div className="flex items-center gap-6 h-[300px]">
                <ResponsiveContainer width="60%" height="100%">
                  <PieChart>
                    <Pie
                      data={platformComparison.map((p: any) => ({ name: PLATFORM_LABELS[p.platform] || p.platform, value: p.engagement, platform: p.platform }))}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {platformComparison.map((p: any) => (
                        <Cell key={p.platform} fill={PLATFORM_COLORS[p.platform] || "#94a3b8"} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: any) => `${value}%`} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-3">
                  {platformComparison.map((p: any) => (
                    <div key={p.platform} className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: PLATFORM_COLORS[p.platform] || "#94a3b8" }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{PLATFORM_LABELS[p.platform] || p.platform}</p>
                        <p className="text-xs text-muted-foreground">{p.posts} posts</p>
                      </div>
                      <span className="text-sm font-bold">{p.engagement}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Engagement Trends Line Chart */}
      {chartDaily.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Engagement Trends</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartDaily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="%" />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                {activePlatforms.map(p => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={`${p}_engagement`}
                    name={`${PLATFORM_LABELS[p] || p} Engagement`}
                    stroke={CHART_COLORS[p] || "#8884d8"}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Top Performing Posts */}
      {topPosts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Top Performing Posts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topPosts.map((post: any, i: number) => {
                const maxViews = topPosts[0]?.views || 1;
                const barWidth = Math.max((post.views / maxViews) * 100, 5);
                return (
                  <div key={post.postId} className="flex items-center gap-3">
                    <span className="text-sm font-bold text-muted-foreground w-5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {post.permalink ? (
                          <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate hover:underline hover:text-blue-600">{post.title}</a>
                        ) : (
                          <p className="text-sm font-medium truncate">{post.title}</p>
                        )}
                        <Badge variant="outline" className="text-[10px] shrink-0" style={{ borderColor: PLATFORM_COLORS[post.platform], color: PLATFORM_COLORS[post.platform] }}>
                          {PLATFORM_LABELS[post.platform] || post.platform}
                        </Badge>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${barWidth}%`, backgroundColor: PLATFORM_COLORS[post.platform] || "#3b82f6" }} />
                      </div>
                      <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                        <span>{post.views.toLocaleString()} views</span>
                        <span>{post.likes.toLocaleString()} likes</span>
                        <span>{post.comments.toLocaleString()} comments</span>
                        <span>{post.shares.toLocaleString()} shares</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation to sub-pages */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/analytics/intelligence" className="block">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
                  <Brain className="h-5 w-5 text-purple-700" />
                </div>
                <CardTitle className="text-base">Content Intelligence</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                AI-powered category performance, trend forecasts, content recommendations, and weekly plans.
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/analytics/sentiment" className="block">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-pink-100 flex items-center justify-center">
                  <Heart className="h-5 w-5 text-pink-700" />
                </div>
                <CardTitle className="text-base">Sentiment Analysis</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Audience sentiment from comments, top themes, purchase intent, and response tracking.
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/analytics/competitors" className="block">
          <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Users className="h-5 w-5 text-blue-700" />
                </div>
                <CardTitle className="text-base">Competitor Benchmarking</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Track competitor handles, compare follower counts, and benchmark engagement rates.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
