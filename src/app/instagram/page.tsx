"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { useUser } from "@/lib/hooks/use-user";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/landing/lib/motion";
import { SURFACE } from "@/components/landing/lib/constants";
import { BrandLogo } from "@/components/common/BrandLogo";
import { InstagramProfileLibrary } from "@/components/media/InstagramProfileLibrary";
import {
  Search,
  Loader2,
  CheckCircle2,
  Lock,
  MessageSquare,
  Link2,
  Download,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Users,
  Play,
  Image as ImageIcon,
  FileSpreadsheet,
  Heart,
  Eye,
  BarChart3,
  Sparkles,
  ExternalLink,
  Layers,
  Calendar,
  MapPin,
  X,
} from "lucide-react";
import type { InstaMediaItem } from "@/server/services/instagram/fetcher";
import type { InstaComment } from "@/server/services/instagram/comments";
import {
  exportProfileSummaryCsv,
  exportPostsCsv,
  exportCommentsCsv,
  exportFollowersCsv,
} from "@/lib/insta-export";

const MAX_TAGS = 5;

/** Hashtag media is normalized by the fetcher to the same media shape as a profile feed. */
type HashItem = InstaMediaItem;

function fmt(n: number | null | undefined) {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Route Instagram CDN media through proxy to prevent hotlink blocking */
const mediaProxy = (url: string | null | undefined) =>
  url ? `/api/insta-media?url=${encodeURIComponent(url)}` : "";

const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors disabled:opacity-60 disabled:pointer-events-none shadow-sm";
const SECONDARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full border border-zinc-300 bg-white text-zinc-800 font-medium hover:bg-zinc-50 transition-colors shadow-sm";

type Mode = "profiles" | "trending";
type SortKey = "views" | "likes" | "comments" | "recent";
type TypeFilter = "all" | "reels" | "posts";

const SORT_LABEL: Record<SortKey, string> = {
  views: "Top views",
  likes: "Top likes",
  comments: "Top comments",
  recent: "Most recent",
};

/** Normalizes any Instagram URL or handle format */
function extractUsername(input: string): string {
  if (!input) return "";
  const s = input.trim();
  const match = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/i);
  if (match && match[1]) {
    const part = match[1].toLowerCase();
    if (!["p", "reel", "reels", "stories", "explore", "tv", "direct"].includes(part)) {
      return part;
    }
  }
  return s
    .replace(/^[#@]+/, "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/^[#@]+/, "")
    .trim() || "";
}

export default function InstagramDemoPage() {
  const [mode, setMode] = useState<Mode>("profiles");
  const { profile, loading: userLoading } = useUser();
  const authed = !!profile;
  const utils = trpc.useUtils();
  const resumedWorkspaceFetch = useRef(false);

  // ── Single Profile Inputs & Options ──
  const [profileInput, setProfileInput] = useState("https://www.instagram.com/dr_arun_kumar_saxena");
  const [includeFriends, setIncludeFriends] = useState(false);
  const [friendsLimit, setFriendsLimit] = useState(200);
  const [includeContent, setIncludeContent] = useState(true);
  const [contentLimit, setContentLimit] = useState(24);
  // Link discovery is deliberately phase one.  Comment collection is started
  // from the saved workspace so a refresh or a repeat discovery cannot launch
  // a second crawl by accident.
  const [includeComments, setIncludeComments] = useState(false);
  const [commentsLimit, setCommentsLimit] = useState(0);
  const [driveBrandId, setDriveBrandId] = useState("");
  const [activeCommentRunId, setActiveCommentRunId] = useState<string | null>(null);

  // Active modal post for inspecting comments
  const [activeCommentPost, setActiveCommentPost] = useState<InstaMediaItem | null>(null);

  const demoFetch = trpc.instaFetcher.demoFetch.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const driveDestinations = trpc.instaComments.exportDestinations.useQuery(undefined, { enabled: authed });
  useEffect(() => {
    if (!driveBrandId && driveDestinations.data?.[0]?.brandId) {
      setDriveBrandId(driveDestinations.data[0].brandId);
    }
  }, [driveBrandId, driveDestinations.data]);

  const backgroundHarvest = trpc.instaComments.startHarvest.useMutation({
    onSuccess: (data) => {
      setActiveCommentRunId(data.runId);
      void utils.instaComments.savedProfiles.invalidate();
      toast.success(`Comment collection started in the background for ${data.runId ? "the saved links" : "the selected links"}.`);
    },
    onError: (error) => toast.error(`Links were saved, but comments could not start: ${error.message}`),
  });
  const activeCommentRun = trpc.instaComments.getRun.useQuery(
    { id: activeCommentRunId ?? "00000000-0000-0000-0000-000000000000" },
    {
      enabled: Boolean(activeCommentRunId),
      refetchInterval: 2_500,
    },
  );
  const syncWorkspace = trpc.instaComments.syncProfile.useMutation({
    onSuccess: (sheet) => {
      void utils.instaComments.savedProfiles.invalidate();
      void utils.instaComments.listSavedMedia.invalidate();
      toast.success(`Synced to ${sheet.name}. Existing links were merged into the same Google Sheet.`);
    },
    onError: (error) => toast.error(`Google Sheet sync failed: ${error.message}`),
  });
  const loadWorkspace = trpc.instaComments.loadProfileFromSheet.useMutation({
    onSuccess: (result) => {
      void utils.instaComments.savedProfiles.invalidate();
      void utils.instaComments.listSavedMedia.invalidate();
      toast.success(result.found ? `Loaded ${result.refreshed} saved rows from ${result.sheetName}.` : "The Drive Sheet was removed; local cached rows are still available. Use Sync to create a replacement when you choose.");
    },
    onError: (error) => toast.error(`Could not refresh from Google Sheet: ${error.message}`),
  });

  const fullFetch = trpc.instaFetcher.fetchProfiles.useMutation({
    onSuccess: (data) => {
      void utils.instaComments.savedProfiles.invalidate();
      void utils.instaComments.listSavedMedia.invalidate();
      const queued = data.results.find((result) => result.ok && result.profile && result.commentsDeferred && result.content?.length);
      if (queued?.profile && queued.content?.length) {
        backgroundHarvest.mutate({
          username: queued.profile.username,
          mediaIds: queued.content.map((post) => post.id),
          concurrency: 3,
          commentLimit: commentsLimit,
          includeReplies: true,
        });
      }
    },
    onError: (e) => toast.error(e.message),
  });

  // The public route also offers a profile-only demo. Durable media links and
  // background comment collection, however, need an organization workspace.
  // In local studio mode, resume the same requested job after the automatic
  // workspace sign-in instead of silently using the demo endpoint.
  useEffect(() => {
    if (!authed || userLoading || resumedWorkspaceFetch.current || typeof window === "undefined") return;
    const query = new URLSearchParams(window.location.search);
    if (query.get("workspaceFetch") !== "1") return;

    const username = extractUsername(query.get("username") ?? "");
    if (!username) return;
    resumedWorkspaceFetch.current = true;

    const nextContentLimit = Math.min(1000, Math.max(1, Number(query.get("contentLimit")) || 24));
    const nextCommentLimit = Math.min(500, Math.max(1, Number(query.get("commentLimit")) || 25));
    const nextIncludeComments = query.get("includeComments") !== "0";
    setProfileInput(username);
    setIncludeContent(true);
    setContentLimit(nextContentLimit);
    setIncludeComments(nextIncludeComments);
    setCommentsLimit(nextCommentLimit);
    window.history.replaceState({}, "", "/instagram");
    fullFetch.mutate({
      usernames: [username],
      includeFriends: false,
      friendsLimit: 200,
      includeContent: true,
      contentLimit: nextContentLimit,
      includeComments: nextIncludeComments,
      commentsLimit: nextCommentLimit,
    });
  }, [authed, userLoading, fullFetch]);

  const targetUsername = extractUsername(profileInput);
  const savedMedia = trpc.instaComments.listSavedMedia.useQuery(
    { username: targetUsername || "_", limit: 500 },
    { enabled: authed && Boolean(targetUsername), refetchOnWindowFocus: false, retry: false },
  );

  const collectSavedLinks = () => {
    const mediaIds = (savedMedia.data ?? []).map((media: { mediaId: string }) => media.mediaId).filter(Boolean);
    if (!targetUsername || !mediaIds.length) {
      toast.info("Save this profile's post and Reel links before starting comment collection.");
      return;
    }
    backgroundHarvest.mutate({
      username: targetUsername,
      mediaIds,
      concurrency: 3,
      commentLimit: commentsLimit,
      includeReplies: true,
    });
  };

  const retryLargestGaps = () => {
    const mediaIds: string[] = (savedMedia.data ?? [])
      .map((media: { mediaId: string; commentCount: number | null; scrapedCount: number }): { mediaId: string; delta: number } => ({
        mediaId: media.mediaId,
        delta: Math.max(0, Number(media.commentCount ?? 0) - Number(media.scrapedCount ?? 0)),
      }))
      .filter((media: { mediaId: string; delta: number }) => media.delta > 0)
      .sort((left: { mediaId: string; delta: number }, right: { mediaId: string; delta: number }) => right.delta - left.delta)
      .slice(0, 50)
      .map((media: { mediaId: string; delta: number }) => media.mediaId);
    if (!targetUsername || !mediaIds.length) {
      toast.info("There are no saved posts or Reels with a positive comment gap.");
      return;
    }
    backgroundHarvest.mutate({
      username: targetUsername,
      mediaIds,
      concurrency: 3,
      commentLimit: 0,
      includeReplies: true,
    });
  };

  const retrySavedMedia = (mediaId: string, reportedCount: number | null, scrapedCount: number) => {
    const delta = Math.max(0, Number(reportedCount ?? 0) - Number(scrapedCount ?? 0));
    if (!targetUsername || !mediaId || delta <= 0) {
      toast.info("This item has no positive comment gap to retry.");
      return;
    }
    backgroundHarvest.mutate({
      username: targetUsername,
      mediaIds: [mediaId],
      concurrency: 1,
      commentLimit: 0,
      includeReplies: true,
    });
  };

  const handleFetch = () => {
    if (!targetUsername) {
      toast.error("Please enter a valid Instagram username or profile URL");
      return;
    }

    if (userLoading) {
      toast.info("Preparing your workspace. Please try again in a moment.");
      return;
    }

    if (authed) {
      fullFetch.mutate({
        usernames: [targetUsername],
        includeFriends,
        friendsLimit,
        includeContent,
        contentLimit,
        includeComments,
        commentsLimit,
      });
    } else {
      const job = new URLSearchParams({
        workspaceFetch: "1",
        username: targetUsername,
        contentLimit: String(contentLimit),
        commentLimit: String(commentsLimit),
        includeComments: includeComments ? "1" : "0",
      });
      window.location.assign(`/api/studio-enter?next=${encodeURIComponent(`/instagram?${job.toString()}`)}`);
    }
  };

  const profilesPending = authed ? fullFetch.isPending : demoFetch.isPending;
  const results = (authed ? fullFetch.data?.results : demoFetch.data?.results) ?? [];
  const workspaceMedia = (savedMedia.data ?? []) as Array<{
    mediaId: string;
    commentCount: number | null;
    scrapedCount: number;
    status: string;
  }>;
  const workspaceProgress = workspaceMedia.reduce(
    (summary, media) => {
      summary.reported += Number(media.commentCount ?? 0);
      summary.scraped += Number(media.scrapedCount ?? 0);
      if (media.status === "complete") summary.complete += 1;
      else if (media.status === "pending") summary.pending += 1;
      else summary.partial += 1;
      return summary;
    },
    { reported: 0, scraped: 0, complete: 0, partial: 0, pending: 0 },
  );

  // ── Trending Search State ──
  const [tagsText, setTagsText] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const hashtagFetch = trpc.instaFetcher.hashtagFetch.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const parsedTags = tagsText
    .split(/[\s,\n]+/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
  const uniqueTags = Array.from(new Set(parsedTags.map((t) => t.toLowerCase())));
  const cappedTags = uniqueTags.slice(0, MAX_TAGS);
  const overTagCap = uniqueTags.length > MAX_TAGS;

  const handleTrending = () => {
    if (cappedTags.length === 0) {
      toast.error("Enter at least one hashtag");
      return;
    }
    hashtagFetch.mutate({ tags: cappedTags });
  };

  const hashResults = hashtagFetch.data?.results ?? [];
  const hasSession = hashtagFetch.data?.hasSession ?? true;

  const trendingItems = (() => {
    const seen = new Set<string>();
    const merged: (HashItem & { sourceTag: string })[] = [];
    for (const r of hashResults) {
      if (!r.ok || !r.items) continue;
      for (const it of r.items) {
        const key = it.id || it.shortcode;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...it, sourceTag: r.tag });
      }
    }
    const filtered = merged.filter((it) => {
      if (typeFilter === "reels") return it.kind === "reel";
      if (typeFilter === "posts") return it.kind !== "reel";
      return true;
    });
    filtered.sort((a, b) => {
      if (sortKey === "recent") return (b.takenAt ?? 0) - (a.takenAt ?? 0);
      if (sortKey === "likes") return b.likes - a.likes;
      if (sortKey === "comments") return b.comments - a.comments;
      return (b.views ?? 0) - (a.views ?? 0);
    });
    return filtered;
  })();

  const tagErrors = hashResults.filter((r) => !r.ok);
  const usedTags = hashResults.filter((r) => r.ok).map((r) => r.tag);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#f7f8fc] text-zinc-700">
      {/* Background tint */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 15% -10%, rgba(99,102,241,0.12), transparent 55%)," +
            "radial-gradient(110% 70% at 90% -5%, rgba(129,140,248,0.10), transparent 55%)," +
            "linear-gradient(180deg, #eef1fb 0%, #f7f8fc 45%, #ffffff 100%)",
        }}
      />

      {/* ── Top Navigation Bar ── */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <BrandLogo hideWordmarkOnMobile />
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/library"
              className="hidden rounded-full px-3 py-2 text-sm text-zinc-600 transition-colors hover:text-zinc-900 sm:inline-flex"
            >
              ← Back
            </Link>
            <Link href="/api/studio-enter" className={cn(PRIMARY_BTN, "px-4 py-2 text-sm")}>
              Enter Studio
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
        {/* ── Page Header ── */}
        <Reveal>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className={cn(SURFACE.kicker, "mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-600")}>
                <Sparkles className="h-3.5 w-3.5" /> High-Speed Instagram Scraper
              </p>
              <h1 className="font-display text-4xl uppercase leading-[0.95] tracking-tight text-zinc-900 sm:text-6xl">
                Instagram <span className="text-indigo-600">Intelligence</span>
              </h1>
              <p className="mt-3 max-w-2xl text-base text-zinc-600">
                Extract full profile data, posts, reels, video views, comments threads, and follower stats. Export complete structured datasets directly to CSV.
              </p>
            </div>
          </div>
        </Reveal>

        {/* ── Tool Mode Switcher ── */}
        <Reveal delay={0.04}>
          <div role="tablist" aria-label="Choose a tool" className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ToolOption
              active={mode === "profiles"}
              onSelect={() => setMode("profiles")}
              icon={<Users className="h-5 w-5" />}
              title="Profile & Content Scraper"
              subtitle="Scrape any profile, all posts, video views, comments per post & followers."
            />
            <ToolOption
              active={mode === "trending"}
              onSelect={() => setMode("trending")}
              icon={<span aria-hidden className="text-xl leading-none">🔥</span>}
              title="Trending Hashtags"
              subtitle="Discover viral reels & posts by hashtag, ranked by views & engagement."
            />
          </div>
        </Reveal>

        {/* ═════════════════════════════════════════════════════════════════════ */}
        {/* ── PROFILES MODE ── */}
        {/* ═════════════════════════════════════════════════════════════════════ */}
        {mode === "profiles" && (
          <>
            {/* ── Input & Options Panel ── */}
            <Reveal delay={0.06}>
              <div className={cn(SURFACE.card, "mt-8 border border-zinc-200/80 bg-white p-5 shadow-sm sm:p-7")}>
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="profileInput" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-600">
                      Instagram Profile URL or Handle
                    </label>
                    {targetUsername && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 font-mono text-xs font-medium text-indigo-700 border border-indigo-200">
                        Target: @{targetUsername}
                      </span>
                    )}
                  </div>

                  <div className="relative mt-2">
                    <input
                      id="profileInput"
                      type="text"
                      value={profileInput}
                      onChange={(e) => setProfileInput(e.target.value)}
                      placeholder="https://www.instagram.com/dr_arun_kumar_saxena or @dr_arun_kumar_saxena"
                      className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3.5 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-500">
                    Accepts any format: full URL, handle with @, or plain ID (e.g., <code className="rounded bg-zinc-100 px-1 py-0.5">dr_arun_kumar_saxena</code>).
                  </p>
                </div>

                {/* ── Granular Scraper Limits & Toggles ── */}
                <div className="mt-6 border-t border-zinc-100 pt-5">
                  <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Scraping Options & Limits
                  </p>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {/* 1. Posts Option */}
                    <div className={cn("rounded-xl border p-4 transition-all", includeContent ? "border-indigo-300 bg-indigo-50/40" : "border-zinc-200 bg-zinc-50/50")}>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-zinc-900">Include Posts & Reels</span>
                        <input
                          type="checkbox"
                          checked={includeContent}
                          onChange={(e) => setIncludeContent(e.target.checked)}
                          className="h-4 w-4 rounded border-zinc-300 accent-indigo-600"
                        />
                      </label>
                      <p className="mt-1 text-xs text-zinc-500">Extract posts, reels, video views & captions</p>

                      {includeContent && (
                        <div className="mt-3">
                          <label className="text-[11px] font-medium text-zinc-600">Post limit</label>
                          <input
                            type="number"
                            min={1}
                            max={authed ? 1000 : 50}
                            step={1}
                            value={contentLimit}
                            onChange={(e) => setContentLimit(Math.min(authed ? 1000 : 50, Math.max(1, Number(e.target.value) || 1)))}
                            aria-label="Posts and reels to fetch"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 outline-none focus:border-indigo-500"
                          />
                        </div>
                      )}
                    </div>

                    {/* 2. Comments Option */}
                    <div className={cn("rounded-xl border p-4 transition-all", includeComments ? "border-indigo-300 bg-indigo-50/40" : "border-zinc-200 bg-zinc-50/50")}>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-zinc-900">Include Comments</span>
                        <input
                          type="checkbox"
                          checked={includeComments}
                          onChange={(e) => setIncludeComments(e.target.checked)}
                          className="h-4 w-4 rounded border-zinc-300 accent-indigo-600"
                        />
                      </label>
                      <p className="mt-1 text-xs text-zinc-500">Download comment threads & replies per post</p>

                      {includeComments && (
                        <div className="mt-3">
                          <label className="text-[11px] font-medium text-zinc-600">Comments per post (0 = all available)</label>
                          <input
                            type="number"
                            min={0}
                            max={authed ? 500 : 100}
                            step={1}
                            value={commentsLimit}
                            onChange={(e) => setCommentsLimit(Math.min(authed ? 500 : 100, Math.max(0, Number(e.target.value) || 0)))}
                            aria-label="Comments per post"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 outline-none focus:border-indigo-500"
                          />
                        </div>
                      )}
                    </div>

                    {/* 3. Followers Option */}
                    <div className={cn("rounded-xl border p-4 transition-all", includeFriends ? "border-indigo-300 bg-indigo-50/40" : "border-zinc-200 bg-zinc-50/50")}>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-zinc-900">Include Followers</span>
                        <input
                          type="checkbox"
                          checked={includeFriends}
                          onChange={(e) => setIncludeFriends(e.target.checked)}
                          className="h-4 w-4 rounded border-zinc-300 accent-indigo-600"
                        />
                      </label>
                      <p className="mt-1 text-xs text-zinc-500">Follower & following profiles + quality score</p>

                      {includeFriends && (
                        <div className="mt-3">
                          <label className="text-[11px] font-medium text-zinc-600">Followers to fetch</label>
                          <input
                            type="number"
                            min={1}
                            max={authed ? 5000 : 200}
                            step={1}
                            value={friendsLimit}
                            onChange={(e) => setFriendsLimit(Math.min(authed ? 5000 : 200, Math.max(1, Number(e.target.value) || 1)))}
                            aria-label="Followers to fetch"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 outline-none focus:border-indigo-500"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {authed && (
                  <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
                      Google Drive CSV destination
                    </label>
                    {driveDestinations.data?.length ? (
                      <select
                        value={driveBrandId}
                        onChange={(event) => setDriveBrandId(event.target.value)}
                        className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-500"
                      >
                        {driveDestinations.data.map((destination: { brandId: string; brandName: string }) => (
                          <option key={destination.brandId} value={destination.brandId}>
                            {destination.brandName} — Instagram scraper
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="mt-1 text-xs text-zinc-500">Connect Google Drive for a brand to save a CSV automatically.</p>
                    )}
                    <p className="mt-2 text-xs text-zinc-500">Links stay local until you choose Sync. Sync creates one managed Google Sheet per profile and merges new rows into it.</p>
                  </div>
                )}

                {/* ── Submit Action Button ── */}
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleFetch}
                    disabled={profilesPending}
                    className={cn(PRIMARY_BTN, "px-7 py-3 text-base")}
                  >
                    {profilesPending ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" /> Scraping Profile & Details…
                      </>
                    ) : (
                      <>
                        <Search className="h-5 w-5" /> Scrape & Analyse Profile
                      </>
                    )}
                  </button>
                </div>
              </div>
            </Reveal>

            {authed && (
              <Reveal delay={0.08}>
                <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <InstagramProfileLibrary
                    authed={authed}
                    selectedUsername={targetUsername}
                    disabled={profilesPending || backgroundHarvest.isPending || loadWorkspace.isPending}
                    onSelect={(username) => {
                      setProfileInput(username);
                      if (driveBrandId) loadWorkspace.mutate({ username, brandId: driveBrandId });
                      else toast.success(`Loaded @${username}. Its saved links are ready below.`);
                    }}
                  />
                  <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm" aria-label="Selected Instagram workspace">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div><h2 className="text-lg font-semibold">Saved links for @{targetUsername || "profile"}</h2><p className="mt-1 text-xs text-zinc-500">Uses already-saved links only. It never rediscovers the feed before comment collection.</p></div>
                      <div className="flex flex-wrap gap-2"><button type="button" onClick={collectSavedLinks} disabled={!savedMedia.data?.length || backgroundHarvest.isPending} className={cn(PRIMARY_BTN, "px-4 py-2 text-sm")}>
                        {backgroundHarvest.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Queueing…</> : <><MessageSquare className="h-4 w-4" /> Collect comments ({savedMedia.data?.length ?? 0})</>}
                      </button><button type="button" onClick={retryLargestGaps} disabled={!savedMedia.data?.length || backgroundHarvest.isPending} className={cn(SECONDARY_BTN, "px-4 py-2 text-sm")}>
                        <MessageSquare className="h-4 w-4" /> Retry largest gaps
                      </button><button type="button" onClick={() => targetUsername && driveBrandId && loadWorkspace.mutate({ username: targetUsername, brandId: driveBrandId })} disabled={!targetUsername || !driveBrandId || loadWorkspace.isPending} className={cn(SECONDARY_BTN, "px-4 py-2 text-sm")}>
                        {loadWorkspace.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</> : <><FileSpreadsheet className="h-4 w-4" /> Load from Sheet</>}
                      </button><button type="button" onClick={() => targetUsername && driveBrandId && syncWorkspace.mutate({ username: targetUsername, brandId: driveBrandId })} disabled={!savedMedia.data?.length || !driveBrandId || syncWorkspace.isPending} className={cn(SECONDARY_BTN, "px-4 py-2 text-sm")}>
                        {syncWorkspace.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Syncing…</> : <><FileSpreadsheet className="h-4 w-4" /> Sync to Google Sheet</>}
                      </button></div>
                    </div>
                    {workspaceMedia.length > 0 && <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 text-xs text-indigo-950 sm:grid-cols-5" aria-label="Comment collection progress">
                      <div><span className="block text-indigo-600">Reported</span><strong>{workspaceProgress.reported.toLocaleString()}</strong></div>
                      <div><span className="block text-indigo-600">Scraped</span><strong>{workspaceProgress.scraped.toLocaleString()}</strong></div>
                      <div><span className="block text-indigo-600">Complete</span><strong>{workspaceProgress.complete}</strong></div>
                      <div><span className="block text-indigo-600">Partial</span><strong>{workspaceProgress.partial}</strong></div>
                      <div><span className="block text-indigo-600">Queued</span><strong>{workspaceProgress.pending}</strong></div>
                    </div>}
                    {savedMedia.isLoading ? <p className="mt-4 text-sm text-zinc-500">Loading saved links…</p>
                      : savedMedia.data?.length ? <div className="mt-4 max-h-44 overflow-auto rounded-xl border border-zinc-100"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-zinc-50 text-zinc-600"><tr><th className="p-2">Type</th><th className="p-2">Reported</th><th className="p-2">Scraped</th><th className="p-2">Delta</th><th className="p-2">Top / replies</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead><tbody>{savedMedia.data.map((media: { mediaId: string; kind: string | null; commentCount: number | null; scrapedCount: number; topLevelCount: number; replyCount: number; status: string }) => { const delta = Math.max(0, Number(media.commentCount ?? 0) - Number(media.scrapedCount ?? 0)); return <tr key={media.mediaId} className="border-t border-zinc-100"><td className="p-2 capitalize">{media.kind ?? "post"}</td><td className="p-2">{media.commentCount ?? "—"}</td><td className="p-2">{media.scrapedCount}</td><td className={cn("p-2 font-medium", delta > 0 && "text-red-700")}>{delta}</td><td className="p-2">{media.topLevelCount} / {media.replyCount}</td><td className="p-2 capitalize">{media.status}</td><td className="p-2"><button type="button" onClick={() => retrySavedMedia(media.mediaId, media.commentCount, media.scrapedCount)} disabled={delta <= 0 || backgroundHarvest.isPending} className={cn("rounded-md border px-2 py-1 font-medium", delta > 0 ? "border-indigo-200 text-indigo-700 hover:bg-indigo-50" : "cursor-not-allowed border-zinc-100 text-zinc-400")}>Retry</button></td></tr>; })}</tbody></table></div>
                        : <p className="mt-4 text-sm text-zinc-500">Select a saved profile or run link discovery to create its workspace.</p>}
                  </section>
                </div>
              </Reveal>
            )}

            {/* ── Loading Skeleton ── */}
            {profilesPending && (
              <div className="mt-8 space-y-4">
                <ProfileSkeleton />
              </div>
            )}

            {/* ── Scraped Results ── */}
            {!profilesPending && results.length > 0 && (
              <div className="mt-8 space-y-8">
                {activeCommentRun.data && (
                  <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 text-sm text-indigo-950">
                    <div className="flex items-center gap-2 font-semibold">
                      <Loader2 className={cn("h-4 w-4", ["queued", "running"].includes(activeCommentRun.data.status) && "animate-spin")} />
                      Comment collection is {activeCommentRun.data.status}
                    </div>
                    <p className="mt-1 text-indigo-800">
                      Latest links are saved locally. {activeCommentRun.data.total_comments} comments have been retained from {activeCommentRun.data.post_limit} posts and reels so far.
                    </p>
                  </div>
                )}
                {results.map((r) =>
                  r.ok && r.profile ? (
                    <EnhancedProfileCard
                      key={r.username}
                      r={r}
                      onOpenComments={(post) => setActiveCommentPost(post)}
                    />
                  ) : (
                    <div
                      key={r.username}
                      className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-5"
                    >
                      <AlertTriangle className="h-6 w-6 shrink-0 text-red-600" />
                      <span className="text-sm text-zinc-800">
                        Failed to fetch <strong className="text-zinc-950">@{r.username}</strong>: {r.error}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}
          </>
        )}

        {/* ═════════════════════════════════════════════════════════════════════ */}
        {/* ── TRENDING MODE ── */}
        {/* ═════════════════════════════════════════════════════════════════════ */}
        {mode === "trending" && (
          <>
            <Reveal delay={0.06}>
              <div className={cn(SURFACE.card, "mt-8 border border-zinc-200 bg-white p-5 shadow-sm sm:p-7")}>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="tags" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-600">
                    Hashtags to Chase
                  </label>
                  <span className={cn("font-mono text-xs", overTagCap ? "text-amber-600" : "text-zinc-500")}>
                    {cappedTags.length}/{MAX_TAGS}
                  </span>
                </div>

                <textarea
                  id="tags"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  rows={2}
                  placeholder="india, news, viral, reel"
                  className="mt-2.5 w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-1.5 text-xs text-zinc-500">
                  Comma or space separated — up to {MAX_TAGS} tags per run.
                </p>

                <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="sort" className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                      Rank By
                    </label>
                    <select
                      id="sort"
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500"
                    >
                      {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                        <option key={k} value={k}>
                          {SORT_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="type" className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                      Media Type
                    </label>
                    <select
                      id="type"
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                      className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500"
                    >
                      <option value="all">All content</option>
                      <option value="reels">Reels only</option>
                      <option value="posts">Posts only</option>
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={handleTrending}
                    disabled={hashtagFetch.isPending}
                    className={cn(PRIMARY_BTN, "px-6 py-2.5 text-sm sm:ml-auto")}
                  >
                    {hashtagFetch.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Finding…
                      </>
                    ) : (
                      <>
                        <Search className="h-4 w-4" /> Find Trending Content
                      </>
                    )}
                  </button>
                </div>
              </div>
            </Reveal>

            {hashtagFetch.isPending && (
              <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <TrendingSkeleton key={i} />
                ))}
              </div>
            )}

            {!hashtagFetch.isPending && hashtagFetch.data && (
              <div className="mt-8">
                {tagErrors.length > 0 && (
                  <div className="mb-4 space-y-2">
                    {tagErrors.map((r) => (
                      <AmberNote key={r.tag}>
                        <strong>#{r.tag}</strong> — {r.error}
                      </AmberNote>
                    ))}
                  </div>
                )}

                {trendingItems.length > 0 ? (
                  <>
                    <p className="mb-4 text-sm text-zinc-600">
                      Showing <strong className="text-zinc-900">{trendingItems.length}</strong> trending items across {usedTags.map((t) => `#${t}`).join(" ")} — sorted by <span className="font-semibold text-indigo-600">{SORT_LABEL[sortKey]}</span>.
                    </p>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                      {trendingItems.map((it, i) => (
                        <TrendingCard key={it.id || it.shortcode || i} it={it} tag={it.sourceTag} sortKey={sortKey} />
                      ))}
                    </div>
                  </>
                ) : (
                  tagErrors.length === 0 && (
                    <div className="flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 p-12 text-center">
                      <p className="font-display text-lg uppercase tracking-tight text-zinc-900">No content found</p>
                    </div>
                  )
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Modal for Inspecting Comments on a Post ── */}
      {activeCommentPost && (
        <CommentsModal post={activeCommentPost} onClose={() => setActiveCommentPost(null)} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  ENHANCED PROFILE CARD WITH COMPREHENSIVE STATS & CSV EXPORTS
 * ──────────────────────────────────────────────────────────────────────────── */

type FetchResultItem = NonNullable<
  ReturnType<typeof trpc.instaFetcher.fetchProfiles.useMutation>["data"]
>["results"][number];

function EnhancedProfileCard({
  r,
  onOpenComments,
}: {
  r: FetchResultItem;
  onOpenComments: (post: InstaMediaItem) => void;
}) {
  const p = r.profile!;
  const stats = r.stats;
  const posts = (r.content && r.content.length > 0 ? r.content : p.recentPosts) as InstaMediaItem[];

  // Total comments actually scraped across posts
  const totalCommentsScraped = posts.reduce(
    (acc, item) => acc + (item.commentsData?.length || 0),
    0,
  );

  return (
    <Reveal className={cn(SURFACE.card, "overflow-hidden border border-zinc-200 bg-white p-6 shadow-md sm:p-8")}>
      {/* ── Profile Header ── */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {p.profilePic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaProxy(p.profilePic)}
            alt={p.username}
            className="h-20 w-20 shrink-0 rounded-full border-2 border-zinc-200 object-cover shadow-sm sm:h-24 sm:w-24"
          />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 border-zinc-200 bg-zinc-100 sm:h-24 sm:w-24">
            <Users className="h-8 w-8 text-zinc-400" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://instagram.com/${p.username}`}
              target="_blank"
              rel="noreferrer"
              className="font-display text-2xl uppercase tracking-tight text-zinc-900 hover:text-indigo-600 transition-colors"
            >
              @{p.username}
            </a>
            {p.isVerified && (
              <span title="Verified Account">
                <CheckCircle2 className="h-5 w-5 text-sky-500" />
              </span>
            )}
            {p.isPrivate && (
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-700">
                <Lock className="h-3 w-3" /> Private
              </span>
            )}
            {p.isBusiness && (
              <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-700">
                Business
              </span>
            )}
            {p.category && (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                {p.category}
              </span>
            )}
          </div>

          {p.fullName && <p className="mt-1 text-base font-semibold text-zinc-800">{p.fullName}</p>}
          {p.bio && <p className="mt-1.5 whitespace-pre-line text-sm text-zinc-600 leading-relaxed">{p.bio}</p>}
          {p.externalUrl && (
            <a
              href={p.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
            >
              <Link2 className="h-3.5 w-3.5" /> {p.externalUrl}
            </a>
          )}
        </div>

        {/* ── Direct Link to Instagram ── */}
        <div className="sm:ml-auto">
          <a
            href={`https://www.instagram.com/${p.username}/`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 shadow-sm transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Instagram Page
          </a>
        </div>
      </div>

      {/* ── Statistics Summary Bar ── */}
      <div className="mt-7 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700">
            📊 Scraped Stats & Intelligence
          </span>
          <span className="text-xs text-zinc-500 font-medium">
            Live extracted metrics
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <MetricTile
            label="Posts Scraped"
            value={`${posts.length} / ${fmt(p.postsCount)}`}
            sub="Total on profile"
            icon={<Layers className="h-4 w-4 text-indigo-600" />}
          />
          <MetricTile
            label="Comments Scraped"
            value={fmt(totalCommentsScraped || stats?.totalCommentsScraped)}
            sub="Across fetched posts"
            icon={<MessageSquare className="h-4 w-4 text-blue-600" />}
          />
          <MetricTile
            label="Followers"
            value={fmt(p.followers)}
            sub={r.followers ? `${r.followers.length} scraped` : "Total audience"}
            icon={<Users className="h-4 w-4 text-emerald-600" />}
          />
          <MetricTile
            label="Following"
            value={fmt(p.following)}
            sub={r.following ? `${r.following.length} scraped` : "Following count"}
            icon={<Users className="h-4 w-4 text-teal-600" />}
          />
          <MetricTile
            label="Total Likes"
            value={fmt(stats?.totalLikesScraped || posts.reduce((a, b) => a + (b.likes || 0), 0))}
            sub="Across scraped posts"
            icon={<Heart className="h-4 w-4 text-rose-600" />}
          />
          <MetricTile
            label="Total Views"
            value={fmt(stats?.totalViewsScraped || posts.reduce((a, b) => a + (b.views || 0), 0))}
            sub="Video & reel plays"
            icon={<Play className="h-4 w-4 text-amber-600" />}
          />
        </div>
      </div>

      {/* ── CSV Export Toolbar ── */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-y border-zinc-200/80 py-4">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-semibold text-zinc-900">Export Scraped Data:</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportProfileSummaryCsv(r as any)}
            className={cn(SECONDARY_BTN, "px-3.5 py-1.5 text-xs font-medium")}
          >
            <Download className="h-3.5 w-3.5 text-zinc-500" /> Profile Summary CSV
          </button>
          {posts.length > 0 && (
            <button
              type="button"
              onClick={() => exportPostsCsv(r as any)}
              className={cn(SECONDARY_BTN, "px-3.5 py-1.5 text-xs font-medium")}
            >
              <Download className="h-3.5 w-3.5 text-zinc-500" /> Posts CSV ({posts.length})
            </button>
          )}
          {totalCommentsScraped > 0 && (
            <button
              type="button"
              onClick={() => exportCommentsCsv(r as any)}
              className={cn(SECONDARY_BTN, "px-3.5 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border-indigo-200")}
            >
              <Download className="h-3.5 w-3.5 text-indigo-600" /> Comments CSV ({totalCommentsScraped})
            </button>
          )}
          {r.followers && r.followers.length > 0 && (
            <button
              type="button"
              onClick={() => exportFollowersCsv(r as any, "followers")}
              className={cn(SECONDARY_BTN, "px-3.5 py-1.5 text-xs font-medium")}
            >
              <Download className="h-3.5 w-3.5 text-zinc-500" /> Followers CSV ({r.followers.length})
            </button>
          )}
        </div>
      </div>

      {r.linksSaved != null && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
          <span className="font-semibold">{r.linksSaved} latest post and Reel links saved locally.</span>{" "}
          They are displayed below now and are retained for comment collection and the next Drive sync.
        </div>
      )}

      {r.contentError && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <span className="font-semibold">Link discovery could not complete:</span> {r.contentError}
        </div>
      )}

      {/* ── Audience Quality Bar (if followers were sampled) ── */}
      {r.followersQuality && r.followersQuality.sampled > 0 && (
        <div className="mt-6">
          <AudienceQualityBar q={r.followersQuality} />
        </div>
      )}

      {/* ── Content Feed Section ── */}
      {posts.length > 0 && (
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <SectionLabel>
              Scraped Posts & Reels ({posts.length} of {p.postsCount})
            </SectionLabel>
            <span className="text-xs text-zinc-500">
              Click &quot;View Comments&quot; to inspect comment threads
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post, i) => (
              <PostCardItem
                key={post.id || post.shortcode || i}
                post={post}
                username={p.username}
                onOpenComments={() => onOpenComments(post)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Followers & Following Lists ── */}
      {(r.followers || r.following || r.friendsError) && (
        <div className="mt-8 space-y-3">
          {r.friendsError && <AmberNote>{r.friendsError}</AmberNote>}
          {r.followers && (
            <FriendList title="Followers List" users={r.followers} truncated={r.friendsTruncated} />
          )}
          {r.following && (
            <FriendList title="Following List" users={r.following} truncated={r.friendsTruncated} />
          )}
        </div>
      )}
    </Reveal>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  INDIVIDUAL POST CARD COMPONENT
 * ──────────────────────────────────────────────────────────────────────────── */

const KIND_LABEL: Record<string, string> = {
  post: "Post",
  video: "Video",
  reel: "Reel",
  carousel: "Carousel",
};

function PostCardItem({
  post,
  username,
  onOpenComments,
}: {
  post: InstaMediaItem;
  username: string;
  onOpenComments: () => void;
}) {
  const isVideo = (post.kind === "reel" || post.kind === "video") && !!post.videoUrl;
  const downloadUrl = post.videoUrl ?? post.displayUrl;
  const downloadHref = downloadUrl
    ? `${mediaProxy(downloadUrl)}&dl=${encodeURIComponent(`${username}_${post.shortcode}`)}`
    : null;

  const commentsCount = post.commentsData?.length ?? 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm hover:shadow transition-all">
      <div className="relative aspect-square bg-zinc-100">
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={mediaProxy(post.videoUrl)}
            poster={mediaProxy(post.displayUrl)}
            controls
            preload="none"
            className="h-full w-full object-cover"
          />
        ) : post.displayUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaProxy(post.displayUrl)} alt="" className="h-full w-full object-cover" />
        ) : null}

        <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-sm">
          {KIND_LABEL[post.kind] || "Post"}
          {post.kind === "carousel" && post.carousel?.length ? ` · ${post.carousel.length}` : ""}
        </span>

        {post.takenAt && (
          <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white/90">
            {new Date(post.takenAt * 1000).toLocaleDateString()}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        {/* Stats Row */}
        <div className="flex items-center gap-3 text-xs font-semibold text-zinc-700">
          <span className="inline-flex items-center gap-1 text-rose-600">
            <Heart className="h-3.5 w-3.5 fill-rose-100" /> {fmt(post.likes)}
          </span>
          <span className="inline-flex items-center gap-1 text-blue-600">
            <MessageSquare className="h-3.5 w-3.5 fill-blue-100" /> {fmt(post.comments)}
          </span>
          {post.views !== null && (
            <span className="inline-flex items-center gap-1 text-amber-600">
              <Play className="h-3.5 w-3.5 fill-amber-100" /> {fmt(post.views)}
            </span>
          )}
        </div>

        {/* Location if present */}
        {post.location?.name && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 border border-emerald-200">
              <MapPin className="h-2.5 w-2.5" /> {post.location.name}
            </span>
          </div>
        )}

        {/* Caption */}
        {post.caption ? (
          <p className="mt-2.5 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-600 leading-relaxed">
            {post.caption}
          </p>
        ) : (
          <p className="mt-2 text-xs italic text-zinc-400">No caption</p>
        )}

        {/* Action Buttons */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 border-t border-zinc-100">
          {downloadHref && (
            <a
              href={downloadHref}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 shadow-xs"
            >
              <Download className="h-3 w-3 text-zinc-500" /> Download
            </a>
          )}

          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50/50 shadow-xs"
            >
              <ExternalLink className="h-3 w-3" /> View
            </a>
          )}

          {/* Comments Button */}
          {commentsCount > 0 ? (
            <button
              type="button"
              onClick={onOpenComments}
              className="ml-auto inline-flex items-center gap-1 rounded-lg bg-indigo-50 border border-indigo-200 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
            >
              <MessageSquare className="h-3 w-3" /> {commentsCount} Comments
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenComments}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-50"
            >
              Comments
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  COMMENTS MODAL / INSPECTION DIALOG
 * ──────────────────────────────────────────────────────────────────────────── */

function CommentsModal({
  post,
  onClose,
}: {
  post: InstaMediaItem;
  onClose: () => void;
}) {
  const comments = post.commentsData || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-4">
          <div>
            <h3 className="font-display text-lg uppercase tracking-tight text-zinc-900 flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-indigo-600" />
              Scraped Comments ({comments.length})
            </h3>
            <p className="text-xs text-zinc-500">
              Post Shortcode: <code className="font-mono text-zinc-800">{post.shortcode}</code> · Reported total: {fmt(post.comments)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Comments List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {comments.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-500">
              <MessageSquare className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
              No comments were extracted for this post.
            </div>
          ) : (
            comments.map((c: InstaComment) => (
              <div
                key={c.id}
                className={cn(
                  "rounded-xl border p-3 text-sm transition-all",
                  c.depth > 0 ? "ml-6 border-indigo-100 bg-indigo-50/30" : "border-zinc-200 bg-zinc-50/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {c.profilePic ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaProxy(c.profilePic)}
                        alt=""
                        className="h-6 w-6 rounded-full object-cover border border-zinc-200"
                      />
                    ) : (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-bold text-zinc-600">
                        {c.username[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    <a
                      href={`https://instagram.com/${c.username}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-zinc-900 hover:text-indigo-600 transition-colors"
                    >
                      @{c.username}
                    </a>
                    {c.isVerified && <CheckCircle2 className="h-3.5 w-3.5 text-sky-500" />}
                    {c.depth > 0 && (
                      <span className="rounded bg-indigo-100 px-1.5 py-0.2 text-[10px] font-medium text-indigo-700">
                        Reply
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    {c.likeCount > 0 && <span>❤ {c.likeCount}</span>}
                    {c.createdAt && (
                      <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>

                <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed">
                  {c.text}
                </p>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-200 bg-zinc-50 px-5 py-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  METRIC TILE & HELPER WIDGETS
 * ──────────────────────────────────────────────────────────────────────────── */

function MetricTile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-3.5 shadow-xs">
      <div className="flex items-center justify-between text-zinc-400">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
        {icon}
      </div>
      <p className="mt-1 font-display text-xl uppercase tracking-tight text-zinc-900">{value}</p>
      <p className="mt-0.5 text-[10px] text-zinc-400 font-medium">{sub}</p>
    </div>
  );
}

function ToolOption({
  active,
  onSelect,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-all sm:p-6",
        active
          ? "border-indigo-500 bg-indigo-50/60 shadow-[0_12px_32px_-16px_rgba(79,70,229,0.25)]"
          : "border-zinc-200 bg-white hover:border-indigo-300 hover:shadow-sm",
      )}
    >
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors",
          active ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-600 group-hover:bg-indigo-100 group-hover:text-indigo-600",
        )}
      >
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className={cn("font-display text-lg uppercase tracking-tight transition-colors", active ? "text-indigo-700" : "text-zinc-900")}>
          {title}
        </span>
        <span className={cn("mt-1 block text-sm leading-snug", active ? "text-indigo-700/80" : "text-zinc-600")}>
          {subtitle}
        </span>
      </span>

      <span className="shrink-0 pt-0.5">
        {active ? (
          <CheckCircle2 className="h-5 w-5 text-indigo-600" />
        ) : (
          <span className="block h-5 w-5 rounded-full border-2 border-zinc-300 transition-colors group-hover:border-indigo-300" />
        )}
      </span>
    </button>
  );
}

function AudienceQualityBar({
  q,
}: {
  q: {
    sampled: number;
    verifiedPct: number;
    privatePct: number;
    noPhotoPct: number;
    qualityScore: number;
    flags: string[];
  };
}) {
  const score = q.qualityScore;
  const tone = score >= 70 ? "text-emerald-600" : score >= 45 ? "text-amber-600" : "text-red-600";
  const bar = score >= 70 ? "bg-emerald-500" : score >= 45 ? "bg-amber-500" : "bg-red-500";
  const label = score >= 70 ? "Healthy" : score >= 45 ? "Mixed" : "Low-quality";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600">Audience Quality Score</span>
        <span className={cn("text-sm font-bold", tone)}>
          {score}/100 · {label}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
        <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${score}%` }} />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 font-medium">
        <span>
          Sampled: <strong className="text-zinc-900">{q.sampled}</strong>
        </span>
        <span>
          Verified: <strong className="text-zinc-900">{q.verifiedPct}%</strong>
        </span>
        <span>
          Private: <strong className="text-zinc-900">{q.privatePct}%</strong>
        </span>
        <span>
          No Photo: <strong className="text-zinc-900">{q.noPhotoPct}%</strong>
        </span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700">{children}</p>;
}

function AmberNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> {children}
    </p>
  );
}

function ProfileSkeleton() {
  return (
    <div className={cn(SURFACE.card, "p-6 sm:p-8")}>
      <div className="flex gap-5">
        <div className="h-20 w-20 shrink-0 animate-pulse rounded-full bg-zinc-200" />
        <div className="flex-1 space-y-3">
          <div className="h-6 w-48 animate-pulse rounded bg-zinc-200" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200" />
          <div className="flex gap-6 pt-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 w-20 animate-pulse rounded bg-zinc-200" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendingSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="aspect-square animate-pulse bg-zinc-100" />
      <div className="space-y-2 p-3">
        <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-100" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-100" />
      </div>
    </div>
  );
}

function TrendingCard({
  it,
  tag,
  sortKey,
}: {
  it: HashItem;
  tag: string;
  sortKey: SortKey;
}) {
  const isVideo = (it.kind === "reel" || it.kind === "video") && !!it.videoUrl;
  const downloadUrl = it.videoUrl ?? it.displayUrl;
  const downloadHref = downloadUrl
    ? `${mediaProxy(downloadUrl)}&dl=${encodeURIComponent(`${tag}_${it.shortcode}`)}`
    : null;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="relative aspect-square bg-zinc-100">
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={mediaProxy(it.videoUrl)}
            poster={mediaProxy(it.displayUrl)}
            controls
            muted
            preload="none"
            className="h-full w-full object-cover"
          />
        ) : it.displayUrl ? (
          <a href={it.url} target="_blank" rel="noreferrer" className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaProxy(it.displayUrl)} alt="" className="h-full w-full object-cover" />
          </a>
        ) : null}

        <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
          {KIND_LABEL[it.kind] || "Post"}
        </span>
        <span className="absolute right-2 top-2 rounded-full bg-white/95 px-2.5 py-0.5 text-[10px] font-semibold text-indigo-700 shadow-xs">
          #{tag}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-3 text-xs font-semibold">
          {it.views !== null && (
            <span className={cn("inline-flex items-center gap-1", sortKey === "views" ? "text-indigo-600" : "text-zinc-600")}>
              ▶ {fmt(it.views)}
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1", sortKey === "likes" ? "text-indigo-600" : "text-zinc-600")}>
            ❤ {fmt(it.likes)}
          </span>
          <span className={cn("inline-flex items-center gap-1", sortKey === "comments" ? "text-indigo-600" : "text-zinc-600")}>
            💬 {fmt(it.comments)}
          </span>
        </div>

        {it.caption && (
          <p className="line-clamp-2 text-xs text-zinc-600 leading-relaxed">
            {it.caption}
          </p>
        )}

        <div className="mt-auto flex items-center gap-2 pt-2 border-t border-zinc-100">
          {downloadHref && (
            <a
              href={downloadHref}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
            >
              <Download className="h-3 w-3" /> Download
            </a>
          )}
          {it.url && (
            <a
              href={it.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline ml-auto"
            >
              <ExternalLink className="h-3 w-3" /> Open
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function FriendList({
  title,
  users,
  truncated,
}: {
  title: string;
  users: {
    id: string;
    username: string;
    fullName: string;
    isPrivate: boolean;
    isVerified: boolean;
    profilePic?: string | null;
  }[];
  truncated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Copy failed"),
    );
  };
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-900 hover:bg-zinc-50 transition-colors focus:outline-none"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-zinc-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-400" />
        )}
        {title}
        <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 font-semibold">
          {users.length}
          {truncated ? "+" : ""}
        </span>
        <span className="ml-auto flex gap-3" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => copy(users.map((u) => u.id).join("\n"), `${users.length} IDs`)}
            className="text-xs text-indigo-600 hover:underline font-medium"
          >
            Copy IDs
          </button>
          <button
            type="button"
            onClick={() => copy(users.map((u) => u.username).join("\n"), `${users.length} usernames`)}
            className="text-xs text-indigo-600 hover:underline font-medium"
          >
            Copy Usernames
          </button>
        </span>
      </div>
      {open && (
        <div className="max-h-64 divide-y divide-zinc-100 overflow-y-auto border-t border-zinc-200">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2.5 px-4 py-2 text-sm">
              {u.profilePic ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaProxy(u.profilePic)}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-full border border-zinc-200 object-cover"
                />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-500">
                  {u.username?.[0]?.toUpperCase() || "?"}
                </span>
              )}
              <a
                href={`https://instagram.com/${u.username}`}
                target="_blank"
                rel="noreferrer"
                className="truncate font-semibold text-zinc-900 hover:text-indigo-600"
              >
                @{u.username}
              </a>
              {u.isVerified && <CheckCircle2 className="h-3 w-3 shrink-0 text-sky-500" />}
              {u.isPrivate && <Lock className="h-3 w-3 shrink-0 text-zinc-400" />}
              {u.fullName && (
                <span className="hidden truncate text-zinc-500 sm:inline text-xs">{u.fullName}</span>
              )}
              <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400">{u.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
