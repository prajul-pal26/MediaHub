"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  Heart,
  Loader2,
  ShoppingCart,
  Sparkles,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  HelpCircle,
  TrendingUp,
  Minus,
  Eye,
  Mail,
  Reply,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn",
  facebook: "Facebook", tiktok: "TikTok", twitter: "X", snapchat: "Snapchat",
};

const PLATFORM_BADGE_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  youtube: "bg-red-100 text-red-700 border-red-200",
  linkedin: "bg-blue-100 text-blue-700 border-blue-200",
  facebook: "bg-indigo-100 text-indigo-700 border-indigo-200",
  tiktok: "bg-gray-100 text-gray-900 border-gray-200",
  twitter: "bg-sky-100 text-sky-700 border-sky-200",
  snapchat: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

const SENTIMENT_ICONS: Record<string, any> = {
  positive: ThumbsUp,
  negative: ThumbsDown,
  neutral: Minus,
  question: HelpCircle,
  mixed: AlertTriangle,
};

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "text-green-600",
  negative: "text-red-600",
  neutral: "text-gray-500",
  question: "text-amber-600",
};

// ─── Score Gauge ───

function ScoreGauge({ score }: { score: number }) {
  // score is -1 to 1
  const pct = Math.round(((score + 1) / 2) * 100);
  const label = score > 0.3 ? "Positive" : score < -0.3 ? "Negative" : "Neutral";
  const color = score > 0.3 ? "text-green-600" : score < -0.3 ? "text-red-600" : "text-gray-600";
  const bg = score > 0.3 ? "bg-green-500" : score < -0.3 ? "bg-red-500" : "bg-gray-400";

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-28 h-28">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/30" />
          <circle
            cx="50" cy="50" r="42" fill="none" strokeWidth="8"
            className={bg.replace("bg-", "text-")}
            strokeDasharray={`${pct * 2.64} 264`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className={`text-xl font-bold ${color}`}>{score > 0 ? "+" : ""}{score.toFixed(2)}</p>
          </div>
        </div>
      </div>
      <p className={`text-sm font-medium ${color}`}>{label}</p>
    </div>
  );
}

// ─── Sentiment Bar ───

function SentimentBar({ positive, negative, neutral }: { positive: number; negative: number; neutral: number }) {
  const total = positive + negative + neutral;
  if (total === 0) return <div className="h-2 bg-muted rounded-full" />;

  const pPct = (positive / total) * 100;
  const nPct = (negative / total) * 100;
  const neuPct = 100 - pPct - nPct;

  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100">
      {pPct > 0 && <div className="bg-green-500 transition-all" style={{ width: `${pPct}%` }} />}
      {neuPct > 0 && <div className="bg-gray-300 transition-all" style={{ width: `${neuPct}%` }} />}
      {nPct > 0 && <div className="bg-red-500 transition-all" style={{ width: `${nPct}%` }} />}
    </div>
  );
}

// ─── Comment Card ───

function CommentCard({ comment, type }: { comment: any; type: "liked" | "question" | "negative" }) {
  const Icon = type === "liked" ? ThumbsUp : type === "question" ? HelpCircle : ThumbsDown;
  const iconColor = type === "liked" ? "text-blue-500" : type === "question" ? "text-amber-500" : "text-red-500";

  return (
    <div className="flex gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
      <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium">@{comment.author}</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${PLATFORM_BADGE_COLORS[comment.platform] || ""}`}>
            {PLATFORM_LABELS[comment.platform] || comment.platform}
          </Badge>
          {comment.likes > 0 && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
              <ThumbsUp className="h-2.5 w-2.5" /> {comment.likes}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{comment.text}</p>
      </div>
    </div>
  );
}

// ─── Custom Tooltip ───

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="capitalize">{entry.name}: {entry.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ───

export default function SentimentPage() {
  const { activeBrandId, loading } = useBrand();
  const [insightsOpen, setInsightsOpen] = useState(false);

  const { data, isLoading } = trpc.analytics.getDetailedSentiment.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const insightsMutation = trpc.analytics.getSentimentInsights.useMutation({
    onSuccess: () => setInsightsOpen(true),
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
        <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Heart className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Select a brand to see sentiment analysis</p>
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

  const overall = data?.overall || { positive: 0, negative: 0, neutral: 0 };
  const totalComments = overall.positive + overall.negative + overall.neutral;
  const hasData = totalComments > 0;
  const avgScore = data?.avgScore || 0;
  const platforms = data?.platformBreakdown || [];
  const accountData = data?.accountBreakdown || [];
  const trend = data?.trend || [];
  const notable = data?.notable || { topLiked: [], recentQuestions: [], recentNegative: [] };
  const commentStats = data?.commentStats || { total: 0, unread: 0, replied: 0, flagged: 0 };
  const posts = data?.posts || [];
  const themes = data?.topThemes || { positive: [], negative: [] };
  const insights = insightsMutation.data;

  if (!hasData && commentStats.total === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
          <p className="text-muted-foreground">Audience sentiment from comments and reactions</p>
        </div>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Heart className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No sentiment data yet</p>
            <p className="text-sm">Sentiment analysis runs daily on published posts with comments.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sentiment Analysis</h1>
          <p className="text-sm text-muted-foreground">
            Audience sentiment from {commentStats.total.toLocaleString()} comments across your platforms
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => activeBrandId && insightsMutation.mutate({ brandId: activeBrandId })}
          disabled={insightsMutation.isPending}
        >
          <Sparkles className={`h-4 w-4 mr-2 ${insightsMutation.isPending ? "animate-pulse" : ""}`} />
          {insightsMutation.isPending ? "Analyzing..." : "AI Insights"}
        </Button>
      </div>

      {/* AI Insights (shows after mutation) */}
      {insightsOpen && insights && (
        <Card className="border-violet-200 bg-violet-50/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500" />
              AI Insights
              {insights.audiencePersonality && (
                <Badge variant="secondary" className="text-xs font-normal ml-auto">
                  {insights.audiencePersonality}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {insights.moodSummary && (
              <p className="text-sm leading-relaxed">{insights.moodSummary}</p>
            )}

            {insights.insights?.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {insights.insights.map((insight: any, i: number) => {
                  const typeIcon = insight.type === "strength" ? TrendingUp : insight.type === "concern" ? AlertTriangle : Eye;
                  const TypeIcon = typeIcon;
                  const typeColor = insight.type === "strength" ? "text-green-600" : insight.type === "concern" ? "text-red-600" : "text-blue-600";

                  return (
                    <div key={i} className="p-3 rounded-lg border bg-background">
                      <div className="flex items-center gap-2 mb-1">
                        <TypeIcon className={`h-3.5 w-3.5 ${typeColor}`} />
                        <span className="text-sm font-medium">{insight.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{insight.description}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {insights.contentAdvice?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Content Tips</p>
                <div className="space-y-1.5">
                  {insights.contentAdvice.map((tip: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span className="text-violet-500 mt-0.5">-</span>
                      <span>{tip}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Top Row: Score + Overall + Comment Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Score Gauge */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Sentiment Score</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            <ScoreGauge score={avgScore} />
          </CardContent>
        </Card>

        {/* Overall Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Overall Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "Positive", count: overall.positive, color: "bg-green-500", textColor: "text-green-700" },
              { label: "Negative", count: overall.negative, color: "bg-red-500", textColor: "text-red-700" },
              { label: "Neutral", count: overall.neutral, color: "bg-gray-400", textColor: "text-gray-700" },
            ].map(({ label, count, color, textColor }) => {
              const pct = totalComments > 0 ? Math.round((count / totalComments) * 100) : 0;
              return (
                <div key={label} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className={`font-medium ${textColor}`}>{label}</span>
                    <span className="text-muted-foreground">{count} ({pct}%)</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Comment Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 text-blue-600" />
                <div>
                  <p className="text-lg font-bold">{data?.purchaseIntentCount || 0}</p>
                  <p className="text-[10px] text-muted-foreground">Purchase Intent</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-amber-600" />
                <div>
                  <p className="text-lg font-bold">{data?.questionsCount || 0}</p>
                  <p className="text-[10px] text-muted-foreground">Questions</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-orange-500" />
                <div>
                  <p className="text-lg font-bold">{commentStats.unread}</p>
                  <p className="text-[10px] text-muted-foreground">Unread</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Reply className="h-4 w-4 text-green-600" />
                <div>
                  <p className="text-lg font-bold">{commentStats.replied}</p>
                  <p className="text-[10px] text-muted-foreground">Replied</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sentiment Trend */}
      {trend.length > 1 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Weekly Sentiment Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => {
                    const d = new Date(v);
                    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
                  }}
                />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="positive" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.4} name="Positive" />
                <Area type="monotone" dataKey="neutral" stackId="1" stroke="#9ca3af" fill="#9ca3af" fillOpacity={0.2} name="Neutral" />
                <Area type="monotone" dataKey="negative" stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} name="Negative" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Platform & Account Breakdown */}
      {(platforms.length > 0 || accountData.length > 0) && (
        <Tabs defaultValue="platform">
          <TabsList>
            <TabsTrigger value="platform">By Platform</TabsTrigger>
            <TabsTrigger value="account">By Account</TabsTrigger>
          </TabsList>

          <TabsContent value="platform" className="mt-4">
            {platforms.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {platforms.map((p: any) => {
                  const total = p.positive + p.negative + p.neutral + p.question;
                  const positiveRate = total > 0 ? Math.round((p.positive / total) * 100) : 0;
                  return (
                    <Card key={p.platform}>
                      <CardContent className="pt-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <Badge variant="outline" className={`capitalize ${PLATFORM_BADGE_COLORS[p.platform] || ""}`}>
                            {PLATFORM_LABELS[p.platform] || p.platform}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{total} comments</span>
                        </div>
                        <SentimentBar positive={p.positive} negative={p.negative} neutral={p.neutral + p.question} />
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span className="text-green-600">{p.positive} positive</span>
                          <span className="text-red-600">{p.negative} negative</span>
                          <span>{p.neutral + p.question} other</span>
                        </div>
                        <div className="text-center">
                          <p className={`text-2xl font-bold ${positiveRate >= 60 ? "text-green-600" : positiveRate <= 30 ? "text-red-600" : "text-gray-600"}`}>
                            {positiveRate}%
                          </p>
                          <p className="text-[10px] text-muted-foreground">positive rate</p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No platform data yet.</p>
            )}
          </TabsContent>

          <TabsContent value="account" className="mt-4">
            {accountData.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {accountData.map((acc: any) => {
                  const total = acc.positive + acc.negative + acc.neutral + acc.question;
                  const positiveRate = total > 0 ? Math.round((acc.positive / total) * 100) : 0;
                  return (
                    <Card key={acc.accountId}>
                      <CardContent className="pt-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-xs capitalize ${PLATFORM_BADGE_COLORS[acc.platform] || ""}`}>
                              {PLATFORM_LABELS[acc.platform] || acc.platform}
                            </Badge>
                            <span className="text-sm font-medium">@{acc.username}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">{total} comments</span>
                        </div>
                        <SentimentBar positive={acc.positive} negative={acc.negative} neutral={acc.neutral + acc.question} />
                        <div className="flex justify-between text-xs">
                          <span className="text-green-600">{acc.positive} positive ({positiveRate}%)</span>
                          <span className="text-red-600">{acc.negative} negative</span>
                          {acc.question > 0 && <span className="text-amber-600">{acc.question} questions</span>}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No per-account data yet.</p>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Notable Comments */}
      {(notable.topLiked.length > 0 || notable.recentQuestions.length > 0 || notable.recentNegative.length > 0) && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Notable Comments</h2>
          <Tabs defaultValue={notable.topLiked.length > 0 ? "liked" : notable.recentQuestions.length > 0 ? "questions" : "negative"}>
            <TabsList>
              {notable.topLiked.length > 0 && (
                <TabsTrigger value="liked" className="text-xs">
                  <ThumbsUp className="h-3 w-3 mr-1" /> Top Liked
                </TabsTrigger>
              )}
              {notable.recentQuestions.length > 0 && (
                <TabsTrigger value="questions" className="text-xs">
                  <HelpCircle className="h-3 w-3 mr-1" /> Questions
                </TabsTrigger>
              )}
              {notable.recentNegative.length > 0 && (
                <TabsTrigger value="negative" className="text-xs">
                  <ThumbsDown className="h-3 w-3 mr-1" /> Negative
                </TabsTrigger>
              )}
            </TabsList>

            {notable.topLiked.length > 0 && (
              <TabsContent value="liked" className="mt-3 space-y-2">
                {notable.topLiked.map((c: any) => (
                  <CommentCard key={c.id} comment={c} type="liked" />
                ))}
              </TabsContent>
            )}
            {notable.recentQuestions.length > 0 && (
              <TabsContent value="questions" className="mt-3 space-y-2">
                {notable.recentQuestions.map((c: any) => (
                  <CommentCard key={c.id} comment={c} type="question" />
                ))}
              </TabsContent>
            )}
            {notable.recentNegative.length > 0 && (
              <TabsContent value="negative" className="mt-3 space-y-2">
                {notable.recentNegative.map((c: any) => (
                  <CommentCard key={c.id} comment={c} type="negative" />
                ))}
              </TabsContent>
            )}
          </Tabs>
        </div>
      )}

      {/* Per-Post Sentiment + Themes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Per-Post */}
        {posts.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Per-Post Sentiment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {posts.slice(0, 10).map((post: any) => {
                const total = post.positive + post.negative + post.neutral;
                if (total === 0) return null;
                const SIcon = SENTIMENT_ICONS[post.sentiment] || Minus;
                const sColor = SENTIMENT_COLORS[post.sentiment] || "text-gray-500";

                return (
                  <div key={post.postId} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <SIcon className={`h-3.5 w-3.5 ${sColor}`} />
                      <p className="text-sm font-medium truncate flex-1">{post.title}</p>
                      <span className="text-[10px] text-muted-foreground">{total} comments</span>
                    </div>
                    <SentimentBar positive={post.positive} negative={post.negative} neutral={post.neutral} />
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <span className="text-green-600">{post.positive} positive</span>
                      <span className="text-red-600">{post.negative} negative</span>
                      <span>{post.neutral} neutral</span>
                    </div>
                    {post.summary && (
                      <p className="text-xs text-muted-foreground italic pl-5">{post.summary}</p>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Themes */}
        {(themes.positive.length > 0 || themes.negative.length > 0) && (
          <div className="space-y-4">
            {themes.positive.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm text-green-700 flex items-center gap-1.5">
                    <ThumbsUp className="h-4 w-4" /> Positive Themes
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {themes.positive.map((theme: string) => (
                      <Badge key={theme} variant="secondary" className="bg-green-100 text-green-800 text-xs">
                        {theme}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {themes.negative.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm text-red-700 flex items-center gap-1.5">
                    <ThumbsDown className="h-4 w-4" /> Negative Themes
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {themes.negative.map((theme: string) => (
                      <Badge key={theme} variant="secondary" className="bg-red-100 text-red-800 text-xs">
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
    </div>
  );
}
