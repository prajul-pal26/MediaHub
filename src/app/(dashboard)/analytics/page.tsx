"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc/client";
import { DateRangePicker, type DateRange } from "@/components/analytics/DateRangePicker";
import {
  BarChart3, Brain, Heart, Users, Eye, MessageSquare,
  Share2, TrendingUp, MousePointer, Clock, Timer, Loader2, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
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


function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function defaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: new Date(start.getFullYear(), start.getMonth(), start.getDate()), end: new Date(end.getFullYear(), end.getMonth(), end.getDate()) };
}

export default function AnalyticsPage() {
  const { activeBrandId, loading } = useBrand();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const startDate = toYMD(range.start);
  const endDate = toYMD(range.end);

  const { data: summary, isLoading: summaryLoading } = trpc.analytics.getSummary.useQuery(
    { brandId: activeBrandId!, startDate, endDate },
    { enabled: !!activeBrandId }
  );

  const { data: timeSeries, isLoading: tsLoading } = trpc.analytics.getAnalyticsTimeSeries.useQuery(
    { brandId: activeBrandId!, startDate, endDate },
    { enabled: !!activeBrandId }
  );

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

  function StatCard({ icon, label, value }: {
    icon: React.ReactNode; label: string; value: string; sub?: Record<string, string>;
  }) {
    return (
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1">
            {icon}
            <p className="text-2xl font-bold tabular-nums">{value}</p>
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </CardContent>
      </Card>
    );
  }

  // Per-account rows for the consolidated breakdown table (one row per account).
  const accountRows = Object.entries(ba)
    .map(([key, d]) => {
      const [plat, ...rest] = key.split("/");
      const data = (d as any) || {};
      return {
        key,
        platform: plat,
        name: rest.join("/"),
        posts: data.posts || 0,
        views: data.views || 0,
        reach: data.reach || 0,
        likes: data.likes || 0,
        comments: data.comments || 0,
        shares: data.shares || 0,
        engagement: data.engagement || 0,
      };
    })
    .sort((a, b) => b.posts - a.posts || b.views - a.views);

  type AcctMetric = "posts" | "views" | "reach" | "likes" | "comments" | "shares" | "engagement";
  const accountColumns: { key: AcctMetric; label: string; fmt?: (n: number) => string }[] = (
    [
      { key: "posts", label: "Posts" },
      { key: "views", label: "Views" },
      { key: "reach", label: "Reach" },
      { key: "likes", label: "Likes" },
      { key: "comments", label: "Comments" },
      { key: "shares", label: "Shares" },
      { key: "engagement", label: "Eng %", fmt: (n: number) => `${n}%` },
    ] as { key: AcctMetric; label: string; fmt?: (n: number) => string }[]
  ).filter((c) => accountRows.some((r) => r[c.key] > 0));

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
        <DateRangePicker value={range} onChange={setRange} />
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

      {/* Per-account breakdown */}
      {accountRows.length > 0 && accountColumns.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">By account</CardTitle>
            <p className="text-xs text-muted-foreground">{accountRows.length} connected accounts</p>
          </CardHeader>
          <CardContent>
            <div className="max-h-[22rem] overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium text-muted-foreground">Account</th>
                    {accountColumns.map((c) => (
                      <th key={String(c.key)} className="px-3 py-2 font-medium text-muted-foreground text-right whitespace-nowrap">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {accountRows.map((r) => (
                    <tr key={r.key} className="border-t hover:bg-muted/40">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: PLATFORM_COLORS[r.platform] || PLATFORM_COLORS.unknown }}
                          />
                          <span className="truncate font-medium">@{r.name.replace(/^@+/, "")}</span>
                          <span className="text-[11px] text-muted-foreground shrink-0">{PLATFORM_LABELS[r.platform] || r.platform}</span>
                        </div>
                      </td>
                      {accountColumns.map((c) => {
                        const val = r[c.key];
                        return (
                          <td
                            key={String(c.key)}
                            className={cn(
                              "px-3 py-2 text-right tabular-nums",
                              val > 0 ? "text-foreground" : "text-muted-foreground/40"
                            )}
                          >
                            {c.fmt ? c.fmt(val) : val.toLocaleString()}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

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

    </div>
  );
}
