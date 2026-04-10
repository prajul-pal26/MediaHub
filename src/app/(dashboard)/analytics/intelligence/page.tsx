"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { toast } from "sonner";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  AlertTriangle,
  Lightbulb,
  CalendarDays,
  Sparkles,
  Target,
  BarChart3,
  PieChart,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle,
  XCircle,
  RefreshCw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RPieChart,
  Pie,
  Cell,
} from "recharts";

type Period = "7d" | "30d" | "90d";

const CATEGORY_COLORS = [
  "#6366f1", "#ec4899", "#f59e0b", "#22c55e", "#3b82f6",
  "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#06b6d4",
  "#d946ef", "#84cc16",
];

const TONE_COLORS: Record<string, string> = {
  professional: "#3b82f6",
  casual: "#22c55e",
  humorous: "#f59e0b",
  inspirational: "#8b5cf6",
  educational: "#6366f1",
  urgent: "#ef4444",
  emotional: "#ec4899",
};

// ─── Helpers ───

function TrendIcon({ value }: { value: number | null }) {
  if (value === null) return <Minus className="h-4 w-4 text-gray-400" />;
  if (value > 0) return <ArrowUpRight className="h-4 w-4 text-green-600" />;
  if (value < 0) return <ArrowDownRight className="h-4 w-4 text-red-600" />;
  return <Minus className="h-4 w-4 text-gray-400" />;
}

function TrendBadge({ trend }: { trend: string }) {
  const config: Record<string, { bg: string; label: string; Icon: any }> = {
    rising: { bg: "bg-green-100 text-green-800", label: "Rising", Icon: TrendingUp },
    falling: { bg: "bg-red-100 text-red-800", label: "Falling", Icon: TrendingDown },
    stable: { bg: "bg-gray-100 text-gray-800", label: "Stable", Icon: Minus },
    declining: { bg: "bg-red-100 text-red-800", label: "Declining", Icon: TrendingDown },
  };
  const c = config[trend] || config.stable;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg}`}>
      <c.Icon className="h-3 w-3" />
      {c.label}
    </span>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color || entry.fill }} />
          <span>{entry.name || entry.dataKey}: {typeof entry.value === "number" ? entry.value.toLocaleString() : entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function AccuracyRing({ value, label }: { value: number | null; label: string }) {
  const pct = value ?? 0;
  const color = pct >= 70 ? "text-green-500" : pct >= 40 ? "text-amber-500" : "text-red-500";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-16 h-16">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/20" />
          <circle cx="50" cy="50" r="40" fill="none" strokeWidth="8" className={color}
            strokeDasharray={`${pct * 2.51} 251`} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold">{value !== null ? `${pct}%` : "—"}</span>
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground text-center">{label}</span>
    </div>
  );
}

// ─── Main Page ───

export default function IntelligencePage() {
  const { activeBrandId, loading } = useBrand();
  const [period, setPeriod] = useState<Period>("30d");
  const [strategyOpen, setStrategyOpen] = useState(false);

  const { data, isLoading, refetch } = trpc.analytics.getIntelligenceDashboard.useQuery(
    { brandId: activeBrandId!, period },
    { enabled: !!activeBrandId }
  );

  const strategyMutation = trpc.analytics.getContentStrategy.useMutation({
    onSuccess: () => setStrategyOpen(true),
    onError: (err) => toast.error(err.message),
  });

  const refreshMutation = trpc.analytics.refreshTrendForecast.useMutation({
    onSuccess: () => {
      toast.success("Refreshing intelligence data...");
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
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Brain className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Select a brand to see content intelligence</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const catPerf = data?.categoryPerformance || [];
  const mix = data?.contentMix || { toneDistribution: [], topTopics: [], categoryProportions: [], avgSentiment: null, totalPosts: 0 };
  const forecast = data?.forecast || { categories: [], topics: [], formats: [], snapshotDate: null };
  const recommendations = data?.recommendations || [];
  const contentGaps = data?.contentGaps || [];
  const weeklyPlan = data?.weeklyPlan || [];
  const accuracy = data?.predictionAccuracy || { avgViewsAccuracy: null, avgEngAccuracy: null, avgContentAccuracy: null, totalPredictions: 0 };
  const strategy = strategyMutation.data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Content Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            AI-powered insights from {mix.totalPosts} posts analyzed
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["7d", "30d", "90d"] as Period[]).map((p) => (
              <Button key={p} variant={period === p ? "default" : "outline"} size="sm" onClick={() => setPeriod(p)}>
                {p}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm"
            onClick={() => activeBrandId && refreshMutation.mutate({ brandId: activeBrandId })}
            disabled={refreshMutation.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm"
            onClick={() => activeBrandId && strategyMutation.mutate({ brandId: activeBrandId })}
            disabled={strategyMutation.isPending}>
            <Sparkles className={`h-4 w-4 mr-1.5 ${strategyMutation.isPending ? "animate-pulse" : ""}`} />
            {strategyMutation.isPending ? "Thinking..." : "AI Strategy"}
          </Button>
        </div>
      </div>

      {/* AI Strategy (shows after mutation) */}
      {strategyOpen && strategy && (
        <Card className="border-violet-200 bg-violet-50/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500" />
              AI Content Strategy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {strategy.strategySummary && (
              <p className="text-sm leading-relaxed">{strategy.strategySummary}</p>
            )}

            {/* Strengths & Weaknesses */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {strategy.strengths?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-green-700 flex items-center gap-1">
                    <CheckCircle className="h-3.5 w-3.5" /> Strengths
                  </p>
                  {strategy.strengths.map((s: string, i: number) => (
                    <p key={i} className="text-sm pl-5">- {s}</p>
                  ))}
                </div>
              )}
              {strategy.weaknesses?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-red-700 flex items-center gap-1">
                    <XCircle className="h-3.5 w-3.5" /> Weaknesses
                  </p>
                  {strategy.weaknesses.map((w: string, i: number) => (
                    <p key={i} className="text-sm pl-5">- {w}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Opportunities */}
            {strategy.opportunities?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Opportunities</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {strategy.opportunities.map((opp: any, i: number) => (
                    <div key={i} className="p-3 rounded-lg border bg-background">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{opp.title}</span>
                        <Badge variant={opp.priority === "high" ? "default" : "outline"} className="text-[10px]">
                          {opp.priority}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{opp.description}</p>
                      {opp.platform && opp.platform !== "all" && (
                        <Badge variant="secondary" className="text-[10px] mt-1.5 capitalize">{opp.platform}</Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Content Ideas */}
            {strategy.contentIdeas?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Content Ideas</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {strategy.contentIdeas.map((idea: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 p-2.5 rounded-lg border bg-background">
                      <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{idea.title}</p>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {idea.category && <Badge variant="secondary" className="text-[10px]">{idea.category}</Badge>}
                          {idea.platform && <Badge variant="outline" className="text-[10px] capitalize">{idea.platform}</Badge>}
                          {idea.format && <Badge variant="outline" className="text-[10px]">{idea.format}</Badge>}
                        </div>
                        {idea.whyItWorks && <p className="text-xs text-muted-foreground mt-1">{idea.whyItWorks}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tone Advice + Topic Gaps */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {strategy.toneAdvice && (
                <div className="p-3 rounded-lg border bg-background">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Tone Advice</p>
                  <p className="text-sm">{strategy.toneAdvice}</p>
                </div>
              )}
              {strategy.topicGaps?.length > 0 && (
                <div className="p-3 rounded-lg border bg-background">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Unexplored Topics</p>
                  <div className="flex flex-wrap gap-1.5">
                    {strategy.topicGaps.map((t: string, i: number) => (
                      <Badge key={i} variant="secondary" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Row 1: Category Performance + Prediction Accuracy */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Category Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {catPerf.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No category data yet. Publish content to see performance by category.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Posts</TableHead>
                    <TableHead className="text-right">Avg Views</TableHead>
                    <TableHead className="text-right">Avg Engagement</TableHead>
                    <TableHead className="text-right">AI Predicted</TableHead>
                    <TableHead className="text-right">Trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catPerf.map((cat: any) => (
                    <TableRow key={cat.category}>
                      <TableCell className="font-medium capitalize">{cat.category.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right">{cat.postCount}</TableCell>
                      <TableCell className="text-right">{(cat.avgViews ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right">{cat.avgEngagement ?? 0}%</TableCell>
                      <TableCell className="text-right">
                        {cat.avgPredictedScore !== null ? (
                          <span className="text-xs text-muted-foreground">{cat.avgPredictedScore}/100</span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <TrendIcon value={cat.trend} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Prediction Accuracy */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Target className="h-4 w-4" />
              AI Accuracy
            </CardTitle>
          </CardHeader>
          <CardContent>
            {accuracy.totalPredictions === 0 && accuracy.avgContentAccuracy === null ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No predictions to evaluate yet.
              </p>
            ) : (
              <div className="flex flex-wrap justify-center gap-4">
                <AccuracyRing value={accuracy.avgViewsAccuracy} label="Views" />
                <AccuracyRing value={accuracy.avgEngAccuracy} label="Engagement" />
                <AccuracyRing value={accuracy.avgContentAccuracy} label="Content" />
              </div>
            )}
            {accuracy.totalPredictions > 0 && (
              <p className="text-[10px] text-muted-foreground text-center mt-3">
                Based on {accuracy.totalPredictions} prediction{accuracy.totalPredictions !== 1 ? "s" : ""}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Content Mix — Tone + Topics + Category Proportions */}
      {mix.totalPosts > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Tone Distribution */}
          {mix.toneDistribution.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Tone Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <RPieChart>
                    <Pie data={mix.toneDistribution} dataKey="count" nameKey="tone" cx="50%" cy="50%"
                      outerRadius={70} innerRadius={35} paddingAngle={2}>
                      {mix.toneDistribution.map((entry: any, i: number) => (
                        <Cell key={i} fill={TONE_COLORS[entry.tone] || CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </RPieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                  {mix.toneDistribution.map((t: any, i: number) => (
                    <div key={i} className="flex items-center gap-1 text-[10px]">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: TONE_COLORS[t.tone] || CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                      <span className="capitalize">{t.tone} ({t.count})</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Top Topics */}
          {mix.topTopics.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Top Topics</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={mix.topTopics.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/20" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="topic" tick={{ fontSize: 10 }} width={80} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} name="Posts" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Category Proportions */}
          {mix.categoryProportions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Content Mix</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <RPieChart>
                    <Pie data={mix.categoryProportions} dataKey="count" nameKey="category" cx="50%" cy="50%"
                      outerRadius={70} innerRadius={35} paddingAngle={2}>
                      {mix.categoryProportions.map((_: any, i: number) => (
                        <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </RPieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                  {mix.categoryProportions.map((c: any, i: number) => (
                    <div key={i} className="flex items-center gap-1 text-[10px]">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                      <span className="capitalize">{c.category.replace(/_/g, " ")} ({c.count})</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Row 3: Trend Forecast */}
      {(forecast.categories.length > 0 || forecast.topics.length > 0 || forecast.formats.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Trend Forecast
              </CardTitle>
              {forecast.snapshotDate && (
                <span className="text-[10px] text-muted-foreground">
                  Updated: {new Date(forecast.snapshotDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={forecast.categories.length > 0 ? "categories" : forecast.topics.length > 0 ? "topics" : "formats"}>
              <TabsList>
                {forecast.categories.length > 0 && <TabsTrigger value="categories">Categories</TabsTrigger>}
                {forecast.topics.length > 0 && <TabsTrigger value="topics">Topics</TabsTrigger>}
                {forecast.formats.length > 0 && <TabsTrigger value="formats">Formats</TabsTrigger>}
              </TabsList>

              {forecast.categories.length > 0 && (
                <TabsContent value="categories" className="mt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {forecast.categories.map((item: any, i: number) => (
                      <div key={i} className="p-3 rounded-lg border bg-card">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium capitalize">{item.name.replace(/_/g, " ")}</span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        {item.score > 0 && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${item.score}%` }} />
                            </div>
                            <span className="text-[10px] text-muted-foreground">{item.score}/100</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </TabsContent>
              )}

              {forecast.topics.length > 0 && (
                <TabsContent value="topics" className="mt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {forecast.topics.map((item: any, i: number) => (
                      <div key={i} className="p-3 rounded-lg border bg-card">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{item.name}</span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        {item.score > 0 && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-violet-500 rounded-full" style={{ width: `${item.score}%` }} />
                            </div>
                            <span className="text-[10px] text-muted-foreground">{item.score}/100</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </TabsContent>
              )}

              {forecast.formats.length > 0 && (
                <TabsContent value="formats" className="mt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {forecast.formats.map((item: any, i: number) => (
                      <div key={i} className="p-3 rounded-lg border bg-card">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">{item.name}</span>
                          <TrendBadge trend={item.trend} />
                        </div>
                        {item.recommendation && (
                          <p className="text-xs text-muted-foreground">{item.recommendation}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Row 4: Content Recommendations + Content Gaps side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recommendations */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Lightbulb className="h-5 w-5" />
              Content Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No recommendations yet. Publish content to receive AI suggestions.
              </p>
            ) : (
              <div className="space-y-2">
                {recommendations.map((rec: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
                    <Zap className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <p className="text-sm">{typeof rec === "string" ? rec : rec.text || rec.title || JSON.stringify(rec)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Content Gaps */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Content Gaps
            </CardTitle>
          </CardHeader>
          <CardContent>
            {contentGaps.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No gaps identified yet.
              </p>
            ) : (
              <div className="space-y-2">
                {contentGaps.map((gap: any, i: number) => (
                  <div key={i} className="p-2.5 rounded-lg bg-amber-50 border border-amber-200">
                    <p className="text-sm text-amber-900">
                      {typeof gap === "string" ? gap : gap.text || gap.title || JSON.stringify(gap)}
                    </p>
                    {gap.description && (
                      <p className="text-xs text-amber-700 mt-0.5">{gap.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 5: Weekly Content Plan */}
      {weeklyPlan.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Weekly Content Plan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>Best Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeklyPlan.map((item: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{item.day}</TableCell>
                    <TableCell className="capitalize">{item.platform}</TableCell>
                    <TableCell>{item.content_type || item.format}</TableCell>
                    <TableCell>{item.topic}</TableCell>
                    <TableCell className="text-xs font-mono">{item.best_time || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
