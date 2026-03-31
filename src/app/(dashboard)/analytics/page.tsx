"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import {
  BarChart3, Brain, Heart, Users, Eye, MessageSquare,
  Share2, TrendingUp, MousePointer, Clock,
} from "lucide-react";

const platformLabels: Record<string, string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  tiktok: "TikTok",
  twitter: "X",
  snapchat: "Snapchat",
};

export default function AnalyticsPage() {
  const { activeBrandId, loading } = useBrand();

  const { data: summary, isLoading: summaryLoading } = trpc.analytics.getSummary.useQuery(
    { brandId: activeBrandId! },
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

  function byPlatformMetric(metric: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [platform, data] of Object.entries(bp)) {
      const val = (data as any)?.[metric] || 0;
      if (val > 0) result[platform] = val;
    }
    return result;
  }

  function StatCard({ icon, label, value, sub }: {
    icon: React.ReactNode; label: string; value: string; sub?: Record<string, number>;
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
                  <span className="text-muted-foreground">{platformLabels[p] || p}</span>
                  <span className="font-medium">{typeof v === "number" ? v.toLocaleString() : v}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics Overview</h1>
        <p className="text-muted-foreground">Performance across all platforms</p>
      </div>

      {/* Post Analytics Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
              value={(total?.posts || 0).toLocaleString()}
              sub={byPlatformMetric("posts")}
            />
            <StatCard
              icon={<Eye className="h-4 w-4 text-muted-foreground" />}
              label="Total Views"
              value={(total?.views || 0).toLocaleString()}
              sub={byPlatformMetric("views")}
            />
            <StatCard
              icon={<Heart className="h-4 w-4 text-muted-foreground" />}
              label="Total Likes"
              value={(total?.likes || 0).toLocaleString()}
              sub={byPlatformMetric("likes")}
            />
            <StatCard
              icon={<MessageSquare className="h-4 w-4 text-muted-foreground" />}
              label="Total Comments"
              value={(total?.comments || 0).toLocaleString()}
              sub={byPlatformMetric("comments")}
            />
            <StatCard
              icon={<Share2 className="h-4 w-4 text-muted-foreground" />}
              label="Total Shares"
              value={(total?.shares || 0).toLocaleString()}
              sub={byPlatformMetric("shares")}
            />
            <StatCard
              icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
              label="Impressions"
              value={(total?.impressions || 0).toLocaleString()}
              sub={byPlatformMetric("impressions")}
            />
            <StatCard
              icon={<Users className="h-4 w-4 text-muted-foreground" />}
              label="Avg Engagement"
              value={`${total?.engagement || 0}%`}
              sub={Object.fromEntries(
                Object.entries(byPlatformMetric("engagement")).map(([k, v]) => [k, `${v}%` as any])
              )}
            />
            <StatCard
              icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              label="Avg Retention"
              value={`${total?.retention_rate || 0}%`}
              sub={Object.fromEntries(
                Object.entries(byPlatformMetric("retention_rate")).map(([k, v]) => [k, `${v}%` as any])
              )}
            />
          </>
        )}
      </div>

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
