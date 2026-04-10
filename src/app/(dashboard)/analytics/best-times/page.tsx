"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  Clock,
  Loader2,
  TrendingUp,
  RefreshCw,
  Sparkles,
  Database,
  AlertCircle,
  Zap,
} from "lucide-react";

const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_DAYS: Record<string, string> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed",
  Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  youtube: "bg-red-100 text-red-700 border-red-200",
  linkedin: "bg-blue-100 text-blue-700 border-blue-200",
  facebook: "bg-indigo-100 text-indigo-700 border-indigo-200",
  tiktok: "bg-gray-100 text-gray-900 border-gray-200",
  twitter: "bg-sky-100 text-sky-700 border-sky-200",
  snapchat: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn",
  facebook: "Facebook", tiktok: "TikTok", twitter: "X", snapchat: "Snapchat",
};

function formatTime(utcTime: string): string {
  // Convert "14:00" UTC to local display
  const [h, m] = utcTime.split(":").map(Number);
  const d = new Date();
  d.setUTCHours(h, m || 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function BestTimesPage() {
  const { activeBrandId, loading } = useBrand();

  const { data, isLoading, refetch } = trpc.analytics.getSmartBestTimes.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const refreshMutation = trpc.analytics.refreshTrendForecast.useMutation({
    onSuccess: () => {
      toast.success("Refreshing trend data — this may take a moment...");
      setTimeout(() => refetch(), 8000);
    },
    onError: (err) => toast.error(err.message),
  });

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

  const accounts = data?.accounts || [];
  const dataAccounts = accounts.filter((a: any) => a.source === "data");
  const aiAccounts = accounts.filter((a: any) => a.source === "ai");
  const noDataAccounts = accounts.filter((a: any) => a.source === "no_data");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Best Times to Post</h1>
          <p className="text-sm text-muted-foreground">
            Per-account recommendations based on your past performance
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            activeBrandId && refreshMutation.mutate({ brandId: activeBrandId });
          }}
          disabled={refreshMutation.isPending}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
          {refreshMutation.isPending ? "Analyzing..." : "Refresh"}
        </Button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-green-600" />
          Data-driven (from your posts)
        </span>
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          AI-suggested (no data yet)
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          Times shown in your local timezone
        </span>
      </div>

      {accounts.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No social accounts connected</p>
            <p className="text-sm mt-1">
              Connect accounts in the Accounts page to get posting recommendations.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Data-Driven Accounts */}
          {dataAccounts.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-green-600" />
                <h2 className="text-lg font-semibold">Based on Your Data</h2>
                <Badge variant="secondary" className="text-xs">
                  {dataAccounts.length} account{dataAccounts.length !== 1 ? "s" : ""}
                </Badge>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {dataAccounts.map((acc: any) => (
                  <AccountCard key={acc.accountId} account={acc} />
                ))}
              </div>
            </div>
          )}

          {/* AI-Suggested Accounts */}
          {aiAccounts.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                <h2 className="text-lg font-semibold">AI Suggested</h2>
                <Badge variant="secondary" className="text-xs">
                  {aiAccounts.length} account{aiAccounts.length !== 1 ? "s" : ""}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">
                Not enough past data — these are general recommendations. They'll become data-driven as you publish more.
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {aiAccounts.map((acc: any) => (
                  <AccountCard key={acc.accountId} account={acc} />
                ))}
              </div>
            </div>
          )}

          {/* No Data (LLM also unavailable) */}
          {noDataAccounts.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                <h2 className="text-lg font-semibold">Needs More Data</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {noDataAccounts.map((acc: any) => (
                  <Card key={acc.accountId} className="border-dashed">
                    <CardContent className="py-4 px-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className={`text-xs capitalize ${PLATFORM_COLORS[acc.platform] || ""}`}>
                          {PLATFORM_LABELS[acc.platform] || acc.platform}
                        </Badge>
                        <span className="text-sm font-medium">@{acc.username}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Publish a few posts to get personalized time recommendations. No AI provider configured for fallback.
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Account Card Component ───

function AccountCard({ account }: { account: any }) {
  const isData = account.source === "data";
  const bestTimes: any[] = account.bestTimes || [];

  // Find the single best slot for the highlight
  const topSlot = account.topSlot || (bestTimes.length > 0 ? bestTimes[0] : null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`text-xs capitalize ${PLATFORM_COLORS[account.platform] || ""}`}
            >
              {PLATFORM_LABELS[account.platform] || account.platform}
            </Badge>
            <span className="text-sm font-semibold">@{account.username}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {isData ? (
              <Badge variant="outline" className="text-[10px] gap-1 text-green-700 border-green-200 bg-green-50">
                <Database className="h-2.5 w-2.5" />
                {account.totalPosts} posts analyzed
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] gap-1 text-violet-700 border-violet-200 bg-violet-50">
                <Sparkles className="h-2.5 w-2.5" />
                AI suggested
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Top Slot Highlight */}
        {isData && topSlot && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/10">
            <Zap className="h-4 w-4 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Best: {topSlot.day} at {formatTime(topSlot.time)}
              </p>
              <p className="text-xs text-muted-foreground">
                {topSlot.avgEngagement}% avg engagement
                {topSlot.avgViews > 0 && ` · ~${topSlot.avgViews.toLocaleString()} views`}
              </p>
            </div>
          </div>
        )}

        {/* Time Slots */}
        {bestTimes.length > 0 ? (
          <div className="space-y-1.5">
            {bestTimes.map((bt: any, i: number) => (
              <div
                key={i}
                className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-8">
                    {SHORT_DAYS[bt.day] || bt.day}
                  </span>
                  <Badge variant="secondary" className="text-xs font-mono px-2">
                    <Clock className="h-2.5 w-2.5 mr-1" />
                    {formatTime(bt.time)}
                  </Badge>
                </div>

                <div className="flex items-center gap-2">
                  {isData && bt.boost > 0 && (
                    <span className="text-xs text-green-600 flex items-center gap-0.5 font-medium">
                      <TrendingUp className="h-3 w-3" />
                      +{bt.boost}%
                    </span>
                  )}
                  {isData && bt.postCount > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {bt.postCount} post{bt.postCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {!isData && bt.reason && (
                    <span className="text-[10px] text-muted-foreground max-w-[180px] truncate">
                      {bt.reason}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-2">
            No time recommendations available yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
