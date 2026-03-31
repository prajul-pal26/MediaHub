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
import { trpc } from "@/lib/trpc/client";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  AlertTriangle,
  Lightbulb,
  CalendarDays,
} from "lucide-react";

type Period = "7d" | "30d" | "90d";

function TrendIcon({ trend }: { trend: "rising" | "falling" | "stable" }) {
  if (trend === "rising") return <TrendingUp className="h-4 w-4 text-green-600" />;
  if (trend === "falling") return <TrendingDown className="h-4 w-4 text-red-600" />;
  return <Minus className="h-4 w-4 text-gray-500" />;
}

function TrendBadge({ trend }: { trend: "rising" | "falling" | "stable" }) {
  const variants: Record<string, string> = {
    rising: "bg-green-100 text-green-800",
    falling: "bg-red-100 text-red-800",
    stable: "bg-gray-100 text-gray-800",
  };
  const labels: Record<string, string> = {
    rising: "Rising",
    falling: "Falling",
    stable: "Stable",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${variants[trend]}`}>
      <TrendIcon trend={trend} />
      {labels[trend]}
    </span>
  );
}

export default function IntelligencePage() {
  const { activeBrandId, loading } = useBrand();
  const [period, setPeriod] = useState<Period>("30d");

  const { data: categories, isLoading: catLoading } =
    trpc.analytics.getCategoryBreakdown.useQuery(
      { brandId: activeBrandId!, period },
      { enabled: !!activeBrandId }
    );

  const { data: forecast, isLoading: forecastLoading } =
    trpc.analytics.getTrendForecast.useQuery(
      { brandId: activeBrandId! },
      { enabled: !!activeBrandId }
    );

  const { data: recommendations, isLoading: recLoading } =
    trpc.analytics.getContentRecommendations.useQuery(
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
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Brain className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Create a brand to see content intelligence</p>
          </div>
        </div>
      </div>
    );
  }

  const allLoading = catLoading || forecastLoading || recLoading;

  // Safe defaults for nested data
  const safeCategories = categories || [];
  const safeForecast = {
    categories: forecast?.categories || [],
    topics: forecast?.topics || [],
    formats: forecast?.formats || [],
  };
  const safeRecommendations = {
    recommendations: recommendations?.recommendations || [],
    weekly_plan: recommendations?.weekly_plan || [],
    content_gaps: recommendations?.content_gaps || [],
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <p className="text-muted-foreground">
          AI-powered insights for your content strategy
        </p>
      </div>

      {/* Section 1: Category Performance */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Content Category Performance</CardTitle>
            <div className="flex gap-1">
              {(["7d", "30d", "90d"] as Period[]).map((p) => (
                <Button
                  key={p}
                  variant={period === p ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPeriod(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {catLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : safeCategories.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">
                No category data yet. Publish content with tags to see category
                performance.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Posts</TableHead>
                  <TableHead className="text-right">Avg Views</TableHead>
                  <TableHead className="text-right">Avg Engagement</TableHead>
                  <TableHead className="text-right">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {safeCategories.map((cat) => (
                  <TableRow key={cat.category}>
                    <TableCell className="font-medium">{cat.category}</TableCell>
                    <TableCell className="text-right">{cat.post_count}</TableCell>
                    <TableCell className="text-right">
                      {cat.avg_views.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {cat.avg_engagement}%
                    </TableCell>
                    <TableCell className="text-right">
                      <TrendIcon trend={cat.trend !== null && cat.trend > 0 ? "rising" : cat.trend !== null && cat.trend < 0 ? "falling" : "stable"} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Trend Forecast */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Trend Forecast</CardTitle>
        </CardHeader>
        <CardContent>
          {forecastLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !forecast ||
            (safeForecast.categories.length === 0 &&
              safeForecast.topics.length === 0 &&
              safeForecast.formats.length === 0) ? (
            <div className="text-center py-8 text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">
                No trend data yet. Trends are generated after enough content is
                published and analyzed.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {safeForecast.categories.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Categories</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {safeForecast.categories.map((item: any) => (
                      <div
                        key={item.name}
                        className="p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">
                            {item.name}
                          </span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {item.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {safeForecast.topics.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Topics</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {safeForecast.topics.map((item: any) => (
                      <div
                        key={item.name}
                        className="p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">
                            {item.name}
                          </span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {item.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {safeForecast.formats.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Formats</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {safeForecast.formats.map((item: any) => (
                      <div
                        key={item.name}
                        className="p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">
                            {item.name}
                          </span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {item.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Content Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Content Recommendations</CardTitle>
        </CardHeader>
        <CardContent>
          {recLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !recommendations ||
            safeRecommendations.recommendations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Lightbulb className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">
                No recommendations yet. Publish more content to receive
                AI-powered suggestions.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {safeRecommendations.recommendations.map((rec: any, i: any) => (
                <div key={i} className="p-4 rounded-lg border bg-card space-y-2">
                  <div className="flex items-start justify-between">
                    <h4 className="text-sm font-semibold">{rec.title}</h4>
                    <Badge variant="outline" className="text-xs shrink-0 ml-2">
                      {rec.category}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="capitalize">{rec.platform}</span>
                    <span>&middot;</span>
                    <span>{rec.tone}</span>
                    <span>&middot;</span>
                    <span>{rec.suggestedTime}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{rec.reason}</p>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs font-medium">
                      ~{rec.predictedViews.toLocaleString()} predicted views
                    </span>
                    <Button size="sm" variant="outline" disabled>
                      <CalendarDays className="h-3 w-3 mr-1" />
                      Add to Calendar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 4: Weekly Content Plan */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Weekly Content Plan</CardTitle>
        </CardHeader>
        <CardContent>
          {recLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !recommendations ||
            safeRecommendations.weekly_plan.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">
                No weekly plan generated yet. Plans appear after the AI analyzes
                your content patterns.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Topic</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {safeRecommendations.weekly_plan.map((item: any, i: any) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{item.day}</TableCell>
                    <TableCell className="capitalize">{item.platform}</TableCell>
                    <TableCell>{item.format}</TableCell>
                    <TableCell>{item.category}</TableCell>
                    <TableCell>{item.topic}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Section 5: Content Gaps */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Content Gaps</CardTitle>
        </CardHeader>
        <CardContent>
          {recLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !recommendations ||
            safeRecommendations.content_gaps.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">
                No content gaps identified. Keep publishing to get insights on
                what you might be missing.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {safeRecommendations.content_gaps.map((gap: any, i: any) => (
                <div
                  key={i}
                  className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg"
                >
                  <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-900">
                      {gap.title}
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {gap.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
