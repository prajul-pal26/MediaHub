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
  BarChart3, Eye, Heart, MessageSquare, Share2, Users, Loader2,
  ChevronLeft, ChevronRight, Trash2, TrendingUp, MousePointer, ChevronDown, RefreshCw,
} from "lucide-react";

const platformColors: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-800",
  youtube: "bg-red-100 text-red-800",
  linkedin: "bg-blue-100 text-blue-800",
};

const platformLabels: Record<string, string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
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
const platformColumns: Record<string, string[]> = {
  all:       ["views_impressions", "reach", "likes", "comments", "shares", "saves", "engagement"],
  instagram: ["views_impressions", "reach", "likes", "comments", "shares", "saves", "engagement"],
  facebook:  ["views_impressions", "reach", "likes", "comments", "shares", "engagement"],
  youtube:   ["views_impressions", "likes", "comments", "shares", "engagement"],
  linkedin:  ["views_impressions", "likes", "comments", "shares", "engagement"],
  tiktok:    ["views_impressions", "likes", "comments", "shares", "engagement"],
  twitter:   ["views_impressions", "likes", "comments", "shares", "engagement"],
  snapchat:  ["views_impressions", "likes", "comments", "shares", "engagement"],
};

const columnLabels: Record<string, string> = {
  views_impressions: "Views / Impressions",
  reach: "Reach",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
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
  const total = summary?.total;
  const ba = summary?.byAccount || {};

  // Metrics that are NEVER available for certain platforms (show — in UI)
  const metricUnavailable: Record<string, string[]> = {
    saves: ["facebook", "linkedin", "youtube", "tiktok", "twitter"],
    reach: ["youtube"],
  };

  // Helper to extract a metric per account from getSummary (all posts, not just current page)
  function byAccountMetric(metric: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [accountKey, data] of Object.entries(ba)) {
      // accountKey format: "instagram/@username"
      const platform = accountKey.split("/")[0];

      // Skip accounts where this metric can never exist
      const checkMetric = metric === "_views_impressions" ? null : metric === "_count" ? null : metric;
      if (checkMetric && metricUnavailable[checkMetric]?.includes(platform)) continue;

      let val: number;
      if (metric === "_count") {
        val = (data as any)?.posts || 0;
      } else if (metric === "_views_impressions") {
        val = ((data as any)?.views || 0) + ((data as any)?.impressions || 0);
      } else {
        val = (data as any)?.[metric] || 0;
      }

      // Convert "instagram/@jerrylucas148" to "Instagram/@jerrylucas148"
      const [plat, ...rest] = accountKey.split("/");
      const label = `${platformLabels[plat] || plat}/${rest.join("/")}`;
      result[label] = val;
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

      {/* Summary Cards with platform breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {summaryLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3">
                <div className="h-7 w-16 bg-muted animate-pulse rounded mb-1" />
                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <StatCard
              icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
              label="Total Posts"
              total={postsData?.total || 0}
              byPlatform={byAccountMetric("_count")}
            />
            <StatCard
              icon={<Eye className="h-4 w-4 text-muted-foreground" />}
              label="Views / Impressions"
              total={(total?.views || 0) + (total?.impressions || 0)}
              byPlatform={byAccountMetric("_views_impressions")}
            />
            <StatCard
              icon={<Users className="h-4 w-4 text-muted-foreground" />}
              label="Reach"
              total={total?.reach || 0}
              byPlatform={byAccountMetric("reach")}
            />
            <StatCard
              icon={<Heart className="h-4 w-4 text-muted-foreground" />}
              label="Total Likes"
              total={total?.likes || 0}
              byPlatform={byAccountMetric("likes")}
            />
            <StatCard
              icon={<MessageSquare className="h-4 w-4 text-muted-foreground" />}
              label="Total Comments"
              total={total?.comments || 0}
              byPlatform={byAccountMetric("comments")}
            />
            <StatCard
              icon={<Share2 className="h-4 w-4 text-muted-foreground" />}
              label="Total Shares"
              total={total?.shares || 0}
              byPlatform={byAccountMetric("shares")}
            />
            <StatCard
              icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
              label="Total Saves"
              total={total?.saves || 0}
              byPlatform={byAccountMetric("saves")}
            />
            <StatCard
              icon={<MousePointer className="h-4 w-4 text-muted-foreground" />}
              label="Avg Engagement"
              total={total?.engagement || 0}
              byPlatform={byAccountMetric("engagement")}
              format={(n) => `${n}%`}
            />
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
                  const fixedCols = 5; // Post, Link, Type, Platform, Source
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
                        <TableHead key={col} className="text-right">{columnLabels[col]}</TableHead>
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
                              return <TableCell key={col} className="text-right font-medium">{(post.views || post.impressions || 0).toLocaleString()}</TableCell>;
                            case "reach":
                              return <TableCell key={col} className="text-right">{post.reach.toLocaleString()}</TableCell>;
                            case "likes":
                              return <TableCell key={col} className="text-right">{post.likes.toLocaleString()}</TableCell>;
                            case "comments":
                              return <TableCell key={col} className="text-right">{post.comments.toLocaleString()}</TableCell>;
                            case "shares":
                              return <TableCell key={col} className="text-right">{post.shares.toLocaleString()}</TableCell>;
                            case "saves":
                              return <TableCell key={col} className="text-right">{post.saves.toLocaleString()}</TableCell>;
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
