"use client";

import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useBrand } from "@/lib/hooks/use-brand";
import { useUser } from "@/lib/hooks/use-user";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  BarChart3, Eye, Heart, MessageSquare, Share2, Users, Loader2, Clock, Timer,
  ChevronLeft, ChevronRight, Trash2, TrendingUp, MousePointer, ChevronDown, RefreshCw,
} from "lucide-react";

const platformColors: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-800",
  youtube: "bg-red-100 text-red-800",
  linkedin: "bg-blue-100 text-blue-800",
  facebook: "bg-blue-100 text-blue-700",
  tiktok: "bg-gray-100 text-gray-800",
  twitter: "bg-sky-100 text-sky-800",
  snapchat: "bg-yellow-100 text-yellow-800",
};

const platformLabels: Record<string, string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  tiktok: "TikTok",
  twitter: "Twitter",
  snapchat: "Snapchat",
};

const sourceLabels: Record<string, string> = {
  click: "Published",
  chat: "Via Chat",
  api: "Imported",
};

const contentTypeIcons: Record<string, string> = {
  "Image Post": "🖼️", "Reel": "🎬", "Story": "📱", "Carousel": "🎠",
  "Video": "🎥", "Short": "⚡", "Post": "📝", "Article": "📄",
};

function formatWatchTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600 * 10) / 10}h`;
}

function PostProgressPanel({ postId }: { postId: string }) {
  const { data, isLoading } = trpc.analytics.getPostProgress.useQuery({ postId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.snapshots.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground">
        <p className="text-sm">No progress data yet. Data is recorded every 6 hours.</p>
      </div>
    );
  }

  const { snapshots, growth } = data;
  const maxViews = Math.max(...snapshots.map((s: any) => s.views || 0), 1);
  const maxLikes = Math.max(...snapshots.map((s: any) => s.likes || 0), 1);

  return (
    <div className="space-y-4 py-2">
      {/* Growth summary */}
      {growth && (
        <div className="flex gap-4 text-xs">
          {[
            { label: "Views", value: growth.views, color: "text-blue-600" },
            { label: "Likes", value: growth.likes, color: "text-pink-600" },
            { label: "Comments", value: growth.comments, color: "text-orange-600" },
            { label: "Shares", value: growth.shares, color: "text-green-600" },
          ].map((g) => (
            <div key={g.label} className="flex items-center gap-1">
              <span className="text-muted-foreground">{g.label}:</span>
              <span className={`font-semibold ${g.value > 0 ? g.color : "text-muted-foreground"}`}>
                {g.value > 0 ? "+" : ""}{g.value}%
              </span>
            </div>
          ))}
          <span className="text-muted-foreground ml-auto">{snapshots.length} snapshots since {new Date(snapshots[0].timestamp).toLocaleDateString()}</span>
        </div>
      )}

      {/* Mini bar chart - Views over time */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Views Over Time</p>
        <div className="flex items-end gap-[2px] h-16">
          {snapshots.map((s: any, i: number) => {
            const height = maxViews > 0 ? Math.max((s.views / maxViews) * 100, 2) : 2;
            return (
              <div
                key={i}
                className="flex-1 bg-blue-400 hover:bg-blue-600 rounded-t transition-colors relative group min-w-[3px]"
                style={{ height: `${height}%` }}
                title={`${new Date(s.timestamp).toLocaleString()}: ${s.views.toLocaleString()} views`}
              >
                <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border rounded px-2 py-1 text-[10px] whitespace-nowrap z-10 shadow-md">
                  {s.views.toLocaleString()} views
                  <br />
                  {new Date(s.timestamp).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mini bar chart - Engagement (likes) over time */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Likes Over Time</p>
        <div className="flex items-end gap-[2px] h-12">
          {snapshots.map((s: any, i: number) => {
            const height = maxLikes > 0 ? Math.max((s.likes / maxLikes) * 100, 2) : 2;
            return (
              <div
                key={i}
                className="flex-1 bg-pink-400 hover:bg-pink-600 rounded-t transition-colors relative group min-w-[3px]"
                style={{ height: `${height}%` }}
                title={`${new Date(s.timestamp).toLocaleString()}: ${s.likes.toLocaleString()} likes`}
              >
                <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border rounded px-2 py-1 text-[10px] whitespace-nowrap z-10 shadow-md">
                  {s.likes.toLocaleString()} likes
                  <br />
                  {new Date(s.timestamp).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline details */}
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{new Date(snapshots[0].timestamp).toLocaleDateString()}</span>
        <span>{new Date(snapshots[snapshots.length - 1].timestamp).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function StatCard({ icon, label, total, byPlatform, format }: {
  icon: React.ReactNode;
  label: string;
  total: number;
  byPlatform?: Record<string, number>;
  format?: (n: number) => string;
}) {
  const fmt = format || ((n: number) => n.toLocaleString());
  return (
    <Card className="border border-black/80 dark:border-white/20 shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.4)] transition-all">
      <CardContent className="pt-4 pb-3">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground/80 uppercase mb-1">{label}</p>
        <div className="flex items-center gap-2 mb-2">
          {icon}
          <p className="text-2xl font-bold">{fmt(total)}</p>
        </div>
        {byPlatform && Object.keys(byPlatform).length > 0 && (
          <div className="space-y-1.5 border-t border-border/40 pt-2 mt-1">
            {Object.entries(byPlatform).map(([platform, value]) => (
              <div key={platform} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{platformLabels[platform] || platform}</span>
                <span className="font-semibold">{fmt(value)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Platform-specific column config: which columns to show per platform
// Table columns per platform
const platformColumns: Record<string, string[]> = {
  all:       ["views_impressions", "reach", "likes", "comments", "shares", "saves", "engagement"],
  instagram: ["views_impressions", "reach", "likes", "comments", "shares", "saves", "watch_time", "engagement"],
  facebook:  ["views_impressions", "reach", "likes", "comments", "shares", "watch_time", "engagement"],
  youtube:   ["views_impressions", "likes", "comments", "shares", "watch_time", "avg_duration", "retention", "engagement"],
  linkedin:  ["views_impressions", "likes", "comments", "shares", "engagement"],
  tiktok:    ["views_impressions", "likes", "comments", "shares", "engagement"],
  twitter:   ["views_impressions", "likes", "comments", "shares", "engagement"],
  snapchat:  ["views_impressions", "likes", "comments", "shares", "engagement"],
};

// Summary cards per platform — only show cards for metrics that exist on that platform
// IG/FB use avg_watch_time (per-post average), YouTube uses watch_time (total)
const platformCards: Record<string, string[]> = {
  all:       ["posts", "views_impressions", "reach", "likes", "comments", "shares", "saves", "engagement"],
  instagram: ["posts", "views_impressions", "reach", "likes", "comments", "shares", "saves", "avg_watch_time", "engagement"],
  facebook:  ["posts", "views_impressions", "reach", "likes", "comments", "shares", "avg_watch_time", "engagement"],
  youtube:   ["posts", "views_impressions", "likes", "comments", "shares", "watch_time", "avg_duration", "retention", "engagement"],
  linkedin:  ["posts", "views_impressions", "likes", "comments", "shares", "engagement"],
  tiktok:    ["posts", "views_impressions", "likes", "comments", "shares", "engagement"],
  twitter:   ["posts", "views_impressions", "likes", "comments", "shares", "engagement"],
  snapchat:  ["posts", "views_impressions", "likes", "comments", "shares", "engagement"],
};

// Column labels — some change per platform
const columnLabelsPerPlatform: Record<string, Record<string, string>> = {
  instagram: { views_impressions: "Views", watch_time: "Avg Watch Time" },
  facebook: { views_impressions: "Views", watch_time: "Avg Watch Time" },
  youtube: { views_impressions: "Views", watch_time: "Watch Time" },
  linkedin: { views_impressions: "Views" },
  tiktok: { views_impressions: "Views" },
  twitter: { views_impressions: "Views" },
};

const columnLabels: Record<string, string> = {
  views_impressions: "Views",
  reach: "Reach",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  watch_time: "Watch Time",
  avg_duration: "Avg Duration",
  retention: "Retention",
  engagement: "Engagement",
};

export default function PostAnalyticsPage() {
  const { activeBrandId, loading } = useBrand();
  const { profile } = useUser();
  const [page, setPage] = useState(1);
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const canDelete = profile && ["super_admin", "agency_admin", "brand_owner"].includes(profile.role);

  const deleteMutation = trpc.analytics.deletePost.useMutation({
    onSuccess: () => {
      toast.success("Post deleted");
      utils.analytics.getPostAnalytics.invalidate();
      utils.analytics.getSummary.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const refreshMutation = trpc.analytics.refreshAnalytics.useMutation({
    onSuccess: () => {
      toast.success("Analytics refresh started. Data will update in a few seconds.");
      setTimeout(() => {
        utils.analytics.getPostAnalytics.invalidate();
        utils.analytics.getSummary.invalidate();
      }, 8000);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const { data: summary, isLoading: summaryLoading } =
    trpc.analytics.getSummary.useQuery(
      { brandId: activeBrandId! },
      { enabled: !!activeBrandId }
    );

  const { data: postsData, isLoading: postsLoading } =
    trpc.analytics.getPostAnalytics.useQuery(
      { brandId: activeBrandId!, page, limit: 20, platform: platformFilter || undefined },
      { enabled: !!activeBrandId }
    );

  // Get connected accounts to build platform toggle dynamically
  const { data: accounts } = trpc.socialAccounts.list.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  // Unique platforms from connected accounts
  const connectedPlatforms = [...new Set((accounts || []).map((a: any) => a.platform))].filter(Boolean) as string[];

  // Auto-select first platform when accounts load
  React.useEffect(() => {
    if (connectedPlatforms.length > 0 && !platformFilter) {
      setPlatformFilter(connectedPlatforms[0]);
    }
  }, [connectedPlatforms.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!activeBrandId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Post Analytics</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
          </div>
        </div>
      </div>
    );
  }

  const posts = postsData?.posts || [];
  const totalPages = postsData?.totalPages || 1;
  const ba = summary?.byAccount || {};

  // Calculate totals for the selected platform only (not all platforms)
  function getPlatformTotal() {
    if (!platformFilter) return summary?.total;
    let views = 0, reach = 0, likes = 0, comments = 0, shares = 0, saves = 0;
    let engagement = 0, engCount = 0;
    let watch_time_seconds = 0, avg_watch_time_seconds = 0, wtCount = 0;
    let retention_rate = 0, retCount = 0;
    let avg_view_duration_seconds = 0, durCount = 0;
    for (const [accountKey, data] of Object.entries(ba)) {
      const platform = accountKey.split("/")[0];
      if (platform !== platformFilter) continue;
      const d = data as any;
      views += d.views || 0; // Already de-duped (max of views/impressions) by backend
      reach += d.reach || 0;
      likes += d.likes || 0;
      comments += d.comments || 0;
      shares += d.shares || 0;
      saves += d.saves || 0;
      watch_time_seconds += d.watch_time_seconds || 0;
      if (d.avg_watch_time_seconds > 0) { avg_watch_time_seconds += d.avg_watch_time_seconds; wtCount++; }
      if (d.avg_view_duration_seconds > 0) { avg_view_duration_seconds += d.avg_view_duration_seconds; durCount++; }
      if (d.retention_rate > 0) { retention_rate += d.retention_rate; retCount++; }
      if (d.engagement > 0) { engagement += d.engagement; engCount++; }
    }
    return {
      views, reach, likes, comments, shares, saves,
      watch_time_seconds,
      avg_watch_time_seconds: wtCount > 0 ? Math.round(avg_watch_time_seconds / wtCount) : 0,
      avg_view_duration_seconds: durCount > 0 ? Math.round(avg_view_duration_seconds / durCount) : 0,
      retention_rate: retCount > 0 ? Math.round(retention_rate / retCount * 100) / 100 : 0,
      engagement: engCount > 0 ? Math.round(engagement / engCount * 100) / 100 : 0,
    };
  }
  const total = getPlatformTotal();

  // Helper to extract a metric per account — filtered to selected platform only
  function byAccountMetric(metric: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [accountKey, data] of Object.entries(ba)) {
      // accountKey format: "instagram/@username"
      const platform = accountKey.split("/")[0];

      // Only show accounts from the selected platform
      if (platformFilter && platform !== platformFilter) continue;

      let val: number;
      if (metric === "_count") {
        val = (data as any)?.posts || 0;
      } else {
        val = (data as any)?.[metric] || 0;
      }

      // Show just @username (no platform prefix since we're already filtered)
      const username = accountKey.split("/@")[1] || accountKey;
      result[`@${username}`] = val;
    }
    return result;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Post Analytics</h1>
          <p className="text-muted-foreground">
            Performance metrics across all platforms
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => activeBrandId && refreshMutation.mutate({ brandId: activeBrandId, platform: platformFilter || undefined })}
          disabled={refreshMutation.isPending || !activeBrandId}
        >
          {refreshMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Refresh
        </Button>
      </div>

      {/* Summary Cards — dynamic per platform */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {summaryLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3">
                <div className="h-7 w-16 bg-muted animate-pulse rounded mb-1" />
                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            {(platformCards[platformFilter] || platformCards.all).map((card) => {
              const cardConfig: Record<string, { icon: React.ReactNode; label: string; total: number; metric: string; format?: (n: number) => string }> = {
                posts:             { icon: <BarChart3 className="h-4 w-4 text-muted-foreground" />, label: "Total Posts", total: postsData?.total || 0, metric: "_count" },
                views_impressions: { icon: <Eye className="h-4 w-4 text-muted-foreground" />, label: columnLabelsPerPlatform[platformFilter]?.views_impressions || "Views", total: total?.views || 0, metric: "views" },
                reach:             { icon: <Users className="h-4 w-4 text-muted-foreground" />, label: "Reach", total: total?.reach || 0, metric: "reach" },
                likes:             { icon: <Heart className="h-4 w-4 text-muted-foreground" />, label: "Total Likes", total: total?.likes || 0, metric: "likes" },
                comments:          { icon: <MessageSquare className="h-4 w-4 text-muted-foreground" />, label: "Total Comments", total: total?.comments || 0, metric: "comments" },
                shares:            { icon: <Share2 className="h-4 w-4 text-muted-foreground" />, label: "Total Shares", total: total?.shares || 0, metric: "shares" },
                saves:             { icon: <TrendingUp className="h-4 w-4 text-muted-foreground" />, label: "Total Saves", total: total?.saves || 0, metric: "saves" },
                watch_time:        { icon: <Clock className="h-4 w-4 text-muted-foreground" />, label: "Watch Time", total: total?.watch_time_seconds || 0, metric: "watch_time_seconds", format: (n) => n > 0 ? formatWatchTime(n) : "—" },
                avg_watch_time:    { icon: <Clock className="h-4 w-4 text-muted-foreground" />, label: "Avg Watch Time", total: total?.avg_watch_time_seconds || 0, metric: "avg_watch_time_seconds", format: (n) => n > 0 ? formatWatchTime(n) : "—" },
                avg_duration:      { icon: <Timer className="h-4 w-4 text-muted-foreground" />, label: "Avg Duration", total: total?.avg_view_duration_seconds || 0, metric: "avg_view_duration_seconds", format: (n) => n > 0 ? formatWatchTime(n) : "—" },
                retention:         { icon: <Eye className="h-4 w-4 text-muted-foreground" />, label: "Avg Retention", total: total?.retention_rate || 0, metric: "retention_rate", format: (n) => n > 0 ? `${n}%` : "—" },
                engagement:        { icon: <MousePointer className="h-4 w-4 text-muted-foreground" />, label: "Avg Engagement", total: total?.engagement || 0, metric: "engagement", format: (n) => `${n}%` },
              };
              const c = cardConfig[card];
              if (!c) return null;
              return (
                <StatCard
                  key={card}
                  icon={c.icon}
                  label={c.label}
                  total={c.total}
                  byPlatform={byAccountMetric(c.metric)}
                  format={c.format}
                />
              );
            })}
          </>
        )}
      </div>

      {/* Posts Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              {platformLabels[platformFilter] || platformFilter || "All"} Posts ({postsData?.total || 0})
            </CardTitle>
            <div className="flex gap-1 flex-wrap">
              {connectedPlatforms.map((p) => (
                <Button
                  key={p}
                  variant={platformFilter === p ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setPlatformFilter(p); setPage(1); }}
                  className={`text-xs ${platformFilter === p ? "" : platformColors[p] || ""}`}
                >
                  {platformLabels[p] || p}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {postsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : posts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No published posts yet</p>
              <p className="text-sm">Connect a social account to see analytics</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                {(() => {
                  const cols = platformColumns[platformFilter] || platformColumns.all;
                  const fixedCols = platformFilter ? 4 : 5; // Post, Link, Type, [Platform if no filter], Source
                  const totalCols = fixedCols + cols.length + 1 + (canDelete ? 1 : 0); // +1 for Published
                  return (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Post</TableHead>
                      <TableHead>Link</TableHead>
                      <TableHead>Type</TableHead>
                      {!platformFilter && <TableHead>Platform</TableHead>}
                      <TableHead>Source</TableHead>
                      {cols.map((col) => (
                        <TableHead key={col} className="text-right">{columnLabelsPerPlatform[platformFilter]?.[col] || columnLabels[col]}</TableHead>
                      ))}
                      <TableHead>Published</TableHead>
                      {canDelete && <TableHead></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {posts.map((post: any) => (
                      <React.Fragment key={post.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-accent/50"
                        onClick={() => setExpandedPostId(expandedPostId === post.id ? null : post.id)}
                      >
                        <TableCell className="max-w-[250px]">
                          <div className="flex items-center gap-1">
                            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform flex-shrink-0 ${expandedPostId === post.id ? "rotate-180" : ""}`} />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate" title={post.title}>{post.title}</p>
                              <p className="text-xs text-muted-foreground">@{post.account_name}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {post.permalink ? (
                            <a
                              href={post.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              View
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs flex items-center gap-1">
                            <span>{contentTypeIcons[post.content_type] || "📋"}</span>
                            {post.content_type}
                          </span>
                        </TableCell>
                        {!platformFilter && (
                          <TableCell>
                            <div>
                              <Badge variant="secondary" className={`text-xs ${platformColors[post.platform] || ""}`}>
                                {platformLabels[post.platform] || post.platform}
                              </Badge>
                              <p className="text-[10px] text-muted-foreground mt-0.5">@{post.account_name}</p>
                            </div>
                          </TableCell>
                        )}
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {sourceLabels[post.source] || post.source}
                          </span>
                        </TableCell>
                        {cols.map((col) => {
                          switch (col) {
                            case "views_impressions":
                              return <TableCell key={col} className="text-right font-medium">{(post.views || 0).toLocaleString()}</TableCell>;
                            case "reach":
                              return <TableCell key={col} className="text-right">{post.reach > 0 ? post.reach.toLocaleString() : "—"}</TableCell>;
                            case "likes":
                              return <TableCell key={col} className="text-right">{post.likes.toLocaleString()}</TableCell>;
                            case "comments":
                              return <TableCell key={col} className="text-right">{post.comments.toLocaleString()}</TableCell>;
                            case "shares":
                              return <TableCell key={col} className="text-right">{post.shares.toLocaleString()}</TableCell>;
                            case "saves":
                              return <TableCell key={col} className="text-right">{post.saves.toLocaleString()}</TableCell>;
                            case "watch_time":
                              return <TableCell key={col} className="text-right">{post.watch_time_seconds > 0 ? formatWatchTime(post.watch_time_seconds) : "—"}</TableCell>;
                            case "avg_duration":
                              return <TableCell key={col} className="text-right">{post.avg_view_duration > 0 ? formatWatchTime(post.avg_view_duration) : "—"}</TableCell>;
                            case "retention":
                              return <TableCell key={col} className="text-right">{post.retention_rate > 0 ? `${post.retention_rate}%` : "—"}</TableCell>;
                            case "engagement":
                              return (
                                <TableCell key={col} className="text-right">
                                  <Badge variant={post.engagement_rate > 5 ? "default" : "secondary"} className="text-xs">
                                    {post.engagement_rate}%
                                  </Badge>
                                </TableCell>
                              );
                            default:
                              return null;
                          }
                        })}
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {post.published_at
                            ? new Date(post.published_at).toLocaleDateString()
                            : "—"}
                        </TableCell>
                        {canDelete && (
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Delete this ${post.content_type}? Analytics data will be permanently removed.`)) {
                                  deleteMutation.mutate({ postId: post.id });
                                }
                              }}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                      {expandedPostId === post.id && (
                        <TableRow>
                          <TableCell colSpan={totalCols} className="bg-muted/30 p-4">
                            <PostProgressPanel postId={post.id} />
                          </TableCell>
                        </TableRow>
                      )}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
                  );
                })()}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
