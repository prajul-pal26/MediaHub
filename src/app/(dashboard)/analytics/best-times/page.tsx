"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { Clock, Loader2, Calendar, TrendingUp, FileText } from "lucide-react";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  youtube: "bg-red-100 text-red-700 border-red-200",
  linkedin: "bg-blue-100 text-blue-700 border-blue-200",
  facebook: "bg-indigo-100 text-indigo-700 border-indigo-200",
  tiktok: "bg-gray-100 text-gray-900 border-gray-200",
  twitter: "bg-sky-100 text-sky-700 border-sky-200",
  snapchat: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

export default function BestTimesPage() {
  const { activeBrandId, loading } = useBrand();

  const { data, isLoading } = trpc.analytics.getBestPostingTimes.useQuery(
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

  if (!activeBrandId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Best Times to Post</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Select a brand to see posting time recommendations</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Best Times to Post</h1>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const platforms = data?.platforms || [];
  const draftMedia = data?.draftMedia || [];
  const hasData = platforms.some((p: any) => (p.bestPostingTimes as any[]).length > 0);

  // Merge best times across platforms into a weekly grid
  const weeklyGrid: Record<string, { platform: string; times: string[]; reason: string; boost: number }[]> = {};
  for (const day of DAYS) weeklyGrid[day] = [];

  for (const p of platforms) {
    for (const bt of p.bestPostingTimes as any[]) {
      const day = bt.day;
      if (day && weeklyGrid[day]) {
        weeklyGrid[day].push({
          platform: bt.platform || p.platform,
          times: bt.times || [],
          reason: bt.reason || "",
          boost: bt.expected_engagement_boost || 0,
        });
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Best Times to Post</h1>
        <p className="text-muted-foreground">
          AI-powered posting schedule based on your historical performance
        </p>
      </div>

      {!hasData ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No posting time data yet</p>
            <p className="text-sm">
              Recommendations are generated weekly after publishing content.
              Keep posting to get personalized time suggestions.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Weekly Schedule Grid */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Weekly Posting Schedule
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {DAYS.map((day) => {
                  const slots = weeklyGrid[day];
                  if (slots.length === 0) return null;

                  return (
                    <div key={day} className="flex items-start gap-4 p-3 rounded-lg border bg-card">
                      <div className="w-24 flex-shrink-0">
                        <p className="font-semibold text-sm">{day}</p>
                      </div>
                      <div className="flex-1 space-y-2">
                        {slots.map((slot, i) => (
                          <div key={i} className="flex items-center gap-2 flex-wrap">
                            <Badge
                              variant="outline"
                              className={`text-xs capitalize ${PLATFORM_COLORS[slot.platform] || ""}`}
                            >
                              {slot.platform}
                            </Badge>
                            {slot.times.map((time) => (
                              <Badge key={time} variant="secondary" className="text-xs font-mono">
                                <Clock className="h-2.5 w-2.5 mr-1" />
                                {time}
                              </Badge>
                            ))}
                            {slot.boost > 0 && (
                              <span className="text-xs text-green-600 flex items-center gap-0.5">
                                <TrendingUp className="h-3 w-3" />
                                +{slot.boost}% engagement
                              </span>
                            )}
                            {slot.reason && (
                              <span className="text-xs text-muted-foreground">{slot.reason}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Per-Platform Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {platforms
              .filter((p: any) => (p.bestPostingTimes as any[]).length > 0)
              .map((p: any) => (
                <Card key={p.platform}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm capitalize flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`${PLATFORM_COLORS[p.platform] || ""}`}
                      >
                        {p.platform}
                      </Badge>
                      Best Times
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {(p.bestPostingTimes as any[]).map((bt: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span className="font-medium">{bt.day}</span>
                          <div className="flex gap-1">
                            {(bt.times || []).map((t: string) => (
                              <Badge key={t} variant="secondary" className="text-xs font-mono">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-3">
                      Updated: {p.snapshotDate ? new Date(p.snapshotDate).toLocaleDateString() : "Never"}
                    </p>
                  </CardContent>
                </Card>
              ))}
          </div>
        </>
      )}

      {/* Draft Media Ready to Publish */}
      {draftMedia.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Draft Media Ready to Publish
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              These media groups are ready. Use the recommended times above to schedule them for maximum engagement.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {draftMedia.map((media: any) => (
                <a
                  key={media.id}
                  href={`/publish/${media.id}`}
                  className="p-3 rounded-lg border hover:bg-accent transition-colors"
                >
                  <p className="text-sm font-medium truncate">{media.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {media.variants} variant{media.variants !== 1 ? "s" : ""}
                  </p>
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
