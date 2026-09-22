"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { downloadCsv, downloadJson } from "@/lib/fb-export";
import { InstagramGlyph } from "@/components/settings/InstagramSessions";
import {
  AlertTriangle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Gauge,
  ListChecks,
  Loader2,
  MessageSquare,
  Search,
  Trash2,
} from "lucide-react";

type Tab = "harvest" | "results" | "history";
type RunStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

const DELTA_BUCKETS = [
  { label: "Under 10", min: 1, max: 9 },
  { label: "10–19", min: 10, max: 19 },
  { label: "20–29", min: 20, max: 29 },
  { label: "30–49", min: 30, max: 49 },
  { label: "50–99", min: 50, max: 99 },
  { label: "100+", min: 100, max: Number.MAX_SAFE_INTEGER },
] as const;

/** Measured harvest throughput — the ETA on the Harvest tab is derived from this. */
const THROUGHPUT_PER_SEC = 42;
const PAGE_SIZE = 50;

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

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "2-digit",
  });
}

function duration(ms: number | null | undefined): string {
  if (!ms) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

/** ETA at the measured pace, expressed in minutes (the useful unit at this scale). */
function etaLabel(comments: number): string {
  if (comments <= 0) return "—";
  const minutes = comments / THROUGHPUT_PER_SEC / 60;
  if (minutes < 1) return "under a minute";
  return `~${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}

/**
 * A run row carries `posts` as the stored post objects and `post_limit` as the
 * count; listRuns only selects the count, so both shapes have to be tolerated.
 */
function postCount(row: any): number {
  if (typeof row?.post_limit === "number") return row.post_limit;
  if (Array.isArray(row?.posts)) return row.posts.length;
  return typeof row?.posts === "number" ? row.posts : 0;
}

function statusVariant(status: RunStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "running" || status === "queued") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

/** No Progress primitive in the kit — a div with a width style is all this needs. */
function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#dd2a7b] to-[#8134af] transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
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

export default function InstagramCommentsPage() {
  const [tab, setTab] = useState<Tab>("harvest");

  // Harvest inputs
  const [username, setUsername] = useState("");
  const [savedUsername, setSavedUsername] = useState("");
  const [postLimit, setPostLimit] = useState(24);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [concurrency, setConcurrency] = useState(3);
  const [includeReplies, setIncludeReplies] = useState(true);
  const [driveBrandId, setDriveBrandId] = useState("");

  // Results state
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const utils = trpc.useUtils();
  const capabilities = trpc.instaComments.capabilities.useQuery();
  const exportDestinations = trpc.instaComments.exportDestinations.useQuery();

  useEffect(() => {
    if (!driveBrandId && exportDestinations.data?.[0]?.brandId) {
      setDriveBrandId(exportDestinations.data[0].brandId);
    }
  }, [driveBrandId, exportDestinations.data]);

  const postsMutation = trpc.instaComments.listPosts.useMutation({
    onSuccess: (data: any) => {
      setSelected(new Set());
      setSavedUsername(data.profile.username);
      utils.instaComments.listSavedMedia.invalidate({ username: data.profile.username, limit: 200 });
      toast.success(
        data.posts.length > 0
          ? `Saved ${data.saved ?? data.posts.length} links. Comments can now be collected separately.`
          : "Profile loaded but no posts came back — the session may be stale",
      );
    },
    onError: (e: any) => toast.error(e.message),
  });

  const startMutation = trpc.instaComments.startHarvest.useMutation({
    onSuccess: (data: any) => {
      setActiveRunId(data.runId);
      setPolling(true);
      setPage(0);
      setSearch("");
      setDebouncedSearch("");
      setTab("results");
      toast.success("Harvest started");
      utils.instaComments.listRuns.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const runQuery = trpc.instaComments.getRun.useQuery(
    { id: activeRunId ?? "" },
    { enabled: Boolean(activeRunId), refetchInterval: polling ? 2000 : false },
  );
  const run: any = runQuery.data;
  const runStatus: RunStatus | undefined = run?.status;

  // Poll only while the run is still moving; the interval switches itself off on settle.
  useEffect(() => {
    setPolling(runStatus === "queued" || runStatus === "running");
  }, [runStatus]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(0), [debouncedSearch]);

  const settled = runStatus === "completed" || runStatus === "partial";
  const commentsQuery = trpc.instaComments.getComments.useQuery(
    {
      runId: activeRunId ?? "",
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: debouncedSearch || undefined,
    },
    { enabled: Boolean(activeRunId) && settled },
  );

  const history = trpc.instaComments.listRuns.useQuery({ limit: 25 }, { enabled: tab === "history" });

  const exportMutation = trpc.instaComments.exportRun.useMutation();

  const cancelMutation = trpc.instaComments.cancelRun.useMutation({
    onSuccess: () => {
      toast.success("Cancel requested");
      utils.instaComments.getRun.invalidate();
      utils.instaComments.listRuns.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMutation = trpc.instaComments.deleteRun.useMutation({
    onSuccess: () => {
      toast.success("Run deleted");
      utils.instaComments.listRuns.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const retryMutation = trpc.instaComments.retryRun.useMutation({
    onSuccess: (data: any) => {
      if (!data.runId) { toast.info("No posts match that retry gap."); return; }
      setActiveRunId(data.runId);
      setPolling(true);
      toast.success(`Retrying ${data.total} post${data.total === 1 ? "" : "s"}; earlier comments stay merged.`);
      utils.instaComments.getRun.invalidate({ id: data.runId });
      utils.instaComments.listRuns.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const savedMediaQuery = trpc.instaComments.listSavedMedia.useQuery(
    { username: savedUsername || "_", limit: 200 },
    { enabled: Boolean(savedUsername) },
  );
  const loadedPosts: any[] = postsMutation.data?.posts ?? [];
  const savedPosts: any[] = savedMediaQuery.data ?? [];
  // Fresh discovery has the newest profile metadata. Once the page is
  // refreshed, the durable link workspace is still selectable without asking
  // Instagram for the feed a second time.
  const posts: any[] = loadedPosts.length ? loadedPosts : savedPosts;
  const profile: any = postsMutation.data?.profile;

  const selectedPosts = useMemo(() => posts.filter((p) => selected.has(p.mediaId)), [posts, selected]);
  const selectedCommentTotal = useMemo(
    () => selectedPosts.reduce((sum, p) => sum + (p.commentCount ?? 0), 0),
    [selectedPosts],
  );

  // The run row stores the posts it was started with, so a run opened from
  // History still resolves shortcodes without reloading the post list.
  const runPosts: any[] = useMemo(() => (Array.isArray(run?.posts) ? run.posts : []), [run?.posts]);

  /** mediaId → shortcode, so live per-post progress reads as shortcodes not raw ids. */
  const shortcodeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [...posts, ...runPosts]) map.set(p.mediaId, p.shortcode);
    return map;
  }, [posts, runPosts]);

  const commentCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of [...posts, ...runPosts]) map.set(p.mediaId, p.commentCount ?? 0);
    return map;
  }, [posts, runPosts]);

  const toggleOne = (mediaId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) next.delete(mediaId);
      else next.add(mediaId);
      return next;
    });
  };

  const allSelected = posts.length > 0 && selected.size === posts.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(posts.map((p) => p.mediaId as string)));

  const loadPosts = () => {
    const handle = username.trim().replace(/^@/, "");
    if (!handle) {
      toast.error("Enter an Instagram username first");
      return;
    }
    postsMutation.mutate({ username: handle, limit: postLimit });
  };

  const loadSavedPosts = () => {
    const handle = username.trim().replace(/^@/, "");
    if (!handle) {
      toast.error("Enter an Instagram username first");
      return;
    }
    setSelected(new Set());
    setSavedUsername(handle);
  };

  const startHarvest = () => {
    if (!selectedPosts.length) {
      toast.error("Select at least one post");
      return;
    }
    startMutation.mutate({
      username: (profile?.username ?? username.trim().replace(/^@/, "")) as string,
      mediaIds: selectedPosts.map((p) => p.mediaId as string),
      concurrency,
      includeReplies,
      driveBrandId: driveBrandId || undefined,
    });
  };

  const openRun = (runId: string) => () => {
    setActiveRunId(runId);
    setPage(0);
    setSearch("");
    setDebouncedSearch("");
    setTab("results");
  };

  const exportRows = async (runId: string, format: "csv" | "json", label: string) => {
    try {
      const data = await exportMutation.mutateAsync({ runId });
      if (!data.rows.length) {
        toast.error("No comments to export");
        return;
      }
      const basename = `ig-comments-${label || "run"}`;
      if (format === "csv") downloadCsv(data.rows as Record<string, unknown>[], basename);
      else downloadJson(data.rows, basename);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const caps = capabilities.data;
  const perPostDetails: Record<string, any> = run?.progress?.perPost ?? {};
  const commentRows: any[] = commentsQuery.data?.rows ?? [];
  const commentTotal = commentsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(commentTotal / PAGE_SIZE));

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] flex items-center justify-center text-white">
          <MessageSquare className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Instagram Comments</h1>
          <p className="text-sm text-muted-foreground">
            Pick posts, harvest every comment (and reply) with live progress — no media downloaded.
          </p>
        </div>
        {caps?.hasSession && (
          <Badge variant="secondary" className="ml-auto shrink-0">
            <InstagramGlyph className="h-3 w-3" /> {caps.activeSessions} active session
            {caps.activeSessions === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {caps && !caps.hasSession && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
            <span>
              No active Instagram session. Add a <code className="text-xs">sessionid</code> in
              Settings → Instagram — comment harvesting needs one.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="harvest">Harvest</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* ---------------------------------------------------------------- Harvest */}
        <TabsContent value="harvest" className="space-y-4">
          <Card>
            <CardContent className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Instagram username</Label>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="myogi_adityanath"
                    onKeyDown={(e) => e.key === "Enter" && !postsMutation.isPending && loadPosts()}
                    className="min-w-[16rem] flex-1"
                  />
                  <div className="space-y-1.5">
                    <Label className="text-xs">Posts to scan</Label>
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={postLimit}
                      onChange={(e) => setPostLimit(Math.max(1, Number(e.target.value) || 1))}
                      className="w-24"
                    />
                  </div>
                  <Button onClick={loadPosts} disabled={postsMutation.isPending}>
                    {postsMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading
                      </>
                    ) : (
                      "Discover & save links"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={loadSavedPosts}
                    disabled={savedMediaQuery.isFetching}
                  >
                    {savedMediaQuery.isFetching ? "Loading saved links" : "Load saved links"}
                  </Button>
                </div>
              </div>

              {profile && (
                <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                  {profile.profilePic && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={profile.profilePic}
                      alt=""
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium truncate">
                      {profile.fullName || profile.username}
                      {profile.isVerified && (
                        <Badge variant="secondary" className="text-[10px]">
                          verified
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">@{profile.username}</span> ·{" "}
                      {fmt(profile.followers)} followers · {fmt(profile.postsCount)} posts
                    </p>
                  </div>
                  <InstagramGlyph className="h-4 w-4 ml-auto text-muted-foreground shrink-0" />
                </div>
              )}
            </CardContent>
          </Card>

          {posts.length > 0 && (
            <Card>
              <CardContent className="py-4 space-y-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                      </TableHead>
                      <TableHead>Shortcode</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Published</TableHead>
                      <TableHead className="text-right">Likes</TableHead>
                      <TableHead className="text-right">Reported</TableHead>
                      <TableHead className="text-right">Saved</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {posts.map((post) => (
                      <TableRow
                        key={post.mediaId}
                        className="cursor-pointer"
                        onClick={() => toggleOne(post.mediaId)}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selected.has(post.mediaId)}
                            onCheckedChange={() => toggleOne(post.mediaId)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {post.url ? (
                            <a
                              href={post.url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {post.shortcode}
                            </a>
                          ) : (
                            post.shortcode
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {post.kind}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {shortDate(post.publishedAt)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(post.likes)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmt(post.commentCount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {typeof post.scrapedCount === "number" ? fmt(post.scrapedCount) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-4">
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Concurrency</Label>
                      <Input
                        type="number"
                        min={1}
                        max={8}
                        value={concurrency}
                        onChange={(e) =>
                          setConcurrency(Math.min(5, Math.max(1, Number(e.target.value) || 1)))
                        }
                        className="w-24"
                      />
                    </div>
                    <div className="flex items-center gap-2 pb-2">
                      <Switch checked={includeReplies} onCheckedChange={setIncludeReplies} />
                      <Label className="text-xs">Include replies</Label>
                    </div>
                    {exportDestinations.data?.length ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Drive CSV destination</Label>
                        <select
                          value={driveBrandId}
                          onChange={(event) => setDriveBrandId(event.target.value)}
                          className="h-9 max-w-48 rounded-md border bg-background px-2 text-xs"
                        >
                          {exportDestinations.data.map((destination: { brandId: string; brandName: string }) => (
                            <option key={destination.brandId} value={destination.brandId}>
                              {destination.brandName} · Instagram scraper
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <p className="pb-2 text-xs text-muted-foreground">Connect Google Drive to save run CSVs.</p>
                    )}
                  </div>

                  <div className="space-y-1.5 text-right">
                    <p className="text-sm font-medium">
                      {selectedPosts.length} post{selectedPosts.length === 1 ? "" : "s"} ·{" "}
                      {fmt(selectedCommentTotal)} comments
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Links are saved first. ETA {etaLabel(selectedCommentTotal)} at {THROUGHPUT_PER_SEC}/sec
                    </p>
                  </div>

                  <Button
                    onClick={startHarvest}
                    disabled={startMutation.isPending || selectedPosts.length === 0}
                  >
                    {startMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Starting
                      </>
                    ) : (
                      "Collect comments from saved links"
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ---------------------------------------------------------------- Results */}
        <TabsContent value="results" className="space-y-4">
          {!activeRunId && (
            <p className="text-sm text-muted-foreground">
              No active run. Start a harvest, or open one from History.
            </p>
          )}

          {activeRunId && runQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading run…</p>
          )}

          {run && (
            <Card>
              <CardContent className="py-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-mono">@{run.target_username}</span>
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                      {polling && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {postCount(run)} post{postCount(run) === 1 ? "" : "s"} ·{" "}
                      {duration(run.duration_ms)} ·{" "}
                      {timeAgo(run.created_at)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {(run.status === "queued" || run.status === "running") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelMutation.mutate({ id: run.id })}
                        disabled={cancelMutation.isPending}
                      >
                        <Ban className="h-4 w-4" /> Cancel
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportRows(run.id, "csv", run.target_username)}
                      disabled={exportMutation.isPending}
                    >
                      <Download className="h-4 w-4" /> Export CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportRows(run.id, "json", run.target_username)}
                      disabled={exportMutation.isPending}
                    >
                      <Download className="h-4 w-4" /> Export JSON
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <ProgressBar
                    pct={
                      run.expected_comments > 0
                        ? (run.total_comments / run.expected_comments) * 100
                        : 0
                    }
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {fmt(run.total_comments)} / {fmt(run.expected_comments)} comments
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  <Tile
                    label="Throughput"
                    value={
                      run.throughput_per_sec != null ? `${run.throughput_per_sec.toFixed(1)}/s` : "—"
                    }
                  />
                  <Tile label="Requests" value={fmt(run.request_count)} />
                  <Tile label="Throttles" value={fmt(run.throttle_count)} />
                  <Tile
                    label="Pace"
                    value={run.current_pace_ms != null ? `${run.current_pace_ms}ms` : "—"}
                  />
                  <Tile
                    label="Coverage"
                    value={run.coverage_pct != null ? `${run.coverage_pct.toFixed(1)}%` : "—"}
                  />
                </div>

                {run.error && (
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {run.error}
                  </p>
                )}

                {Object.keys(perPostDetails).length > 0 && (
                  <div className="space-y-2 border-t pt-4">
                    <p className="text-xs font-medium text-muted-foreground">
                      Per-post progress
                      {run.progress?.updatedAt && ` · updated ${timeAgo(run.progress.updatedAt)}`}
                    </p>
                    <div className="space-y-1.5">
                      {Object.entries(perPostDetails).map(([mediaId, raw]) => {
                        const legacyCount = typeof raw === "number" ? raw : 0;
                        const detail = typeof raw === "number" ? { reportedCount: commentCountById.get(mediaId) ?? 0, scrapedCount: raw, topLevelCount: raw, replyCount: 0, status: "partial" } : raw;
                        const expected = typeof detail.reportedCount === "number" ? detail.reportedCount : commentCountById.get(mediaId) ?? 0;
                        const scraped = typeof detail.scrapedCount === "number" ? detail.scrapedCount : legacyCount;
                        const delta = Math.max(0, expected - scraped);
                        return (
                          <div key={mediaId} className="flex flex-wrap items-center gap-3 rounded-md border px-2 py-1.5">
                            <span className="w-28 shrink-0 truncate font-mono text-xs">
                              {shortcodeById.get(mediaId) ?? mediaId}
                            </span>
                            <ProgressBar
                              pct={expected > 0 ? (scraped / expected) * 100 : scraped > 0 ? 100 : 0}
                              className="flex-1"
                            />
                            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                              {fmt(scraped)} / {fmt(expected)}
                            </span>
                            <span className={"w-24 shrink-0 text-right text-xs tabular-nums " + (delta > 0 ? "text-destructive" : "text-emerald-700")}>
                              Δ {fmt(delta)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {fmt(detail.topLevelCount ?? scraped)} top · {fmt(detail.replyCount ?? 0)} replies
                            </span>
                            {settled && delta > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => retryMutation.mutate({ runId: run.id, postIds: [mediaId] })}
                                disabled={retryMutation.isPending}
                              >
                                Retry comments
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {settled && Object.keys(perPostDetails).length > 0 && (
                  <div className="space-y-2 border-t pt-4">
                    <p className="text-xs font-medium text-muted-foreground">Retry incomplete comments by delta</p>
                    <div className="flex flex-wrap gap-2">
                      {DELTA_BUCKETS.map((bucket) => {
                        const matching = Object.entries(perPostDetails).filter(([mediaId, raw]) => {
                          const detail = typeof raw === "number" ? { reportedCount: commentCountById.get(mediaId) ?? 0, scrapedCount: raw } : raw as any;
                          return Math.max(0, (detail.reportedCount ?? commentCountById.get(mediaId) ?? 0) - (detail.scrapedCount ?? 0)) >= bucket.min
                            && Math.max(0, (detail.reportedCount ?? commentCountById.get(mediaId) ?? 0) - (detail.scrapedCount ?? 0)) <= bucket.max;
                        }).length;
                        return (
                          <Button key={bucket.label} variant="outline" size="sm" disabled={!matching || retryMutation.isPending}
                            onClick={() => retryMutation.mutate({ runId: run.id, minDelta: bucket.min, maxDelta: bucket.max })}>
                            Retry {bucket.label} ({matching})
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {settled && (
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search comments or commenters"
                      className="w-72 pl-8"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {fmt(commentTotal)} comment{commentTotal === 1 ? "" : "s"}
                    {commentsQuery.isFetching && " · loading…"}
                  </p>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Commenter</TableHead>
                      <TableHead className="w-1/2">Comment</TableHead>
                      <TableHead>Post</TableHead>
                      <TableHead className="text-right">Likes</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commentRows.map((row) => (
                      <TableRow key={row.comment_id}>
                        <TableCell className="align-top">
                          <div style={{ marginLeft: (row.depth ?? 0) * 14 }} className="space-y-0.5">
                            <p className="flex items-center gap-1.5 text-xs font-mono">
                              @{row.commenter_username}
                              {row.commenter_verified && (
                                <Badge variant="secondary" className="text-[10px]">
                                  ✓
                                </Badge>
                              )}
                            </p>
                            {row.commenter_full_name && (
                              <p className="text-[11px] text-muted-foreground">
                                {row.commenter_full_name}
                              </p>
                            )}
                            {row.parent_comment_id && (
                              <span className="text-[10px] text-muted-foreground">reply</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="align-top whitespace-pre-wrap text-sm">
                          {row.comment_text}
                        </TableCell>
                        <TableCell className="align-top font-mono text-xs text-muted-foreground">
                          {row.post_shortcode}
                        </TableCell>
                        <TableCell className="align-top text-right tabular-nums">
                          {fmt(row.comment_likes)}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {timeAgo(row.comment_created_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {commentRows.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {debouncedSearch ? "No comments match that search." : "No comments stored yet."}
                  </p>
                )}

                {commentTotal > PAGE_SIZE && (
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Page {page + 1} of {pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page + 1 >= pageCount}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ---------------------------------------------------------------- History */}
        <TabsContent value="history" className="space-y-3">
          {history.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {history.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">No harvest runs yet.</p>
          )}
          {history.data?.map((item: any) => (
            <Card key={item.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                {/* Whole row opens the run in Results — a real <button> can't wrap this markup. */}
                <div
                  role="button"
                  tabIndex={0}
                  className="min-w-0 space-y-1 cursor-pointer"
                  onClick={openRun(item.id)}
                  onKeyDown={(e) => e.key === "Enter" && openRun(item.id)()}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-mono truncate">@{item.target_username}</span>
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Stat
                      icon={<MessageSquare className="h-3 w-3" />}
                      value={`${fmt(item.total_comments)} / ${fmt(item.expected_comments)}`}
                    />
                    <Stat
                      icon={<ListChecks className="h-3 w-3" />}
                      value={`${postCount(item)} posts`}
                    />
                    <Stat
                      icon={<Gauge className="h-3 w-3" />}
                      value={item.coverage_pct != null ? `${item.coverage_pct.toFixed(1)}%` : "—"}
                    />
                    <Stat icon={<Clock className="h-3 w-3" />} value={duration(item.duration_ms)} />
                    <span className="text-xs text-muted-foreground">{timeAgo(item.created_at)}</span>
                  </div>
                  {item.error && <p className="text-xs text-destructive">{item.error}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportRows(item.id, "csv", item.target_username)}
                    disabled={exportMutation.isPending}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      deleteMutation.mutate({ id: item.id });
                      if (activeRunId === item.id) setActiveRunId(null);
                    }}
                    disabled={deleteMutation.isPending}
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
            <AlertTriangle className="h-3 w-3" /> Harvesting uses your stored session cookies.
            Scraping violates Instagram&apos;s Terms of Service and accounts can be banned — use a
            throwaway account, not a business one.
          </p>
          <p>
            Comments are personal data: usernames, names, and text belong to real people. Store and
            share the exports accordingly. No media is downloaded — comments only.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
