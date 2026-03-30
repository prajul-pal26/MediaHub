"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { BarChart3 } from "lucide-react";

export default function AnalyticsPage() {
  const { activeBrandId, loading } = useBrand();

  const { data: stats, isLoading: statsLoading } = trpc.media.getStats.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const { data: jobStats, isLoading: jobStatsLoading } = trpc.jobs.getStats.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const cardsLoading = statsLoading || jobStatsLoading;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics Overview</h1>
        <p className="text-muted-foreground">Performance across all platforms</p>
      </div>

      {/* Content stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cardsLoading ? (
          <>
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="pt-5 space-y-2">
                  <div className="h-8 w-16 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-5">
                <p className="text-2xl font-bold">{stats?.total ?? 0}</p>
                <p className="text-sm text-muted-foreground">Total Media</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-2xl font-bold">{stats?.published ?? 0}</p>
                <p className="text-sm text-muted-foreground">Published</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-2xl font-bold">{stats?.scheduled ?? 0}</p>
                <p className="text-sm text-muted-foreground">Scheduled</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-2xl font-bold">{jobStats?.completed ?? 0}</p>
                <p className="text-sm text-muted-foreground">Jobs Completed</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Placeholder for charts */}
      <Card>
        <CardHeader>
          <CardTitle>Engagement Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-48 border-2 border-dashed rounded-lg">
            <div className="text-center text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">Analytics charts</p>
              <p className="text-sm">Detailed engagement charts will appear after publishing content</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
