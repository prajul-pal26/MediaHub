"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  commentsToRows,
  downloadCsv,
  downloadJson,
  postsToRows,
  profileToRows,
  reactorsToRows,
} from "@/lib/fb-export";
import {
  AlertTriangle,
  Clock,
  Download,
  Heart,
  Loader2,
  MessageSquare,
  Repeat2,
  Search,
  ThumbsUp,
  Trash2,
  Users,
} from "lucide-react";

type Mode = "posts" | "comments" | "profile" | "group" | "reactors" | "graph" | "history";
type Method = "auto" | "mbasic" | "graphql" | "browser";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const seconds = Math.floor((Date.now() - parsed) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(parsed).toLocaleDateString();
}

/** Per-method attempt log — the fastest way to see why a run came back thin. */
function AttemptTrail({ attempts, source }: { attempts?: any[]; source?: string | null }) {
  if (!attempts?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {attempts.map((a, i) => (
        <Badge
          key={i}
          variant={a.ok ? "outline" : "destructive"}
          className="font-mono text-[10px]"
          title={a.error ?? ""}
        >
          {a.method} · {a.ok ? `${a.count} in ${a.ms}ms` : "failed"}
        </Badge>
      ))}
      {source && <span className="text-muted-foreground">served by {source}</span>}
    </div>
  );
}

function Stat({ icon, value }: { icon: React.ReactNode; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {icon}
      {value}
    </span>
  );
}

function CommentRow({ comment, depth = 0 }: { comment: any; depth?: number }) {
  return (
    <div style={{ marginLeft: depth * 20 }} className="border-l pl-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{comment.commenterName || "Unknown"}</span>
        {comment.commenterMeta && (
          <Badge variant="outline" className="text-[10px]">
            {comment.commenterMeta}
          </Badge>
        )}
        {comment.commentTime && (
          <span className="text-xs text-muted-foreground">{timeAgo(comment.commentTime)}</span>
        )}
        {comment.commentReactionCount > 0 && (
          <Stat icon={<ThumbsUp className="h-3 w-3" />} value={fmt(comment.commentReactionCount)} />
        )}
      </div>
      {comment.commentText && <p className="text-sm mt-1 whitespace-pre-wrap">{comment.commentText}</p>}
      {comment.replies?.map((reply: any, i: number) => (
        <CommentRow key={reply.commentId || i} comment={reply} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function FacebookScraperPage() {
  const [mode, setMode] = useState<Mode>("posts");
  const [target, setTarget] = useState("");
  const [method, setMethod] = useState<Method>("auto");
  const [limit, setLimit] = useState(30);
  const [pages, setPages] = useState(3);
  const [withComments, setWithComments] = useState(false);
  const [withReplies, setWithReplies] = useState(true);
  const [ordering, setOrdering] = useState<"all" | "newest" | "relevant">("all");
  const [graphToken, setGraphToken] = useState("");

  const utils = trpc.useUtils();
  const capabilities = trpc.fbScraper.capabilities.useQuery();
  const inspect = trpc.fbScraper.inspectTarget.useQuery(
    { target },
    { enabled: target.trim().length > 2, retry: false },
  );
  const history = trpc.fbScraper.listRuns.useQuery({ limit: 25 }, { enabled: mode === "history" });

  const onSuccess = (data: any) => {
    toast.success(
      data.count > 0
        ? `Scraped ${data.count} record${data.count === 1 ? "" : "s"} via ${data.source} in ${(data.durationMs / 1000).toFixed(1)}s`
        : "Scrape finished but found nothing — check the attempt trail below",
    );
    utils.fbScraper.listRuns.invalidate();
  };
  const onError = (err: any) => toast.error(err.message);

  const postsMutation = trpc.fbScraper.scrapePosts.useMutation({ onSuccess, onError });
  const commentsMutation = trpc.fbScraper.scrapeComments.useMutation({ onSuccess, onError });
  const profileMutation = trpc.fbScraper.scrapeProfile.useMutation({ onSuccess, onError });
  const groupMutation = trpc.fbScraper.scrapeGroup.useMutation({ onSuccess, onError });
  const reactorsMutation = trpc.fbScraper.scrapeReactors.useMutation({ onSuccess, onError });
  const graphMutation = trpc.fbScraper.fetchViaGraph.useMutation({
    onSuccess: (d) =>
      toast.success(`Fetched ${d.succeeded} page(s)${d.failed ? `, ${d.failed} failed` : ""}`),
    onError,
  });
  const deleteRun = trpc.fbScraper.deleteRun.useMutation({
    onSuccess: () => {
      toast.success("Run deleted");
      utils.fbScraper.listRuns.invalidate();
    },
    onError,
  });

  const active = useMemo(() => {
    switch (mode) {
      case "posts":
        return postsMutation;
      case "comments":
        return commentsMutation;
      case "profile":
        return profileMutation;
      case "group":
        return groupMutation;
      case "reactors":
        return reactorsMutation;
      default:
        return null;
    }
  }, [mode, postsMutation, commentsMutation, profileMutation, groupMutation, reactorsMutation]);

  const running = Boolean(active?.isPending);
  const result: any = active?.data;

  const run = () => {
    const value = target.trim();
    if (!value) {
      toast.error("Paste a Facebook link or handle first");
      return;
    }
    switch (mode) {
      case "posts":
        return postsMutation.mutate({
          target: value,
          method,
          pages,
          limit,
          withComments,
          commentsPerPost: 20,
        });
      case "comments":
        return commentsMutation.mutate({ postUrl: value, method, limit, withReplies, ordering });
      case "profile":
        return profileMutation.mutate({ target: value, method });
      case "group":
        return groupMutation.mutate({ target: value });
      case "reactors":
        return reactorsMutation.mutate({ postUrl: value, limit });
    }
  };

  const exportRows = (): { rows: Record<string, unknown>[]; name: string } | null => {
    if (!result?.data) return null;
    switch (mode) {
      case "posts":
        return { rows: postsToRows(result.data), name: "fb-posts" };
      case "comments":
        return { rows: commentsToRows(result.data, target), name: "fb-comments" };
      case "profile":
        return { rows: profileToRows(result.data), name: "fb-profile" };
      case "group":
        return { rows: result.data ? [result.data] : [], name: "fb-group" };
      case "reactors":
        return { rows: reactorsToRows(result.data.reactors ?? []), name: "fb-reactors" };
      default:
        return null;
    }
  };

  const caps = capabilities.data;
  const targetHint = inspect.data;

  const placeholder =
    mode === "comments" || mode === "reactors"
      ? "https://www.facebook.com/nasa/posts/1234567890"
      : mode === "group"
        ? "https://www.facebook.com/groups/123456789"
        : "https://www.facebook.com/nasa  ·  or just: nasa";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-[#1877F2] flex items-center justify-center">
          <Search className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Facebook Scraper</h1>
          <p className="text-sm text-muted-foreground">
            Posts, comments, replies, reactors, profiles, and groups — from a link.
          </p>
        </div>
      </div>

      {caps && !caps.hasSession && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
            <span>
              No active Facebook session. Add a cookie bundle in Settings → Facebook — every method needs
              one.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="posts">Posts</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="group">Group</TabsTrigger>
          <TabsTrigger value="reactors">Reactors</TabsTrigger>
          <TabsTrigger value="graph">Graph API</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {(["posts", "comments", "profile", "group", "reactors"] as Mode[]).map((tab) => (
          <TabsContent key={tab} value={tab} className="space-y-4">
            <Card>
              <CardContent className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Facebook link or handle</Label>
                  <div className="flex gap-2">
                    <Input
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      placeholder={placeholder}
                      onKeyDown={(e) => e.key === "Enter" && !running && run()}
                    />
                    <Button onClick={run} disabled={running}>
                      {running ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Scraping
                        </>
                      ) : (
                        "Scrape"
                      )}
                    </Button>
                  </div>
                  {targetHint && (
                    <p className="text-xs text-muted-foreground">
                      {targetHint.ok ? (
                        <>
                          Detected <Badge variant="outline">{targetHint.kind}</Badge>{" "}
                          {targetHint.handle && <span className="font-mono">{targetHint.handle}</span>}
                          {targetHint.postId && (
                            <>
                              {" "}
                              · post <span className="font-mono">{targetHint.postId}</span>
                            </>
                          )}
                        </>
                      ) : (
                        <span className="text-amber-600">{targetHint.error}</span>
                      )}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-end gap-4">
                  {tab !== "group" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Method</Label>
                      <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto (recommended)</SelectItem>
                          <SelectItem value="mbasic">mbasic HTML (fast)</SelectItem>
                          <SelectItem value="graphql" disabled={!caps?.graphqlConfigured}>
                            GraphQL {caps?.graphqlConfigured ? "" : "(no doc_id)"}
                          </SelectItem>
                          <SelectItem value="browser">Browser (reliable)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {tab !== "profile" && tab !== "group" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Limit</Label>
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        value={limit}
                        onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                        className="w-24"
                      />
                    </div>
                  )}

                  {tab === "posts" && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Pages to walk</Label>
                        <Input
                          type="number"
                          min={1}
                          max={10}
                          value={pages}
                          onChange={(e) => setPages(Math.max(1, Number(e.target.value) || 1))}
                          className="w-24"
                        />
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        <Switch checked={withComments} onCheckedChange={setWithComments} />
                        <Label className="text-xs">Also fetch comments (slow)</Label>
                      </div>
                    </>
                  )}

                  {tab === "comments" && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Ordering</Label>
                        <Select value={ordering} onValueChange={(v) => setOrdering(v as any)}>
                          <SelectTrigger className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All comments</SelectItem>
                            <SelectItem value="newest">Newest</SelectItem>
                            <SelectItem value="relevant">Most relevant</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        <Switch checked={withReplies} onCheckedChange={setWithReplies} />
                        <Label className="text-xs">Include replies</Label>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {result && (
              <Card>
                <CardContent className="py-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">
                        {result.count} record{result.count === 1 ? "" : "s"}
                      </p>
                      <AttemptTrail attempts={result.attempts} source={result.source} />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const exported = exportRows();
                          if (exported?.rows.length) downloadCsv(exported.rows, exported.name);
                          else toast.error("Nothing to export");
                        }}
                      >
                        <Download className="h-4 w-4" /> CSV
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => downloadJson(result.data, `fb-${mode}`)}
                      >
                        <Download className="h-4 w-4" /> JSON
                      </Button>
                    </div>
                  </div>

                  {tab === "posts" && (
                    <div className="space-y-3">
                      {(result.data ?? []).map((post: any, i: number) => (
                        <div key={post.postId || i} className="border rounded-lg p-3 space-y-2">
                          <div className="flex flex-wrap items-center gap-3">
                            {post.time && (
                              <Stat icon={<Clock className="h-3 w-3" />} value={timeAgo(post.time)} />
                            )}
                            <Stat icon={<ThumbsUp className="h-3 w-3" />} value={fmt(post.likes)} />
                            <Stat icon={<MessageSquare className="h-3 w-3" />} value={fmt(post.comments)} />
                            <Stat icon={<Repeat2 className="h-3 w-3" />} value={fmt(post.shares)} />
                            {post.postUrl && (
                              <a
                                href={post.postUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-blue-600 hover:underline"
                              >
                                permalink
                              </a>
                            )}
                          </div>
                          {post.text && (
                            <p className="text-sm whitespace-pre-wrap line-clamp-6">{post.text}</p>
                          )}
                          {post.images?.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto">
                              {post.images.slice(0, 4).map((src: string, k: number) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={k} src={src} alt="" className="h-20 rounded object-cover" />
                              ))}
                            </div>
                          )}
                          {post.commentsFull?.length > 0 && (
                            <details className="text-sm">
                              <summary className="cursor-pointer text-muted-foreground">
                                {post.commentsFull.length} comments
                              </summary>
                              <div className="mt-2">
                                {post.commentsFull.map((c: any, k: number) => (
                                  <CommentRow key={c.commentId || k} comment={c} />
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {tab === "comments" && (
                    <div className="divide-y">
                      {(result.data ?? []).map((c: any, i: number) => (
                        <CommentRow key={c.commentId || i} comment={c} />
                      ))}
                    </div>
                  )}

                  {tab === "profile" && result.data && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        {result.data.profilePic && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={result.data.profilePic} alt="" className="h-14 w-14 rounded-full object-cover" />
                        )}
                        <div>
                          <p className="font-semibold">{result.data.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {result.data.category ?? "—"} · {fmt(result.data.followers)} followers ·{" "}
                            {fmt(result.data.likes)} likes
                          </p>
                        </div>
                      </div>
                      {result.data.about && <p className="text-sm">{result.data.about}</p>}
                      {(["work", "education", "placesLived", "websites"] as const).map((key) =>
                        result.data[key]?.length ? (
                          <div key={key} className="text-sm">
                            <span className="text-muted-foreground capitalize">{key}: </span>
                            {result.data[key].join(", ")}
                          </div>
                        ) : null,
                      )}
                      {Object.keys(result.data.contactInfo ?? {}).length > 0 && (
                        <div className="text-sm">
                          <span className="text-muted-foreground">Contact: </span>
                          {Object.entries(result.data.contactInfo)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(" · ")}
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "group" && result.data && (
                    <div className="space-y-2 text-sm">
                      <p className="font-semibold">{result.data.name}</p>
                      <p className="text-muted-foreground">
                        {result.data.type ?? "—"} · {fmt(result.data.members)} members
                      </p>
                      {result.data.about && <p>{result.data.about}</p>}
                      {result.data.admins?.length > 0 && (
                        <p>
                          <span className="text-muted-foreground">Admins: </span>
                          {result.data.admins.map((a: any) => a.name).join(", ")}
                        </p>
                      )}
                    </div>
                  )}

                  {tab === "reactors" && result.data && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(result.data.breakdown ?? {}).map(([kind, count]) => (
                          <Badge key={kind} variant="outline">
                            {kind}: {fmt(count as number)}
                          </Badge>
                        ))}
                        <Badge>
                          <Heart className="h-3 w-3" /> {fmt(result.data.total)} total
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {(result.data.reactors ?? []).map((r: any, i: number) => (
                          <a
                            key={i}
                            href={r.link ?? "#"}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm truncate hover:underline"
                          >
                            {r.name} {r.type && <span className="text-muted-foreground">· {r.type}</span>}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.count === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Nothing came back. Try the Browser method, or check whether the session is still
                      alive in Settings → Facebook.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        ))}

        <TabsContent value="graph" className="space-y-4">
          <Card>
            <CardContent className="space-y-4 py-4">
              <p className="text-xs text-muted-foreground">
                The official Graph API — no cookies, no ToS violation. Works for Pages you own or
                have a token for. Reading arbitrary public Pages needs Meta&apos;s{" "}
                <strong>Page Public Content Access</strong> (App Review); without it those lookups
                fail with a Graph error.
              </p>
              <div className="space-y-2">
                <Label>Page handles or URLs</Label>
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="nasa, natgeo, 20531316728  ·  or paste page URLs"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Access token (optional)</Label>
                <Input
                  type="password"
                  value={graphToken}
                  onChange={(e) => setGraphToken(e.target.value)}
                  placeholder="Leave blank to use the org's configured Facebook app credentials"
                  className="font-mono text-sm"
                />
              </div>
              <Button
                onClick={() => {
                  const list = target
                    .split(/[\s,\n]+/)
                    .map((p) => p.trim())
                    .filter(Boolean);
                  if (!list.length) return toast.error("Enter at least one page");
                  graphMutation.mutate({
                    pages: list.slice(0, 20),
                    accessToken: graphToken.trim() || undefined,
                  });
                }}
                disabled={graphMutation.isPending}
              >
                {graphMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Fetching
                  </>
                ) : (
                  "Fetch via Graph API"
                )}
              </Button>
            </CardContent>
          </Card>

          {graphMutation.data && (
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm">
                    {graphMutation.data.succeeded} ok, {graphMutation.data.failed} failed{" "}
                    <Badge variant="outline">token: {graphMutation.data.tokenSource}</Badge>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadJson(graphMutation.data, "fb-graph")}
                  >
                    <Download className="h-4 w-4" /> JSON
                  </Button>
                </div>
                {graphMutation.data.results.map((r: any, i: number) => (
                  <div key={i} className="border rounded-lg p-3 text-sm">
                    {r.ok && r.page ? (
                      <div className="space-y-1">
                        <p className="font-semibold">
                          {r.page.name}{" "}
                          {r.page.username && (
                            <span className="text-muted-foreground">@{r.page.username}</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {r.page.category ?? "—"} · {fmt(r.page.followersCount)} followers ·{" "}
                          {fmt(r.page.fanCount)} likes
                          {r.page.engagementRate != null && ` · ${r.page.engagementRate}% engagement`}
                        </p>
                        {r.page.about && <p className="text-xs">{r.page.about}</p>}
                        {r.page.postsError && (
                          <p className="text-xs text-amber-600 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" /> {r.page.postsError}
                          </p>
                        )}
                        {r.page.recentPosts?.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {r.page.recentPosts.length} recent posts
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-destructive text-xs">
                        <span className="font-mono">{r.query}</span> — {r.error}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-3">
          {history.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {history.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">No scrape runs yet.</p>
          )}
          {history.data?.map((run: any) => (
            <Card key={run.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{run.kind}</Badge>
                    <span className="text-sm font-mono truncate">{run.target}</span>
                    <Badge variant={run.status === "ok" ? "default" : "destructive"}>{run.status}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {run.item_count} records · {run.source ?? run.method} ·{" "}
                    {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : "—"} ·{" "}
                    {timeAgo(run.created_at)}
                    {run.error ? ` · ${run.error}` : ""}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const full = await utils.fbScraper.getRun.fetch({ id: run.id });
                      downloadJson(full.payload, `fb-${run.kind}`);
                    }}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deleteRun.mutate({ id: run.id })}
                    disabled={deleteRun.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <Card className="border-muted">
        <CardContent className="py-3 text-xs text-muted-foreground space-y-1">
          <p className="flex items-center gap-1.5">
            <Users className="h-3 w-3" /> Every method uses your stored session cookies. Scraping is
            against Meta&apos;s Terms of Service and can get an account checkpointed — use a throwaway
            account, not a business one.
          </p>
          <p>
            Auto tries mbasic (fast) → GraphQL (comments) → browser (reliable), and reports which one
            served the data.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
