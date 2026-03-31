"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBrand } from "@/lib/hooks/use-brand";
import { useUser } from "@/lib/hooks/use-user";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  BarChart3,
  Eye,
  Heart,
  MessageSquare,
  Share2,
  Bookmark,
  Users,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "lucide-react";

const platformColors: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-800",
  youtube: "bg-red-100 text-red-800",
  linkedin: "bg-blue-100 text-blue-800",
};

const sourceLabels: Record<string, string> = {
  click: "Published",
  chat: "Via Chat",
  api: "Imported",
};

const contentTypeIcons: Record<string, string> = {
  "Image Post": "🖼️",
  "Reel": "🎬",
  "Story": "📱",
  "Carousel": "🎠",
  "Video": "🎥",
  "Short": "⚡",
  "Post": "📝",
  "Article": "📄",
};

export default function PostAnalyticsPage() {
  const { activeBrandId, loading } = useBrand();
  const { profile } = useUser();
  const [page, setPage] = useState(1);
  const utils = trpc.useUtils();

  const canDelete = profile && ["super_admin", "agency_admin", "brand_owner"].includes(profile.role);

  const deleteMutation = trpc.analytics.deletePost.useMutation({
    onSuccess: () => {
      toast.success("Post deleted");
      utils.analytics.getPostAnalytics.invalidate();
      utils.analytics.getSummary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const { data: summary, isLoading: summaryLoading } =
    trpc.analytics.getSummary.useQuery(
      { brandId: activeBrandId! },
      { enabled: !!activeBrandId }
    );

  const { data: postsData, isLoading: postsLoading } =
    trpc.analytics.getPostAnalytics.useQuery(
      { brandId: activeBrandId!, page, limit: 20 },
      { enabled: !!activeBrandId }
    );

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Post Analytics</h1>
        <p className="text-muted-foreground">
          Performance metrics for all published and imported posts
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {summaryLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3">
                <div className="h-7 w-16 bg-muted animate-pulse rounded mb-1" />
                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Eye className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-bold">{(summary?.total_views || 0).toLocaleString()}</p>
                </div>
                <p className="text-xs text-muted-foreground">Total Views</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Heart className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-bold">{(summary?.total_likes || 0).toLocaleString()}</p>
                </div>
                <p className="text-xs text-muted-foreground">Total Likes</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-bold">{(summary?.total_comments || 0).toLocaleString()}</p>
                </div>
                <p className="text-xs text-muted-foreground">Total Comments</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Share2 className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-bold">{(summary?.total_shares || 0).toLocaleString()}</p>
                </div>
                <p className="text-xs text-muted-foreground">Total Shares</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xl font-bold">{summary?.avg_engagement || 0}%</p>
                </div>
                <p className="text-xs text-muted-foreground">Avg Engagement</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Posts Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">
            All Posts ({postsData?.total || 0})
          </CardTitle>
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
              <p className="text-sm">Connect a social account and publish or import content to see analytics</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Post</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Likes</TableHead>
                    <TableHead className="text-right">Comments</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead className="text-right">Engagement</TableHead>
                    <TableHead>Published</TableHead>
                    {canDelete && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {posts.map((post: any) => (
                    <TableRow key={post.id}>
                      <TableCell className="max-w-[200px]">
                        <p className="text-sm font-medium truncate">{post.title}</p>
                        <p className="text-xs text-muted-foreground">@{post.account_name}</p>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs flex items-center gap-1">
                          <span>{contentTypeIcons[post.content_type] || "📋"}</span>
                          {post.content_type}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={`text-xs ${platformColors[post.platform] || ""}`}>
                          {post.platform}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {sourceLabels[post.source] || post.source}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-medium">{post.views.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{post.likes.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{post.comments.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{post.shares.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={post.engagement_rate > 5 ? "default" : "secondary"} className="text-xs">
                          {post.engagement_rate}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
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
                            onClick={() => {
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
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                    >
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
