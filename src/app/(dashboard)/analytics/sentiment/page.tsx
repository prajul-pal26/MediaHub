"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { Heart, Loader2, MessageSquare, ShoppingCart } from "lucide-react";

function SentimentDonut({
  positive,
  negative,
  neutral,
}: {
  positive: number;
  negative: number;
  neutral: number;
}) {
  const total = positive + negative + neutral;
  if (total === 0) return null;

  const pPct = Math.round((positive / total) * 100);
  const nPct = Math.round((negative / total) * 100);
  const neuPct = 100 - pPct - nPct;

  return (
    <div className="flex items-center gap-6">
      {/* Simple bar chart representation */}
      <div className="flex-1 space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-green-700 font-medium">Positive</span>
            <span className="text-muted-foreground">{positive} ({pPct}%)</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${pPct}%` }}
            />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-red-700 font-medium">Negative</span>
            <span className="text-muted-foreground">{negative} ({nPct}%)</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full transition-all"
              style={{ width: `${nPct}%` }}
            />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700 font-medium">Neutral</span>
            <span className="text-muted-foreground">{neutral} ({neuPct}%)</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gray-400 rounded-full transition-all"
              style={{ width: `${neuPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Summary circle */}
      <div className="shrink-0 h-24 w-24 rounded-full border-4 border-green-500 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-bold">{total}</p>
          <p className="text-xs text-muted-foreground">Total</p>
        </div>
      </div>
    </div>
  );
}

export default function SentimentPage() {
  const { activeBrandId, loading } = useBrand();

  const { data: sentiment, isLoading } =
    trpc.analytics.getBrandSentiment.useQuery(
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
        <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Heart className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Create a brand to see sentiment analysis</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
          <p className="text-muted-foreground">Audience sentiment from comments and reactions</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const hasData =
    sentiment?.overall &&
    (sentiment.overall.positive > 0 ||
      sentiment.overall.negative > 0 ||
      sentiment.overall.neutral > 0);

  if (!hasData) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
          <p className="text-muted-foreground">Audience sentiment from comments and reactions</p>
        </div>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Heart className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No sentiment data</p>
            <p className="text-sm">
              Sentiment analysis runs daily on published posts.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
        <p className="text-muted-foreground">
          Audience sentiment from comments and reactions
        </p>
      </div>

      {/* Overall Sentiment */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Overall Sentiment</CardTitle>
        </CardHeader>
        <CardContent>
          <SentimentDonut
            positive={sentiment.overall.positive}
            negative={sentiment.overall.negative}
            neutral={sentiment.overall.neutral}
          />
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <ShoppingCart className="h-5 w-5 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">
                  {sentiment.purchaseIntentCount}
                </p>
                <p className="text-sm text-muted-foreground">
                  Purchase Intent Signals
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-orange-600" />
              <div>
                <p className="text-2xl font-bold">
                  {sentiment.questionsNeedingResponse}
                </p>
                <p className="text-sm text-muted-foreground">
                  Questions Needing Response
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-Post Sentiment */}
      {sentiment.posts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Per-Post Sentiment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sentiment.posts.map((post: any) => {
              const total = post.positive + post.negative + post.neutral;
              if (total === 0) return null;
              const pPct = Math.round((post.positive / total) * 100);
              const nPct = Math.round((post.negative / total) * 100);
              const neuPct = 100 - pPct - nPct;

              return (
                <div key={post.postId} className="space-y-1.5">
                  <p className="text-sm font-medium truncate">{post.title}</p>
                  <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
                    <div
                      className="bg-green-500"
                      style={{ width: `${pPct}%` }}
                    />
                    <div
                      className="bg-red-500"
                      style={{ width: `${nPct}%` }}
                    />
                    <div
                      className="bg-gray-400"
                      style={{ width: `${neuPct}%` }}
                    />
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span className="text-green-600">{post.positive} positive</span>
                    <span className="text-red-600">{post.negative} negative</span>
                    <span>{post.neutral} neutral</span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Top Themes */}
      {(sentiment.topThemes.positive.length > 0 ||
        sentiment.topThemes.negative.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sentiment.topThemes.positive.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-green-700">
                  Positive Themes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {sentiment.topThemes.positive.map((theme: any) => (
                    <Badge
                      key={theme}
                      variant="secondary"
                      className="bg-green-100 text-green-800"
                    >
                      {theme}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          {sentiment.topThemes.negative.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-red-700">
                  Negative Themes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {sentiment.topThemes.negative.map((theme: any) => (
                    <Badge
                      key={theme}
                      variant="secondary"
                      className="bg-red-100 text-red-800"
                    >
                      {theme}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
