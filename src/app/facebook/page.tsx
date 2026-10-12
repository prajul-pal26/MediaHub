"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { useUser } from "@/lib/hooks/use-user";
import { FacebookCustomProfiles } from "@/components/media/FacebookCustomProfiles";
import { FacebookProfileLibrary } from "@/components/media/FacebookProfileLibrary";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/landing/lib/motion";
import { SURFACE } from "@/components/landing/lib/constants";
import { BrandLogo } from "@/components/common/BrandLogo";
import {
  Loader2,
  CheckCircle2,
  MessageSquare,
  Link2,
  Download,
  AlertTriangle,
  Users,
  Play,
  Heart,
  Share2,
  RefreshCw,
  ImageIcon,
  Eye,
  ExternalLink,
  Phone,
  Mail,
  Globe,
  ThumbsUp,
  X,
  Smile,
} from "lucide-react";
import type {
  FbBrowserPage,
  FbBrowserPost,
  FbBrowserComment,
  FbBrowserReactor,
} from "@/server/services/facebook/browser-fetcher";
import {
  flattenFbComments,
} from "@/lib/fb-export";
import { summarizeCommentRetries } from "@/lib/fb-detail-retry";

type FbResult = { query: string; ok: boolean; page?: FbBrowserPage; error?: string };
type PersistedDetailsJob = { jobId: string; ownerLeaseId?: string; userId: string; startedAt: number };
const DETAILS_JOB_STORAGE_KEY = "mh_fb_active_details_job";

function readPersistedDetailsJob(): PersistedDetailsJob | null {
  try {
    const raw = sessionStorage.getItem(DETAILS_JOB_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedDetailsJob>;
    return typeof value.jobId === "string" && typeof value.userId === "string" && typeof value.startedAt === "number"
      ? value as PersistedDetailsJob
      : null;
  } catch {
    return null;
  }
}

function persistDetailsJob(job: PersistedDetailsJob | null) {
  try {
    if (job) sessionStorage.setItem(DETAILS_JOB_STORAGE_KEY, JSON.stringify(job));
    else sessionStorage.removeItem(DETAILS_JOB_STORAGE_KEY);
  } catch {}
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function workerStageLabel(stage: string | undefined) {
  const labels: Record<string, string> = {
    opening: "Opening Facebook",
    captions: "Loading caption",
    reactions: "Loading reactions",
    comments: "Loading comments & replies",
    saving: "Saving local progress",
  };
  return labels[stage ?? ""] ?? "Waiting";
}

/** Route CDN media through proxy so it isn't blocked by referrers */
const mediaProxy = (url: string | null | undefined) =>
  url ? `/api/insta-media?url=${encodeURIComponent(url)}` : "";
const savedPreviewKey = (contentType: "posts" | "reels", postId: string | null | undefined) => `${contentType}:${postId ?? ""}`;

function commentStopLabel(reason: string | undefined): string | null {
  if (!reason) return null;
  const labels: Record<string, string> = {
    "requested-limit": "Requested limit reached",
    "reported-count-reached": "Reported comment count reached",
    "no-comments": "No comments available",
    "visible-comments-exhausted": "All visible comments exposed in All comments were collected",
    "some-comments-unavailable": "Some comments were unavailable",
    "filtered-comments": "Facebook displayed filtered comments",
    "loading-stalled": "Facebook stopped loading more comments",
    "loading-interrupted": "Comments loading was interrupted",
    "opening-media": "The media page did not finish opening",
    "checking-access": "Facebook access check did not finish",
    "reading-metadata": "Media metadata did not finish loading",
    "reading-reactions": "Reaction details did not finish loading",
    "loading-comments": "Comments panel did not finish loading",
    "time-budget": "Time limit reached",
    timeout: "Time limit reached",
    cancelled: "Stopped by request",
    "storage-limit": "Result size limit reached",
    authentication: "Facebook session needs attention",
    "rate-limit": "Facebook temporarily limited requests",
    "fetch-error": "Comments could not be retrieved",
    "job-unavailable": "The comments job expired or the server restarted",
  };
  return labels[reason.replace(/_/g, "-")] ?? null;
}

const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors disabled:opacity-60 disabled:pointer-events-none shadow-sm";
const SECONDARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full border border-zinc-300 bg-white text-zinc-800 font-medium hover:bg-zinc-50 transition-colors shadow-sm";

const DELTA_BUCKETS = [
  { key: "under-10", label: "Under 10", min: 0, max: 9 },
  ...Array.from({ length: 9 }, (_, index) => {
    const min = (index + 1) * 10;
    return { key: `${min}-${min + 9}`, label: `${min}–${min + 9}`, min, max: min + 9 };
  }),
  { key: "100-plus", label: "100+", min: 100, max: Infinity },
] as const;

type DeltaBucketKey = typeof DELTA_BUCKETS[number]["key"];
type SavedDeltaFilter = "all" | "complete" | "missing" | DeltaBucketKey;

function rawCommentDelta(post: FbBrowserPost): number | null {
  const reported = post.commentsReportedCount;
  if (reported == null) return null;
  return Math.max(0, reported - flattenFbComments(post.commentsData ?? []).length);
}

/** The certified public-view count is the only delta basis that may differ
 * from Facebook's raw badge. It requires two matching clean Newest scans. */
function reportedDeltaBasis(post: FbBrowserPost): number | null {
  // Prefer the explicit Newest-panel count. Rows not yet scanned still use the
  // raw badge so their metadata and retry bucket remain actionable.
  return post.commentsReportedDeltaCount ?? post.commentsReportedCount ?? null;
}

function verifiedRetrievableTarget(post: FbBrowserPost): number | null {
  return post.commentsVerifiedAccessibleCount ?? null;
}

function commentDelta(post: FbBrowserPost): number | null {
  const reported = reportedDeltaBasis(post);
  if (reported == null) return null;
  const scraped = flattenFbComments(post.commentsData ?? []).length;
  return Math.max(0, reported - scraped);
}

function deltaBucket(delta: number): DeltaBucketKey {
  return DELTA_BUCKETS.find((bucket) => delta >= bucket.min && delta <= bucket.max)?.key ?? "100-plus";
}

/** Cleanly extracts handle and target kind from any Facebook URL or input */
function detectFbTarget(raw: string): { label: string; kind: "page" | "profile" | "group" | "post" } {
  if (!raw) return { label: "", kind: "page" };
  const s = raw.trim();

  // Groups
  if (/facebook\.com\/groups\//i.test(s)) {
    const m = /facebook\.com\/groups\/([^/?#]+)/i.exec(s);
    return { label: `Group: ${m?.[1] || "group"}`, kind: "group" };
  }

  // Post permalinks
  if (/\/(posts|videos|reel|photos)\/|story_fbid=/i.test(s)) {
    return { label: "Post Permalink", kind: "post" };
  }

  // profile.php?id=1000...
  const profMatch = s.match(/profile\.php\?id=(\d+)/i);
  if (profMatch && profMatch[1]) {
    return { label: `Profile: ID ${profMatch[1]}`, kind: "profile" };
  }

  // people/Name/1000123...
  const peopleMatch = s.match(/facebook\.com\/people\/([^/]+)\/(\d+)/i);
  if (peopleMatch && peopleMatch[2]) {
    return { label: `Profile: ${decodeURIComponent(peopleMatch[1]).replace(/[-_]/g, " ")} (${peopleMatch[2]})`, kind: "profile" };
  }

  // Plain numeric ID
  if (/^\d{6,}$/.test(s)) {
    return { label: `Profile: ID ${s}`, kind: "profile" };
  }

  const clean = s
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i, "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .trim();

  return { label: `@${clean || s}`, kind: "page" };
}

export default function FacebookInstantPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { profile } = useUser();
  const authed = !!profile;
  const profileUtils = trpc.useUtils();
  const addProfile = trpc.fbProfileLibrary.add.useMutation({onSuccess:()=>{void profileUtils.fbProfileLibrary.custom.invalidate();}});
  const updateProfile = trpc.fbProfileLibrary.update.useMutation();
  const retryPartial = trpc.fbProfileLibrary.retryPartial.useMutation();
  const retryDelta = trpc.fbProfileLibrary.retryDelta.useMutation();
  const syncWorkspace = trpc.fbProfileLibrary.syncToSheet.useMutation();

  // ── Single Input & Scraping Options ──
  const [targetInput, setTargetInput] = useState("https://www.facebook.com/arunkumarmlabjp/");
  const [savedSelection, setSavedSelection] = useState<{url:string;brandId:string;userId:string}|null>(null);
  const [savedDeltaFilter, setSavedDeltaFilter] = useState<SavedDeltaFilter>("all");
  const [selectedTypes, setSelectedTypes] = useState({ posts: true, reels: false });
  const [limits, setLimits] = useState({ posts: "200", reels: "200" });
  const [includeComments, setIncludeComments] = useState(false);
  const [includeReactions, setIncludeReactions] = useState(false);
  const [commentsLimit, setCommentsLimit] = useState("500");
  const [completed, setCompleted] = useState<{
    runId: number;
    userId: string | null;
    exportRunId: string;
    exportBrandId?: string;
    serverManagedExport?: boolean;
    requestKey: string;
    requestedComments: boolean;
    requestedReactions: boolean;
    requestedMetadata: boolean;
    results: FbResult[];
  } | null>(null);
  const [failure, setFailure] = useState<{ requestKey: string; message: string } | null>(null);
  const [commentsJob, setCommentsJob] = useState<{ jobId: string; runId: number; userId: string; ownerLeaseId: string } | null>(null);
  const [commentsFailure, setCommentsFailure] = useState<{ runId: number; message: string } | null>(null);
  const [detailsRecoveryNotice, setDetailsRecoveryNotice] = useState<string | null>(null);
  const [savedPreviewImages, setSavedPreviewImages] = useState<Record<string, string>>({});
  const [isRestoringPreviews, setIsRestoringPreviews] = useState(false);
  const [isUpdatingMlas, setIsUpdatingMlas] = useState(false);
  const runSequence = useRef(0);
  const commentsJobRef = useRef<string | null>(null);
  const requestedPreviewKeys = useRef(new Set<string>());
  const [exportBrandChoice, setExportBrandChoice] = useState("");
  const [saveVersion, setSaveVersion] = useState(0);
  const [serverExportRetryKey, setServerExportRetryKey] = useState<string | null>(null);
  const [sheetSave, setSheetSave] = useState<{
    key: string;
    phase: "saving" | "saved" | "error";
    stage: "media" | "details";
    url?: string;
    folderUrl?: string;
    error?: string;
  } | null>(null);
  const [workspaceSync, setWorkspaceSync] = useState<{
    profileUrl: string;
    phase: "saving" | "saved" | "error";
    url?: string;
    error?: string;
  } | null>(null);
  const sheetWrites = useRef({ completed: new Set<string>(), blocked: new Set<string>(), inFlight: "" });
  const workspaceRefreshInFlight = useRef("");

  // Active modal post for comments / reactions inspection
  const [activeCommentPost, setActiveCommentPost] = useState<FbBrowserPost | null>(null);
  const [activeReactorPost, setActiveReactorPost] = useState<FbBrowserPost | null>(null);

  // Old snapshots contain incorrectly classified activity cards. Cache ownership
  // now stays on the server, scoped to the Facebook session and request options.
  useEffect(() => {
    try {
      sessionStorage.removeItem("mh_fb_last_result");
    } catch {}
  }, []);

  const fbDemoFetch = trpc.fbSession.fbDemoFetch.useMutation();
  const fbFullFetch = trpc.fbSession.fetchFbPages.useMutation();
  const startComments = trpc.fbSession.startMediaComments.useMutation();
  const cancelComments = trpc.fbSession.cancelMediaComments.useMutation();
  const supersedeComments = trpc.fbSession.supersedeMediaComments.useMutation();
  const activeComments = trpc.fbSession.activeMediaComments.useQuery(undefined, {
    enabled: authed && !commentsJob,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
  const exportDestinations = trpc.fbSession.exportDestinations.useQuery(undefined, { enabled: authed });
  const { mutateAsync: saveMediaSheet, isPending: isSavingSheet } = trpc.fbSession.saveMediaSheet.useMutation();
  const commentsProgress = trpc.fbSession.mediaCommentsProgress.useQuery(
    { jobId: commentsJob?.jobId ?? "", includeItems: false, ownerLeaseId: commentsJob?.ownerLeaseId },
    {
      enabled: Boolean(commentsJob && commentsJob.userId === profile?.id),
      // This poll also carries the owner-lease heartbeat, so it cannot stop
      // while the tab is hidden: the server would read a backgrounded tab as a
      // closed page and cancel the run. `includeItems: false` keeps the payload
      // to counts only, and the hidden cadence is slowed instead of paused.
      refetchInterval: (query) => {
        if (query.state.error) return false;
        const active = !query.state.data || query.state.data.status === "running" || query.state.data.sheetSave?.status === "saving";
        if (!active) return false;
        return typeof document !== "undefined" && document.visibilityState === "hidden" ? 5000 : 1500;
      },
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: false,
      retry: 1,
    },
  );
  const commentsDetails = trpc.fbSession.mediaCommentsProgress.useQuery(
    { jobId: commentsJob?.jobId ?? "", includeItems: true, ownerLeaseId: commentsJob?.ownerLeaseId },
    {
      // Fetch the full comment trees just once, after processing is terminal.
      // Polling them while a 1,000-item job runs needlessly transfers and
      // re-renders every accumulated result on each progress tick.
      enabled: Boolean(
        commentsJob && commentsJob.userId === profile?.id && commentsProgress.data
        && commentsProgress.data.status !== "running",
      ),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  );

  // Details are server-owned. On a normal browser refresh, reconnect the new
  // component to the same job instead of showing an idle scraper and letting
  // its owner lease expire. A process restart returns no active job, which is
  // surfaced explicitly rather than looking like a completed fetch.
  useEffect(() => {
    if (!profile || commentsJob || !activeComments.isSuccess) return;
    const stored = readPersistedDetailsJob();
    const active = activeComments.data;
    if (active) {
      const ownerLeaseId = active.ownerLeaseId ?? stored?.ownerLeaseId ?? crypto.randomUUID();
      commentsJobRef.current = active.jobId;
      persistDetailsJob({ jobId: active.jobId, ownerLeaseId, userId: profile.id, startedAt: stored?.startedAt ?? Date.now() });
      setCommentsJob({ jobId: active.jobId, runId: runSequence.current, userId: profile.id, ownerLeaseId });
      setDetailsRecoveryNotice("Details retrieval resumed after the page reloaded.");
    } else if (stored?.userId === profile.id) {
      persistDetailsJob(null);
      setDetailsRecoveryNotice("The prior details job was interrupted because MediaHub restarted. No new fetch was started.");
    }
  }, [activeComments.data, activeComments.isSuccess, commentsJob, profile]);

  const targetMeta = detectFbTarget(targetInput);
  const collectComments = includeComments && authed;
  const collectReactions = includeReactions && authed;
  const detailsLabel = collectComments && collectReactions ? "captions, comments, reactions & shares" : collectComments ? "captions, comments & replies" : collectReactions ? "captions, reactions & shares" : "captions";
  const destinations = exportDestinations.data ?? [];
  const selectedExportBrandId = destinations.some((destination) => destination.brandId === exportBrandChoice)
    ? exportBrandChoice : destinations.length === 1 ? destinations[0].brandId : "";
  const exportBrandId = completed?.exportBrandId ?? selectedExportBrandId;
  const contentTypes = (["posts", "reels"] as const).filter((type) => selectedTypes[type]);
  const contentLabel = contentTypes.map((type) => type === "posts" ? "Photos" : "Reels").join(" & ");
  const requestKey = JSON.stringify([profile?.id ?? "demo", targetInput.trim(), contentTypes, limits.posts, limits.reels, collectComments, commentsLimit, collectReactions]);
  const isPending = fbFullFetch.isPending || fbDemoFetch.isPending;
  const matchingSavedSelection = savedSelection?.brandId === selectedExportBrandId && savedSelection?.userId === profile?.id && savedSelection?.url === targetInput.trim();
  const savedProfile = trpc.fbProfileLibrary.saved.useQuery({brandId:selectedExportBrandId,profileUrl:savedSelection?.url??''},{
    enabled:!!matchingSavedSelection && authed && !!selectedExportBrandId,
    staleTime:0,refetchOnWindowFocus:false,retry:false,
  });
  const jobProgress = commentsJob?.userId === profile?.id
    ? commentsProgress.data
    : undefined;
  useEffect(() => {
    if (!commentsJob || !jobProgress || jobProgress.status === "running" || jobProgress.sheetSave?.status === "saving") return;
    persistDetailsJob(null);
  }, [commentsJob, jobProgress]);
  const detailsProgress = commentsDetails.data;
  const commentsJobMissing = Boolean(commentsJob && commentsJob.userId === profile?.id
    && (commentsProgress.error?.data?.code === "NOT_FOUND" || commentsDetails.error?.data?.code === "NOT_FOUND"));
  const enrichedResults = useMemo(() => {
    const commentsByMedia = new Map(detailsProgress?.items.map((item) => [JSON.stringify([item.postId, item.url, item.contentType]), item]));
    return completed && completed.userId === (profile?.id ?? null) ? completed.results.map((result) => {
    if (!result.page || (!detailsProgress && !commentsJobMissing)) return result;
    return {
      ...result,
      page: {
        ...result.page,
        posts: result.page.posts.map((post) => {
          const item = commentsByMedia.get(JSON.stringify([post.postId, post.url, result.page?.contentType]));
          if (commentsJobMissing && (!item || item.status === "pending" || item.status === "running")) {
            return {
              ...post,
              ...(completed.requestedComments ? { commentsData: item?.comments ?? post.commentsData, commentsStatus: "cancelled" as const, commentsStopReason: "job_unavailable", commentsError: "The retrieval job expired or the server restarted. Run a fresh fetch to continue." } : {}),
              ...(completed.requestedReactions ? { engagement: item?.engagement ?? { status: "partial" as const, totalReactions: null, reactions: {}, shares: null, error: "The retrieval job expired or the server restarted." } } : {}),
            };
          }
          if (!item) return post;
          return {
            ...post,
            ...(completed.requestedComments || detailsProgress?.includeComments ? {
              commentsData: item.comments,
              commentsStatus: detailsProgress?.status === "cancelled" && (item.status === "pending" || item.status === "running") ? "cancelled" as const : item.commentsStatus ?? item.status,
              commentsStopReason: item.stopReason,
              commentsDurationMs: item.durationMs,
              commentsError: item.error,
              commentsObservedCount: item.observedCommentCount,
              commentsTextCount: item.textCommentCount,
              commentsExcludedNonTextCount: item.excludedNonTextCommentCount,
              commentsExcludedAttachmentCount: item.excludedAttachmentCommentCount,
              commentsContentScope: item.commentsContentScope,
              commentsSourceView: item.commentsSourceView,
            } : {}),
            commentsReportedCount: item.reportedCount ?? post.commentsReportedCount,
            engagement: item.engagement ?? post.engagement ?? ((completed.requestedReactions || detailsProgress?.includeReactions) && !["pending", "running"].includes(item.status) ? {
              status: "partial" as const,
              totalReactions: null,
              reactions: {},
              shares: null,
              error: item.error ?? "Reaction and share counts were not returned.",
            } : undefined),
            text: item.metadata?.text ?? post.text,
            publishedTime: item.metadata?.publishedTime ?? post.publishedTime,
            views: item.metadata?.views ?? post.views,
          };
        }),
      },
    };
    }) : [];
  }, [completed, profile?.id, detailsProgress, commentsJobMissing]);
  const showingSaved = !!matchingSavedSelection && completed?.requestKey !== requestKey;
  const results = useMemo<FbResult[]>(() => completed?.requestKey === requestKey ? enrichedResults : showingSaved && !savedProfile.isFetching
    ? (savedProfile.data?.pages ?? []).map((page) => ({ query: page.url, ok: true, page })) : [],
  [completed?.requestKey, requestKey, enrichedResults, showingSaved, savedProfile.isFetching, savedProfile.data?.pages]);
  const savedCommentRetrySummary = useMemo(() => summarizeCommentRetries(results.flatMap((result) => result.page?.posts ?? [])), [results]);
  const savedCommentMetadata = useMemo(() => {
    if (!showingSaved) return null;
    const byType = {
      posts: { items: 0, reported: 0, scraped: 0, retrievableGap: 0, verifiedUnavailable: 0 },
      reels: { items: 0, reported: 0, scraped: 0, retrievableGap: 0, verifiedUnavailable: 0 },
    };
    const buckets = Object.fromEntries(DELTA_BUCKETS.map((bucket) => [bucket.key, { posts: 0, reels: 0, total: 0 }])) as Record<DeltaBucketKey, { posts: number; reels: number; total: number }>;
    for (const result of results) {
      if (!result.page) continue;
      const type = result.page.contentType;
      if (type !== "posts" && type !== "reels") continue;
      for (const post of result.page.posts) {
        byType[type].items += 1;
        const deltaBasis = reportedDeltaBasis(post);
        if (deltaBasis != null) byType[type].reported += deltaBasis;
        byType[type].scraped += flattenFbComments(post.commentsData ?? []).length;
        const delta = commentDelta(post);
        if (delta == null) continue;
        byType[type].retrievableGap += delta;
        if (post.commentsVerifiedAccessibleCount != null && (rawCommentDelta(post) ?? 0) > 0) byType[type].verifiedUnavailable += 1;
        const bucket = buckets[deltaBucket(delta)];
        bucket[type] += 1;
        bucket.total += 1;
      }
    }
    return { byType, buckets };
  }, [results, showingSaved]);
  const currentWorkspaceSync = workspaceSync?.profileUrl === (savedSelection?.url ?? targetInput.trim())
    ? workspaceSync
    : null;
  const retryableMediaCount = savedCommentRetrySummary.retry;
  const savedCommentReviewCount = savedCommentRetrySummary.cancelled + savedCommentRetrySummary.filtered + savedCommentRetrySummary.review;
  const savedReactionReviewCount = useMemo(() => results.flatMap((result) => result.page?.posts ?? []).filter((post) => post.engagement?.status === "partial").length, [results]);
  const errorMessage = failure?.requestKey === requestKey ? failure.message : null;
  const restoreSavedPreviews = useCallback((contentType: "posts" | "reels", posts: FbBrowserPost[]) => {
    if (!showingSaved || !authed || isRestoringPreviews) return;
    const items = posts.flatMap((post) => {
      if (!post.postId || !post.url || post.images?.[0]) return [];
      const key = savedPreviewKey(contentType, post.postId);
      if (savedPreviewImages[key] || requestedPreviewKeys.current.has(key)) return [];
      requestedPreviewKeys.current.add(key);
      return [{ postId: post.postId, url: post.url, contentType }];
    }).slice(0, 48);
    if (!items.length) return;
    setIsRestoringPreviews(true);
    void profileUtils.fbSession.recoverMediaPreviews.fetch({ items }).then((previews) => {
      setSavedPreviewImages((current) => ({ ...current, ...Object.fromEntries(previews.flatMap((preview) => preview.image ? [[savedPreviewKey(preview.contentType, preview.postId), preview.image]] : [])) }));
    }).catch(() => {
      // The card keeps its direct Facebook link and a clear unavailable state.
    }).finally(() => setIsRestoringPreviews(false));
  }, [authed, isRestoringPreviews, profileUtils.fbSession.recoverMediaPreviews, savedPreviewImages, showingSaved]);
  const commentsError = commentsFailure?.runId === completed?.runId ? commentsFailure?.message : null;
  const finishedCommentsItems = jobProgress?.completed ?? 0;
  const collectedComments = jobProgress?.commentCount ?? 0;
  // Reported separately: "partial" previously mixed incomplete comments with a
  // withheld reaction breakdown or an unreadable date, so items whose comments
  // had finished perfectly still counted against the run.
  const partialCommentsItems = jobProgress?.partialComments ?? 0;
  const partialDetailItems = jobProgress?.partialDetails ?? 0;
  // A saved-data retry always asks for the full detail bundle.  The request
  // controls above describe the *next* fetch, so they must not be used to
  // describe a job that is already running.
  const runningDetailsLabel = jobProgress
    ? jobProgress.includeComments && jobProgress.includeReactions
      ? "captions, comments, reactions & shares"
      : jobProgress.includeComments
        ? "captions, comments & replies"
        : jobProgress.includeReactions
          ? "captions, reactions & shares"
          : "captions"
    : detailsLabel;
  // Completed items advance only after an entire Facebook detail page is done.
  // A concurrent run can therefore finish rows one-by-one even while many
  // Facebook pages are still being scraped at the same time.
  const inFlightDetailPages = jobProgress?.status === "running"
    ? jobProgress.active
    : 0;
  const workerSlots = jobProgress?.workers?.slots ?? [];
  const shownCommentPost = activeCommentPost
    ? results.flatMap((result) => result.page?.posts ?? []).find((post) => post.postId === activeCommentPost.postId && post.url === activeCommentPost.url) ?? activeCommentPost
    : null;
  const sheetKey = completed && exportBrandId ? `${completed.exportRunId}:${exportBrandId}` : "";
  const localSheetSave = sheetSave?.key === sheetKey ? sheetSave : null;
  const serverSheetSave = completed?.serverManagedExport && serverExportRetryKey !== sheetKey ? jobProgress?.sheetSave : undefined;
  const currentSheetSave = serverSheetSave ? {
    key: sheetKey,
    stage: "details" as const,
    phase: serverSheetSave.status === "failed" ? "error" as const : serverSheetSave.status,
    url: serverSheetSave.result?.url ?? localSheetSave?.url,
    folderUrl: serverSheetSave.result?.folderUrl ?? localSheetSave?.folderUrl,
    error: serverSheetSave.error,
  } : localSheetSave;
  const hasDetailWork = Boolean(completed?.requestedMetadata || completed?.requestedComments || completed?.requestedReactions);
  const saveStage = hasDetailWork && (jobProgress?.status === "completed" || jobProgress?.status === "cancelled" || commentsError || commentsJobMissing) ? "details" : "media";

  // Only the first media snapshot and the terminal enrichment snapshot write.
  // Polling updates are rendered locally and never generate another Drive file.
  // Editing the next request must not discard this run's terminal details.
  useEffect(() => {
    if (!authed || !completed || completed.runId !== runSequence.current || completed.userId !== profile?.id || !exportBrandId) return;
    if (saveStage === "details" && completed.serverManagedExport && !commentsError && !commentsJobMissing && serverExportRetryKey !== sheetKey) return;
    const pages = enrichedResults.flatMap((result) => result.ok && result.page ? [result.page] : []);
    if (!pages.length) return;
    const attemptKey = `${completed.exportRunId}:${exportBrandId}:${saveStage}`;
    const writes = sheetWrites.current;
    if (writes.inFlight || writes.completed.has(attemptKey) || writes.blocked.has(attemptKey)) return;
    writes.inFlight = attemptKey;
    if (!completed.exportBrandId) {
      setCompleted((current) => current?.runId === completed.runId ? { ...current, exportBrandId } : current);
    }
    const key = `${completed.exportRunId}:${exportBrandId}`;
    const runId = completed.runId;
    const stage = saveStage;
    // This state describes the external write being started, not derived render data.
    setSheetSave((previous) => ({ ...(previous?.key === key ? previous : {}), key, stage, phase: "saving" }));
    void saveMediaSheet({ brandId: exportBrandId, runId: completed.exportRunId, pages }).then((saved) => {
      writes.completed.add(attemptKey);
      // A terminal snapshot subsumes the initial one if enrichment finished fast.
      if (stage === "details") writes.completed.add(`${completed.exportRunId}:${exportBrandId}:media`);
      if (runSequence.current === runId) {
        setSheetSave({ key, stage, phase: "saved", url: saved.url, folderUrl: saved.folderUrl });
      }
      void profileUtils.fbProfileLibrary.list.invalidate({ brandId: exportBrandId });
    }).catch((error: unknown) => {
      writes.blocked.add(attemptKey);
      if (runSequence.current === runId) {
        setSheetSave((previous) => ({ ...(previous?.key === key ? previous : {}), key, stage, phase: "error", error: error instanceof Error ? error.message : "Google Sheets could not be updated." }));
      }
    }).finally(() => {
      if (writes.inFlight === attemptKey) writes.inFlight = "";
      setSaveVersion((version) => version + 1);
    });
  }, [authed, completed, profile?.id, exportBrandId, enrichedResults, saveStage, saveMediaSheet, saveVersion, commentsError, commentsJobMissing, serverExportRetryKey, sheetKey, profileUtils.fbProfileLibrary.list]);

  const retrySheetSave = () => {
    if (!sheetKey) return;
    if (serverSheetSave?.status === "failed") setServerExportRetryKey(sheetKey);
    sheetWrites.current.blocked.delete(`${sheetKey}:media`);
    sheetWrites.current.blocked.delete(`${sheetKey}:details`);
    setSaveVersion((version) => version + 1);
  };

  const handleFetch = async (bypassCache = false) => {
    if (isPending) return;
    if (!targetInput.trim()) {
      toast.error("Please enter a Facebook Page name, Profile URL, or ID");
      return;
    }
    if (!contentTypes.length) {
      toast.error("Select Photos, Reels, or both.");
      return;
    }
    const maximum = authed ? 1000 : 50;
    for (const type of contentTypes) {
      const limit = Number(limits[type]);
      if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
        toast.error(`Enter a whole number from 1 to ${maximum} for ${type === "posts" ? "photos" : "reels"}.`);
        return;
      }
    }
    const commentLimit = Number(commentsLimit);
    if (collectComments && (!Number.isInteger(commentLimit) || commentLimit < 0 || commentLimit > 5000)) {
      toast.error("Enter a comments limit from 0 to 5000. Use 0 for all available.");
      return;
    }
    const runId = ++runSequence.current;
    setSavedSelection(null);
    setSavedPreviewImages({});
    requestedPreviewKeys.current.clear();
    const exportRunId = crypto.randomUUID();
    const runExportBrandId = selectedExportBrandId || undefined;
    commentsJobRef.current = null;
    setCommentsJob(null);
    setCommentsFailure(null);
    setDetailsRecoveryNotice(null);
    persistDetailsJob(null);
    setFailure(null);
    setCompleted(null);
    setActiveCommentPost(null);
    setActiveReactorPost(null);
    const options = {
      pages: [targetInput.trim()],
      contentTypes,
      photoLimit: selectedTypes.posts ? Number(limits.posts) : undefined,
      reelLimit: selectedTypes.reels ? Number(limits.reels) : undefined,
      includeComments: false,
      includeReactors: false,
      bypassCache,
    };
    try {
      // This server transition is also repeated when details begin, so another
      // tab cannot race a new fetch against an earlier details job.
      if (profile) {
        const cleanup = await supersedeComments.mutateAsync();
        if (cleanup.replacedJobIds.length) {
          toast.info("Previous details retrieval was stopped; its collected results are being saved before this fetch continues.");
        }
      }
      const data = authed
        ? await fbFullFetch.mutateAsync(options)
        : await fbDemoFetch.mutateAsync(options);
      const fetchedResults: FbResult[] = data.results;
      const fetchedProfile=fetchedResults.find(r=>r.ok&&r.page)?.page;
      if(profile && runExportBrandId && fetchedProfile) {
        addProfile.mutate({brandId:runExportBrandId,name:fetchedProfile.name||fetchedProfile.handle,profileUrl:fetchedProfile.url},{onError:()=>toast.error("Results loaded, but the profile could not be added. Use Add to retry.")});
      }
      if (!fetchedResults.length) throw new Error("Facebook returned no result. Please try again.");
      if (runId !== runSequence.current) return;
      const readyResults = fetchedResults.map((result) => !result.page || !collectComments ? result : {
        ...result,
        page: { ...result.page, posts: result.page.posts.map((post) => ({
          ...post,
          commentsStatus: post.postId && post.url ? "pending" as const : "failed" as const,
          commentsError: post.postId && post.url ? undefined : "This item has no usable media link for comments.",
        })) },
      });
      const sheetExport = profile && runExportBrandId ? {
        brandId: runExportBrandId,
        runId: exportRunId,
        pages: readyResults.flatMap((result) => result.ok && result.page ? [result.page] : []),
      } : undefined;
      setCompleted({
        runId,
        userId: profile?.id ?? null,
        exportRunId,
        exportBrandId: runExportBrandId,
        serverManagedExport: Boolean(sheetExport),
        requestKey,
        requestedComments: collectComments,
        requestedReactions: collectReactions,
        requestedMetadata: authed,
        results: readyResults,
      });
      if (profile) {
        const items = fetchedResults.flatMap((result) => result.page?.posts.flatMap((post) => post.postId && post.url ? [{
          postId: post.postId,
          url: post.url,
          contentType: result.page!.contentType ?? (post.mediaType === "reel" ? "reels" as const : "posts" as const),
        }] : []) ?? []);
        if (items.length) {
          try {
            const ownerLeaseId = crypto.randomUUID();
            const job = await startComments.mutateAsync({ items, limit: collectComments ? commentLimit : 0, withReplies: true, includeComments: collectComments, includeReactions: collectReactions, includeMetadata: true, ownerLeaseId, sheetExport });
            if (job.replacedJobIds.length) {
              toast.info("A concurrent details retrieval was replaced before the new one started.");
            }
            if (runId !== runSequence.current) {
              void cancelComments.mutateAsync({ jobId: job.jobId }).catch(() => toast.error("An earlier details request could not be cancelled."));
              return;
            }
            commentsJobRef.current = job.jobId;
            setCommentsJob({ jobId: job.jobId, runId, userId: profile.id, ownerLeaseId });
            persistDetailsJob({ jobId: job.jobId, ownerLeaseId, userId: profile.id, startedAt: Date.now() });
          } catch (error) {
            if (runId !== runSequence.current) return;
            const message = error instanceof Error ? error.message : "Details could not be retrieved.";
            setCommentsFailure({ runId, message });
            setCompleted((current) => current?.runId === runId ? {
              ...current,
              serverManagedExport: false,
              results: current.results.map((result) => !result.page ? result : {
                ...result,
                page: { ...result.page, posts: result.page.posts.map((post) => ({
                  ...post,
                  ...(collectComments ? { commentsStatus: "failed" as const, commentsError: message } : {}),
                  ...(collectReactions ? { engagement: { status: "partial" as const, totalReactions: null, reactions: {}, shares: null, error: message } } : {}),
                })) },
              }),
            } : current);
          }
        } else {
          setCommentsFailure({ runId, message: "No usable media links were returned for details." });
        }
      }
    } catch (error) {
      if (runId !== runSequence.current) return;
      const message = error instanceof Error ? error.message : "The request could not be completed.";
      setFailure({
        requestKey,
        message: /failed to fetch|network|unexpected token/i.test(message)
          ? "The connection to MediaHub was interrupted. Please try again."
          : message,
      });
    }
  };

  const handleMlaUpdate = async (urls: string[]) => {
    if (!profile || !selectedExportBrandId || !urls.length || isPending || isUpdatingMlas) return;
    const types = contentTypes;
    if (!types.length) { toast.error("Select Photos, Reels, or both first."); return; }
    setIsUpdatingMlas(true);
    try {
      for (const url of urls) {
        const ownerLeaseId = crypto.randomUUID();
        const updated = await updateProfile.mutateAsync({ brandId: selectedExportBrandId, profileUrl: url, contentTypes: types, ownerLeaseId });
        if (urls.length === 1) {
          setTargetInput(url); setSavedSelection({ url, brandId: selectedExportBrandId, userId: profile.id });
          setCompleted(null); setFailure(null);
        }
        if (!updated.jobId) { toast.success("Already up to date."); continue; }
        toast.success(`${updated.added.posts} posts and ${updated.added.reels} reels found. Retrieving their comments and details now.`);
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const progress = await profileUtils.fbSession.mediaCommentsProgress.fetch({ jobId: updated.jobId, includeItems: false, ownerLeaseId });
          if (progress.status === "running" || progress.sheetSave?.status === "saving") continue;
          if (progress.sheetSave?.status === "failed") throw new Error(progress.sheetSave.error ?? "Updated details could not be saved.");
          toast.success(`Update complete: ${progress.completed - progress.failed} media items saved.`);
          break;
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setIsUpdatingMlas(false);
      await Promise.all([profileUtils.fbProfileLibrary.list.invalidate({ brandId: selectedExportBrandId }), profileUtils.fbProfileLibrary.saved.invalidate()]);
    }
  };

  const handleCancelComments = async () => {
    if (!commentsJob) return;
    try {
      await cancelComments.mutateAsync({ jobId: commentsJob.jobId });
      await commentsProgress.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Details retrieval could not be cancelled.");
    }
  };

  const handleRetryPartial = async () => {
    if (!profile || !selectedExportBrandId || !targetInput.trim() || retryPartial.isPending || jobProgress?.status === "running") return;
    try {
      const ownerLeaseId = crypto.randomUUID();
      const started = await retryPartial.mutateAsync({ brandId: selectedExportBrandId, profileUrl: targetInput.trim(), ownerLeaseId });
      if (!started.jobId) { toast.success("No saved media has a concrete retryable details failure."); return; }
      commentsJobRef.current = started.jobId;
      setCommentsJob({ jobId: started.jobId, runId: completed?.runId ?? runSequence.current, userId: profile.id, ownerLeaseId });
      setCommentsFailure(null);
      toast.success(`Retrying ${started.total} stage-classified details failure${started.total === 1 ? "" : "s"}. Complete results stay saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Partial details could not be retried.");
    }
  };

  const handleRetryDelta = async (bucketKey: DeltaBucketKey) => {
    if (!profile || !selectedExportBrandId || !savedProfile.data?.pages.length) return;
    const bucket = DELTA_BUCKETS.find((entry) => entry.key === bucketKey)!;
    try {
      const ownerLeaseId = crypto.randomUUID();
      const job = await retryDelta.mutateAsync({brandId:selectedExportBrandId,profileUrl:savedSelection?.url ?? targetInput,min:bucket.min,max:Number.isFinite(bucket.max)?bucket.max:Number.MAX_SAFE_INTEGER,ownerLeaseId});
      if (!job.jobId) { toast.info("No saved media belongs to this comment gap range."); return; }
      commentsJobRef.current = job.jobId;
      setCommentsJob({ jobId: job.jobId, runId: runSequence.current, userId: profile.id, ownerLeaseId: job.ownerLeaseId ?? ownerLeaseId });
      setCommentsFailure(null);
      toast.success(job.appendedItems === 0 ? "Those media items are already in the active retry queue." : `Added ${job.appendedItems} media item${job.appendedItems === 1 ? "" : "s"} to the active retry queue.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The selected comments could not be retried.");
    }
  };

  const handleRetrySingleComments = async (post: FbBrowserPost) => {
    if (!profile || !selectedExportBrandId || !post.postId || !post.url) return;
    try {
      const ownerLeaseId = crypto.randomUUID();
      const job = await retryDelta.mutateAsync({
        brandId: selectedExportBrandId,
        profileUrl: savedSelection?.url ?? targetInput,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        postIds: [post.postId],
        ownerLeaseId,
      });
      if (!job.jobId) { toast.info("This saved media item is not available for a comment retry."); return; }
      commentsJobRef.current = job.jobId;
      setCommentsJob({ jobId: job.jobId, runId: runSequence.current, userId: profile.id, ownerLeaseId: job.ownerLeaseId ?? ownerLeaseId });
      setCommentsFailure(null);
      toast.success(job.appendedItems === 0 ? "This media item is already in the active retry queue." : "Added this media item to the active retry queue.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The selected comments could not be retried.");
    }
  };

  const handleWorkspaceSync = async () => {
    if (!selectedExportBrandId || syncWorkspace.isPending || jobProgress?.status === "running") return;
    const profileUrl = savedSelection?.url ?? targetInput.trim();
    if (!profileUrl) return;
    setWorkspaceSync({ profileUrl, phase: "saving" });
    try {
      const saved = await syncWorkspace.mutateAsync({ brandId: selectedExportBrandId, profileUrl });
      setWorkspaceSync({ profileUrl, phase: "saved", url: saved.url });
      toast.success("Candidate workspace synced to Google Sheets.");
      void profileUtils.fbProfileLibrary.saved.invalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Sheet sync failed.";
      setWorkspaceSync({ profileUrl, phase: "error", error: message });
      toast.error(message);
    }
  };

  const reloadedRetryJob = useRef("");
  useEffect(() => {
    const profileUrl = savedSelection?.url;
    if (!commentsJob || !showingSaved || !profileUrl || !jobProgress
      || jobProgress.status === "running" || jobProgress.sheetSave?.status === "saving"
      || reloadedRetryJob.current === commentsJob.jobId
      || workspaceRefreshInFlight.current === commentsJob.jobId) return;

    // A retry commits its merged result to the local candidate workspace before
    // publishing the terminal status. Await that fresh query before recording
    // the job as reloaded, otherwise a short query miss can leave the delta
    // metadata on its pre-retry snapshot indefinitely.
    workspaceRefreshInFlight.current = commentsJob.jobId;
    void (async () => {
      try {
        await profileUtils.fbProfileLibrary.saved.invalidate({
          brandId: selectedExportBrandId,
          profileUrl,
        });
        const refreshed = await savedProfile.refetch();
        if (refreshed.error) throw refreshed.error;
        reloadedRetryJob.current = commentsJob.jobId;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Retry results were saved, but the dashboard could not refresh. Reload this candidate to view the latest totals.");
      } finally {
        if (workspaceRefreshInFlight.current === commentsJob.jobId) workspaceRefreshInFlight.current = "";
      }
    })();
  }, [commentsJob, showingSaved, jobProgress, profileUtils, savedProfile, savedSelection?.url, selectedExportBrandId]);

  return (
    <div className={embedded ? "w-full text-zinc-700" : "relative min-h-screen overflow-x-hidden bg-[#f7f8fc] text-zinc-700"}>
      {!embedded && (
        <>
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
              <span className="font-display text-xl uppercase">Facebook <span className="text-indigo-600">Scraper</span></span>
              <div className="flex items-center gap-2 sm:gap-3">
                <Link
                  href="/library"
                  className="inline-flex rounded-full px-3 py-2 text-sm text-zinc-600 transition-colors hover:text-zinc-900"
                >
                  ← Back
                </Link>
                <Link href="/api/studio-enter" className={cn(PRIMARY_BTN, "px-4 py-2 text-sm")}>
                  Enter Studio
                </Link>
              </div>
            </div>
          </header>
        </>
      )}

      <main className={embedded ? "grid w-full gap-6" : "mx-auto grid max-w-[1600px] gap-6 px-4 pb-24 pt-10 sm:px-6 sm:pt-14 "}>
        <div className="grid auto-rows-[420px] items-stretch gap-5 lg:grid-cols-2">
        <FacebookProfileLibrary brandId={selectedExportBrandId} authed={authed} selectedUrl={targetInput.trim()}
          disabled={isPending || isUpdatingMlas || updateProfile.isPending || startComments.isPending || isSavingSheet || jobProgress?.status==='running' || jobProgress?.sheetSave?.status==='saving'} onUpdate={handleMlaUpdate}
          onSelect={url=>{
            if(!profile) return;
            if(savedSelection?.url===url && savedSelection.brandId===selectedExportBrandId) void savedProfile.refetch();
            ++runSequence.current;
            setTargetInput(url);setSelectedTypes({posts:true,reels:true});
            setSavedSelection({url,brandId:selectedExportBrandId,userId:profile.id});
            setCompleted(null);setCommentsJob(null);commentsJobRef.current=null;setSavedPreviewImages({});requestedPreviewKeys.current.clear();
            setFailure(null);setCommentsFailure(null);setSheetSave(null);
            setActiveCommentPost(null);setActiveReactorPost(null);
          }} />
        <FacebookCustomProfiles brandId={selectedExportBrandId} authed={authed} selectedUrl={targetInput.trim()}
          disabled={isPending || startComments.isPending || isSavingSheet || jobProgress?.status==='running' || jobProgress?.sheetSave?.status==='saving'}
          onSelect={url=>{
            if(!profile) return;
            if(savedSelection?.url===url && savedSelection.brandId===selectedExportBrandId) void savedProfile.refetch();
            ++runSequence.current;
            setTargetInput(url);setSelectedTypes({posts:true,reels:true});
            setSavedSelection({url,brandId:selectedExportBrandId,userId:profile.id});
            setCompleted(null);setCommentsJob(null);commentsJobRef.current=null;setSavedPreviewImages({});requestedPreviewKeys.current.clear();
            setFailure(null);setCommentsFailure(null);setSheetSave(null);
            setActiveCommentPost(null);setActiveReactorPost(null);
          }} />
        </div>
        <div className="min-w-0">
        {/* ── Page Hero Header ── */}
        <Reveal>
          <h1 className="font-display text-4xl tracking-tight text-zinc-900 sm:text-5xl">
            Facebook <span className="text-indigo-600">Scraper</span>
          </h1>
        </Reveal>

        {/* ── Single Input & Scraping Options Panel ── */}
        <Reveal delay={0.06}>
          <div className={cn(SURFACE.card, "mt-8 border border-zinc-200/80 bg-white p-5 shadow-sm sm:p-7")}>
            {/* Single Input Box */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="fbInput" className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-600">
                  Facebook page or profile
                </label>
                {targetMeta.label && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 font-mono text-xs font-medium text-indigo-700 border border-indigo-200">
                    Detected {targetMeta.label}
                  </span>
                )}
              </div>

              <div className="relative mt-2">
                <input
                  id="fbInput"
                  type="text"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  disabled={isPending}
                  placeholder="https://www.facebook.com/arunkumarmlabjp/, profile.php?id=1000..., or page name"
                  className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3.5 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>

            <fieldset className="mt-6 border-t border-zinc-100 pt-5" disabled={isPending}>
              <legend className="sr-only">Content to scrape</legend>
              <div className="grid grid-cols-3 gap-3">
                {(["posts", "reels"] as const).map((type) => (
                  <label key={type} className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-4 transition-colors",
                    selectedTypes[type] ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-zinc-200 bg-white text-zinc-700",
                    isPending && "cursor-wait opacity-60",
                  )}>
                    <input
                      type="checkbox"
                      name={`facebook-${type}`}
                      value={type}
                      checked={selectedTypes[type]}
                      onChange={(e) => setSelectedTypes((previous) => ({ ...previous, [type]: e.target.checked }))}
                      className="h-4 w-4 accent-indigo-600"
                    />
                    {type === "posts" ? <ImageIcon className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                    <span className="text-sm font-semibold">{type === "posts" ? "Posts (Photos)" : "Reels"}</span>
                  </label>
                ))}
                <label className="flex min-w-0 items-center gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-sm font-medium">
                  Number per type
                  <input aria-label="Number per type" type="number" min={1} max={authed?1000:50} value={limits.posts} onChange={e=>setLimits({posts:e.target.value,reels:e.target.value})} className="w-20 min-w-0 rounded-lg border px-2 py-2"/>
                </label>
              </div>
              <div className="mt-5 border-t border-zinc-100 pt-4">
                <label className={cn("inline-flex items-center gap-3 text-sm font-semibold", authed ? "cursor-pointer text-zinc-700" : "text-zinc-400")}>
                  <input
                    type="checkbox"
                    checked={collectComments}
                    onChange={(e) => setIncludeComments(e.target.checked)}
                    disabled={!authed}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  Comments &amp; replies
                </label>
                <label className={cn("ml-5 inline-flex items-center gap-3 text-sm font-semibold", authed ? "cursor-pointer text-zinc-700" : "text-zinc-400")}>
                  <input
                    type="checkbox"
                    checked={collectReactions}
                    onChange={(e) => setIncludeReactions(e.target.checked)}
                    disabled={!authed}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  Reactions &amp; shares
                </label>
                {!authed && <Link href="/api/studio-enter" className="ml-3 text-xs font-medium text-indigo-600 hover:underline">Enter Studio to enable</Link>}
                {collectComments && (
                  <div className="mt-3 max-w-xs">
                    <label htmlFor="facebook-comments-limit" className="text-sm font-medium text-zinc-700">Comments + replies per item</label>
                    <input
                      id="facebook-comments-limit"
                      type="number"
                      min={0}
                      max={5000}
                      step={1}
                      inputMode="numeric"
                      value={commentsLimit}
                      onChange={(e) => setCommentsLimit(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />
                    <p className="mt-1 text-xs text-zinc-500">0 = all available</p>
                  </div>
                )}
              </div>
            </fieldset>

            {authed && (
              <div className="mt-5 border-t border-zinc-100 pt-4 text-sm text-zinc-600">
                {exportDestinations.isPending ? "Loading Google Drive connections…" : exportDestinations.isError ? (
                  <p role="alert">Google Drive connections could not be loaded. <button type="button" onClick={() => exportDestinations.refetch()} className="font-medium text-indigo-600 underline">Retry</button></p>
                ) : destinations.length === 0 ? (
                  <p><Link href="/settings" className="font-medium text-indigo-600 underline">Connect Google Drive in Settings</Link> to save results to Google Sheets.</p>
                ) : destinations.length === 1 ? (
                  <p>{completed?.exportBrandId ? "Next fetch saves to" : "Save to Google Drive"} · <span className="font-semibold text-zinc-800">{destinations[0].brandName}</span></p>
                ) : (
                  <div className="max-w-sm">
                    <label htmlFor="facebook-export-brand" className="font-medium text-zinc-700">{completed?.exportBrandId ? "Google Drive destination for next fetch" : "Save to Google Drive"}</label>
                    <select id="facebook-export-brand" value={selectedExportBrandId} disabled={isSavingSheet} onChange={(e) => setExportBrandChoice(e.target.value)} className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-zinc-900 disabled:opacity-60">
                      <option value="">Choose a connected brand</option>
                      {destinations.map((destination) => <option key={destination.brandId} value={destination.brandId}>{destination.brandName}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* ── Submit Action Button ── */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleFetch()}
                disabled={isPending || !contentTypes.length}
                className={cn(PRIMARY_BTN, "px-7 py-3 text-base")}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" /> Loading {contentLabel.toLowerCase()}…
                  </>
                ) : (
                  <>
                    <Download className="h-5 w-5" /> Fetch {contentLabel || "Content"}
                  </>
                )}
              </button>
            </div>
          </div>
        </Reveal>

        {/* ── Loading Skeleton ── */}
        {isPending && (
          <div className="mt-8 space-y-4">
            <div className="flex items-center gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Loading {contentLabel.toLowerCase()}…
            </div>
            <FbSkeleton />
          </div>
        )}

        {!isPending && errorMessage && (
          <div role="alert" className="mt-8 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p className="flex-1">{errorMessage}</p>
            <button type="button" onClick={() => handleFetch(true)} className={cn(SECONDARY_BTN, "px-4 py-2 text-sm")}>
              Try again
            </button>
          </div>
        )}

        {showingSaved && <div className="mt-6 rounded-xl border border-indigo-100 bg-white p-4 text-sm" role={savedProfile.error?'alert':'status'}>
          {savedProfile.isFetching ? 'Loading saved Photos and Reels from Google Drive…' : savedProfile.error ? <><p>{savedProfile.error.message}</p><button type="button" onClick={()=>savedProfile.refetch()} className="mt-2 text-indigo-600 underline">Retry saved data</button></> : savedProfile.data?.pages.length ? <>
            <p className="font-medium text-indigo-700">Saved Photos and Reels loaded from Google Drive.</p>
            <p className="mt-1 text-xs text-zinc-500">This is saved data, not a new scrape. Visible missing thumbnails are restored in small batches from their exact saved media IDs; a failed restore keeps the direct Facebook link without starting a full fetch.</p>
            {isRestoringPreviews && <p className="mt-1 text-xs text-indigo-600">Restoring visible saved previews…</p>}
            {savedProfile.data.source?.url&&<a href={savedProfile.data.source.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-indigo-600 underline">Open saved Google Sheet</a>}
          </> : 'No saved data for this profile. Choose Photos, Reels, or both and use Fetch to start.'}
        </div>}

        {/* ── Scraped Results ── */}
        {!isPending && results.length > 0 && (
          <div className="mt-8 space-y-8">
            {showingSaved && savedCommentMetadata && (
              <section className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm" aria-label="Saved comment metadata">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-xl text-zinc-900">Saved comment metadata</h2>
                    <p className="mt-1 text-sm text-zinc-600">Shows Facebook’s raw reported gap separately from the gap still retrievable by this session.</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">Local candidate workspace</span>
                    <button
                      type="button"
                      className={cn(SECONDARY_BTN, "px-3.5 py-2 text-xs")}
                      disabled={syncWorkspace.isPending || jobProgress?.status === "running"}
                      aria-busy={currentWorkspaceSync?.phase === "saving"}
                      onClick={handleWorkspaceSync}
                    >
                      {currentWorkspaceSync?.phase === "saving" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing to Google Sheet…</> : currentWorkspaceSync?.phase === "saved" ? <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Sync again</> : "Sync to Google Sheet"}
                    </button>
                  </div>
                </div>
                <div className="mt-3" aria-live="polite">
                  {currentWorkspaceSync?.phase === "saving" && <p role="status" className="inline-flex items-center gap-2 text-xs text-indigo-700"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving the complete local candidate workspace to Google Sheets…</p>}
                  {currentWorkspaceSync?.phase === "saved" && <p role="status" className="inline-flex flex-wrap items-center gap-2 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Google Sheet is up to date. {currentWorkspaceSync.url && <a href={currentWorkspaceSync.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline">Open synced Google Sheet</a>}</p>}
                  {currentWorkspaceSync?.phase === "error" && <p role="alert" className="text-xs text-red-700">Google Sheet sync failed: {currentWorkspaceSync.error}</p>}
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(["posts", "reels"] as const).map((type) => {
                    const stats = savedCommentMetadata.byType[type];
                    return <div key={type} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                      <p className="font-semibold text-zinc-900">{type === "posts" ? "Posts / Photos" : "Reels"}</p>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-indigo-700">{fmt(stats.items)}</p>
                      <p className="text-xs text-zinc-500">saved items</p>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <span className="text-zinc-500">Reported <strong className="block text-sm text-zinc-900">{fmt(stats.reported)}</strong></span>
                        <span className="text-zinc-500">Scraped <strong className="block text-sm text-zinc-900">{fmt(stats.scraped)}</strong></span>
                        <span className="text-zinc-500">Retrievable gap <strong className="block text-sm text-zinc-900">{fmt(stats.retrievableGap)}</strong></span>
                      </div>
                    </div>;
                  })}
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                    <p className="font-semibold text-indigo-950">All saved media</p>
                    <p className="mt-2 text-2xl font-bold tabular-nums text-indigo-700">{fmt(savedCommentMetadata.byType.posts.items + savedCommentMetadata.byType.reels.items)}</p>
                    <p className="text-xs text-indigo-700">posts and reels</p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <span className="text-indigo-700">Reported <strong className="block text-sm text-indigo-950">{fmt(savedCommentMetadata.byType.posts.reported + savedCommentMetadata.byType.reels.reported)}</strong></span>
                      <span className="text-indigo-700">Scraped <strong className="block text-sm text-indigo-950">{fmt(savedCommentMetadata.byType.posts.scraped + savedCommentMetadata.byType.reels.scraped)}</strong></span>
                      <span className="text-indigo-700">Retrievable gap <strong className="block text-sm text-indigo-950">{fmt(savedCommentMetadata.byType.posts.retrievableGap + savedCommentMetadata.byType.reels.retrievableGap)}</strong></span>
                    </div>
                  </div>
                </div>
                {(savedCommentMetadata.byType.posts.verifiedUnavailable + savedCommentMetadata.byType.reels.verifiedUnavailable) > 0 && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {savedCommentMetadata.byType.posts.verifiedUnavailable + savedCommentMetadata.byType.reels.verifiedUnavailable} media item{savedCommentMetadata.byType.posts.verifiedUnavailable + savedCommentMetadata.byType.reels.verifiedUnavailable === 1 ? " has" : "s have"} a repeatedly verified Facebook-unavailable remainder. Their raw Facebook-reported gaps remain visible and can be rechecked later.
                  </p>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                  <label htmlFor="saved-delta-filter" className="text-xs font-semibold text-zinc-800">Filter saved Photos and Reels by reported-delta gap</label>
                  <select
                    id="saved-delta-filter"
                    value={savedDeltaFilter}
                    onChange={(event) => setSavedDeltaFilter(event.target.value as SavedDeltaFilter)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800"
                  >
                    <option value="all">All items</option>
                    <option value="complete">Zero gap</option>
                    <option value="missing">No reported count</option>
                    {DELTA_BUCKETS.map((bucket) => <option key={bucket.key} value={bucket.key}>{bucket.label} gap</option>)}
                  </select>
                </div>
                <div className="mt-5 overflow-x-auto rounded-xl border border-zinc-200">
                  <table className="w-full min-w-[620px] text-left text-sm">
                    <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500"><tr><th className="p-3">Reported-delta gap</th><th className="p-3 text-right">Posts / Photos</th><th className="p-3 text-right">Reels</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Action</th></tr></thead>
                    <tbody>{DELTA_BUCKETS.map((bucket) => {
                      const counts = savedCommentMetadata.buckets[bucket.key];
                      return <tr key={bucket.key} className="border-t border-zinc-100"><td className="p-3 font-medium text-zinc-900">{bucket.label}</td><td className="p-3 text-right tabular-nums">{counts.posts}</td><td className="p-3 text-right tabular-nums">{counts.reels}</td><td className="p-3 text-right font-semibold tabular-nums">{counts.total}</td><td className="p-2 text-right"><button type="button" disabled={!counts.total || retryDelta.isPending} onClick={() => handleRetryDelta(bucket.key)} className={cn(SECONDARY_BTN, "px-3 py-1.5 text-xs disabled:opacity-40")}>{retryDelta.isPending ? "Adding…" : `Retry ${counts.total}`}</button></td></tr>;
                    })}</tbody>
                  </table>
                </div>
              </section>
            )}
            {authed && (retryableMediaCount > 0 || savedCommentReviewCount > 0 || savedReactionReviewCount > 0) && (showingSaved || currentSheetSave?.phase === "saved") && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <div>
                  {retryableMediaCount > 0 ? <p className="font-semibold">{retryableMediaCount} media item{retryableMediaCount === 1 ? "" : "s"} has a retryable details-stage failure.</p> : <p className="font-semibold">No saved comment failure is safe to retry automatically.</p>}
                  <p className="mt-1 text-xs text-amber-800">
                    {savedCommentRetrySummary.cancelled > 0 && `${savedCommentRetrySummary.cancelled} stopped by request; `}
                    {savedCommentRetrySummary.filtered > 0 && `${savedCommentRetrySummary.filtered} used a Facebook-filtered view; `}
                    {savedCommentRetrySummary.review > 0 && `${savedCommentRetrySummary.review} legacy or generic result${savedCommentRetrySummary.review === 1 ? " needs" : "s need"} review; `}
                    {savedReactionReviewCount > 0 && `${savedReactionReviewCount} reaction result${savedReactionReviewCount === 1 ? " is" : "s are"} unavailable; `}
                    completed text-only items and attachment-only exclusions are kept unchanged.
                  </p>
                </div>
                {retryableMediaCount > 0 && <button type="button" onClick={handleRetryPartial} disabled={retryPartial.isPending || jobProgress?.status === "running"} className={cn(PRIMARY_BTN, "px-4 py-2 text-xs disabled:opacity-60")}>
                  {retryPartial.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting retry…</> : `Retry ${retryableMediaCount} failed detail${retryableMediaCount === 1 ? "" : "s"}`}
                </button>}
              </div>
            )}
            {!showingSaved && results.some((result) => result.ok && result.page) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-sm">
              <div>
                {!authed ? <Link href="/api/studio-enter" className="font-medium text-indigo-600 underline">Enter Studio to save to Google Sheets</Link> : !exportBrandId ? (
                  <p className="text-zinc-600">Choose a connected Google Drive destination to save these results.</p>
                ) : currentSheetSave?.phase === "saving" ? (
                  <p className="inline-flex items-center gap-2 text-indigo-700"><Loader2 className="h-4 w-4 animate-spin" /> {currentSheetSave.stage === "details" ? "Updating Google Sheet with details…" : "Saving media to Google Sheets…"}</p>
                ) : currentSheetSave?.phase === "error" ? (
                  <p role="alert" className="text-red-700">Google Sheet could not be saved: {currentSheetSave.error}</p>
                ) : currentSheetSave?.phase === "saved" ? (
                  <p className="text-emerald-700">{currentSheetSave.stage === "details" ? "Google Sheet updated with retrieved details." : "Media saved to Google Sheets."}</p>
                ) : <p className="text-zinc-600">Preparing Google Sheet…</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {currentSheetSave?.url && <a href={currentSheetSave.url} target="_blank" rel="noopener noreferrer" className={cn(PRIMARY_BTN, "px-4 py-2 text-sm")}><ExternalLink className="h-4 w-4" /> Open Google Sheet</a>}
                {currentSheetSave?.folderUrl && <a href={currentSheetSave.folderUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-indigo-600 hover:underline">Open folder</a>}
                {currentSheetSave?.phase === "error" && <button type="button" onClick={retrySheetSave} className={cn(SECONDARY_BTN, "px-3.5 py-2 text-xs")}>Retry save</button>}
              </div>
            </div>
            )}
            {(jobProgress || commentsJob || startComments.isPending || commentsError || detailsRecoveryNotice) && (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div role="status" aria-live="polite">
                    {commentsJobMissing ? <p className="text-red-700">Details retrieval was interrupted because the job expired or the server restarted. Run a fresh fetch to continue.</p> : commentsError ? <p className="text-red-700">Media is ready. Details could not be retrieved: {commentsError}</p> : jobProgress ? (
                      <>
                        <p className="font-semibold">
                          {jobProgress.status === "running" ? `Loading ${runningDetailsLabel}` : jobProgress.status === "cancelled" ? "Details retrieval cancelled" : "Details retrieval finished"}
                        </p>
                        <p className="mt-1 text-xs">
                          {finishedCommentsItems} / {jobProgress.total} items processed
                          {inFlightDetailPages > 0 && ` · ${inFlightDetailPages} detail page${inFlightDetailPages === 1 ? "" : "s"} active`}
                          {jobProgress.workers && ` · ${inFlightDetailPages}/${jobProgress.workers.capacity} workers active (max ${jobProgress.workers.requested})`}
                          {(completed?.requestedComments ?? jobProgress.includeComments) && ` · ${collectedComments} text comments and replies`}
                          {(jobProgress.excludedAttachmentCommentCount ?? 0) > 0 && ` · ${jobProgress.excludedAttachmentCommentCount} attachment-only excluded`}
                          {partialCommentsItems > 0 && ` · ${partialCommentsItems} with incomplete comments`}
                          {partialDetailItems > 0 && ` · ${partialDetailItems} with incomplete reactions or dates`}
                          {jobProgress.failed > 0 && ` · ${jobProgress.failed} failed`}
                        </p>
                        {finishedCommentsItems === 0 && inFlightDetailPages > 0 && (
                          <p className="mt-1 text-xs text-indigo-700">Facebook is starting up to {jobProgress.workers?.capacity ?? inFlightDetailPages} media detail workers. Counts advance when each page finishes, so sequential count changes do not mean the workers are running one at a time.</p>
                        )}
                      </>
                    ) : detailsRecoveryNotice ? (
                      <p className="text-amber-800">{detailsRecoveryNotice}</p>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Media is ready. Loading {detailsLabel}…</span>
                    )}
                  </div>
                  {jobProgress?.status === "running" && !commentsJobMissing && (
                    <button type="button" onClick={handleCancelComments} disabled={cancelComments.isPending} className={cn(SECONDARY_BTN, "px-3.5 py-2 text-xs disabled:opacity-60")}>
                      {cancelComments.isPending ? "Cancelling…" : "Cancel details"}
                    </button>
                  )}
                </div>
                {detailsRecoveryNotice && jobProgress && <p className="mt-2 text-xs text-indigo-700">{detailsRecoveryNotice}</p>}
                {jobProgress && <progress value={finishedCommentsItems} max={Math.max(jobProgress.total, 1)} aria-label="Details progress" className="mt-3 h-2 w-full accent-indigo-600" />}
                {workerSlots.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" aria-label="Comment worker activity">
                    {workerSlots.map((worker) => (
                      <div key={worker.slot} className={cn(
                        "rounded-lg border px-2.5 py-2 text-xs",
                        worker.state === "running" ? "border-indigo-300 bg-white text-indigo-950" : "border-indigo-100 bg-indigo-50/50 text-indigo-700",
                      )}>
                        <div className="flex items-center justify-between gap-2 font-semibold">
                          <span>Worker {worker.slot}</span>
                          <span className={worker.state === "running" ? "text-emerald-700" : "text-zinc-500"}>{worker.state === "running" ? "Active" : worker.state === "busy" ? "Busy" : "Idle"}</span>
                        </div>
                        {worker.state === "running" ? (
                          <>
                            <p className="mt-1 truncate text-zinc-700">{worker.contentType === "reels" ? "Reel" : "Photo"} {worker.postId}</p>
                            <p className="mt-0.5 text-indigo-700">{workerStageLabel(worker.stage)}</p>
                          </>
                        ) : <p className="mt-1 text-zinc-500">Ready for the next item</p>}
                      </div>
                    ))}
                  </div>
                )}
                {jobProgress?.error && <p className="mt-2 text-xs text-red-700">{jobProgress.error}</p>}
                {jobProgress?.sheetSave?.status === "saving" && <p className="mt-2 text-xs text-indigo-700">{showingSaved ? "Saving retry results in the local candidate workspace…" : "Saving results to Google Sheets…"}</p>}
                {jobProgress?.sheetSave?.status === "saved" && <p className="mt-2 text-xs text-emerald-700">{showingSaved ? "Retry results were merged into the local candidate workspace." : "Results were merged into Google Sheets."}</p>}
                {jobProgress?.sheetSave?.status === "failed" && <p className="mt-2 text-xs text-red-700">{showingSaved ? "Retry results were retrieved but could not be saved in the local workspace: " : "Results were retrieved but could not be saved: "}{jobProgress.sheetSave.error}</p>}
                {commentsProgress.isError && !commentsJobMissing && (
                  <p role="alert" className="mt-2 text-xs text-red-700">Details progress could not be updated. <button type="button" onClick={() => commentsProgress.refetch()} className="font-semibold underline">Retry</button></p>
                )}
              </div>
            )}
            {results.map((r, index) =>
              r.ok && r.page ? (
                <UnifiedFbResultCard
                  key={`${r.query}:${r.page.contentType}`}
                  page={r.page}
                  onRefresh={() => handleFetch(true)}
                  onOpenComments={(post) => setActiveCommentPost(post)}
                  onOpenReactors={(post) => setActiveReactorPost(post)}
                  onRetryComments={showingSaved ? handleRetrySingleComments : undefined}
                  savedPreviewImages={savedPreviewImages}
                  onNeedPreviews={restoreSavedPreviews}
                  savedDeltaFilter={showingSaved ? savedDeltaFilter : "all"}
                />
              ) : (
                <div
                  key={`${r.query}:error:${index}`}
                  role="alert"
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-5"
                >
                  <AlertTriangle className="h-6 w-6 shrink-0 text-red-600" />
                  <span className="flex-1 text-sm text-zinc-800">
                    Failed to fetch <strong className="text-zinc-950">{r.query}</strong>: {r.error}
                  </span>
                  <button type="button" onClick={() => handleFetch(true)} className={cn(SECONDARY_BTN, "px-4 py-2 text-xs")}>
                    Try again
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        </div>
      </main>

      {/* ── Modal for Inspecting Comments ── */}
      {shownCommentPost && (
        <FbCommentsModal
          post={shownCommentPost}
          onClose={() => setActiveCommentPost(null)}
        />
      )}

      {/* ── Modal for Inspecting Reactions / Reactors ── */}
      {activeReactorPost && (
        <FbReactorsModal
          post={activeReactorPost}
          onClose={() => setActiveReactorPost(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  UNIFIED FACEBOOK RESULT CARD
 * ──────────────────────────────────────────────────────────────────────────── */

function UnifiedFbResultCard({
  page,
  onRefresh,
  onOpenComments,
  onOpenReactors,
  onRetryComments,
  savedPreviewImages,
  onNeedPreviews,
  savedDeltaFilter,
}: {
  page: FbBrowserPage;
  onRefresh: () => void;
  onOpenComments: (post: FbBrowserPost) => void;
  onOpenReactors: (post: FbBrowserPost) => void;
  onRetryComments?: (post: FbBrowserPost) => void;
  savedPreviewImages: Record<string, string>;
  onNeedPreviews: (contentType: "posts" | "reels", posts: FbBrowserPost[]) => void;
  savedDeltaFilter: SavedDeltaFilter;
}) {
  const stats = page.stats;
  const allPosts = page.posts || [];
  const posts = useMemo(() => allPosts.filter((post) => {
    if (savedDeltaFilter === "all") return true;
    const delta = commentDelta(post);
    if (savedDeltaFilter === "missing") return delta == null;
    if (savedDeltaFilter === "complete") return delta === 0;
    return delta != null && deltaBucket(delta) === savedDeltaFilter;
  }), [allPosts, savedDeltaFilter]);
  const [visiblePosts, setVisiblePosts] = useState(48);
  const renderedPosts = posts.slice(0, visiblePosts);
  const contentLabel = page.contentType === "reels" ? "Reels" : "Photos";
  const retrieval = page.retrieval;

  useEffect(() => {
    if (page.contentType) onNeedPreviews(page.contentType, renderedPosts);
  }, [onNeedPreviews, page.contentType, renderedPosts]);

  useEffect(() => {
    setVisiblePosts(48);
  }, [savedDeltaFilter]);

  const totalCommentsScraped = posts.reduce(
    (acc, p) => acc + flattenFbComments(p.commentsData ?? []).length,
    0,
  );
  const requested = retrieval?.requested ?? stats?.requestedPosts;
  const isPartialFeed = requested != null && posts.length < requested;

  return (
    <Reveal className={cn(SURFACE.card, "overflow-hidden border border-zinc-200 bg-white p-6 shadow-md sm:p-8")}>
      {/* ── Header Row ── */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {page.profilePic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaProxy(page.profilePic)}
            alt={page.name}
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
              href={page.url}
              target="_blank"
              rel="noreferrer"
              className="font-display text-2xl uppercase tracking-tight text-zinc-900 hover:text-indigo-600 transition-colors"
            >
              {page.name}
            </a>
            {page.verified && (
              <span title="Verified">
                <CheckCircle2 className="h-5 w-5 text-sky-500" />
              </span>
            )}
            {page.category && (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                {page.category}
              </span>
            )}
            {page.kind && page.kind !== "page" && (
              <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium capitalize text-zinc-700">
                {page.kind}
              </span>
            )}
          </div>

          {page.handle && <p className="mt-1 text-sm font-semibold text-zinc-600">@{page.handle}</p>}
          {page.about && <p className="mt-1.5 whitespace-pre-line text-sm text-zinc-600 leading-relaxed">{page.about}</p>}

          {/* Social and Contact Badges */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {page.email && (
              <ContactChip href={`mailto:${page.email}`} icon={<Mail className="h-3 w-3" />} label={page.email} />
            )}
            {page.phone && (
              <ContactChip icon={<Phone className="h-3 w-3" />} label={page.phone} />
            )}
            {page.website && (
              <ContactChip href={page.website} icon={<Globe className="h-3 w-3" />} label={page.website.replace(/^https?:\/\//i, "")} />
            )}
            {page.instagram && (
              <ContactChip href={page.instagram} icon={<Link2 className="h-3 w-3" />} label="Instagram" />
            )}
            {page.twitter && (
              <ContactChip href={page.twitter} icon={<Link2 className="h-3 w-3" />} label="Twitter / X" />
            )}
          </div>
        </div>

        {/* External Link */}
        <div className="sm:ml-auto">
          <a
            href={page.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 shadow-sm transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View on Facebook
          </a>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-4">
        <div className="text-sm text-zinc-600">
          <strong className="text-zinc-900">{posts.length}{savedDeltaFilter !== "all" ? ` filtered of ${allPosts.length}` : ""} {contentLabel.toLowerCase()}</strong>
          {posts.some((post) => post.commentsStatus) && <span className="ml-2">· {totalCommentsScraped} comments &amp; replies</span>}
          {retrieval && (
            <span className="ml-2">
              · {retrieval.fromCache ? "Saved snapshot" : "Fetched"} {new Date(retrieval.capturedAt).toLocaleString()}
              {!retrieval.fromCache && Number.isFinite(retrieval.durationMs) && ` · ${(retrieval.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
        <button type="button" onClick={onRefresh} className={cn(SECONDARY_BTN, "px-3.5 py-2 text-xs")}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh from Facebook
        </button>
      </div>

      {isPartialFeed && (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <p>
            Returned {posts.length} of {requested} requested {contentLabel.toLowerCase()}.
            {retrieval?.stopReason === "end"
              ? " No more items were available in this view."
              : " Loading stopped before the requested limit. You can refresh to try again."}
          </p>
        </div>
      )}

      {/* ── Posts Section ── */}
      {posts.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">No {contentLabel.toLowerCase()} were returned.</p>
      )}
      {posts.length > 0 && (
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700">
              {contentLabel} ({posts.length})
            </span>
            {posts.length > renderedPosts.length && <span className="text-xs text-zinc-500">Showing {renderedPosts.length} of {posts.length}</span>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {renderedPosts.map((post, idx) => (
              <FbPostCardItem
                key={`${page.contentType}:${post.postId || idx}`}
                post={post}
                previewImage={page.contentType ? savedPreviewImages[savedPreviewKey(page.contentType, post.postId)] : undefined}
                onOpenComments={() => onOpenComments(post)}
                onOpenReactors={() => onOpenReactors(post)}
                onRetryComments={onRetryComments ? () => onRetryComments(post) : undefined}
              />
            ))}
          </div>
          {posts.length > renderedPosts.length && (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => setVisiblePosts((current) => Math.min(posts.length, current + 48))}
                className={cn(SECONDARY_BTN, "px-4 py-2 text-xs")}
              >
                Show 48 more {contentLabel.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      )}
    </Reveal>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  INDIVIDUAL POST CARD ITEM
 * ──────────────────────────────────────────────────────────────────────────── */

function FbPostCardItem({
  post,
  previewImage,
  onOpenComments,
  onOpenReactors,
  onRetryComments,
}: {
  post: FbBrowserPost;
  previewImage?: string;
  onOpenComments: () => void;
  onOpenReactors: () => void;
  onRetryComments?: () => void;
}) {
  const commentsCount = flattenFbComments(post.commentsData ?? []).length;
  const rawCommentGap = rawCommentDelta(post);
  const effectiveCommentTarget = reportedDeltaBasis(post);
  const currentCommentDelta = commentDelta(post);
  const verifiedPublicTarget = reportedDeltaBasis(post) !== post.commentsReportedCount ? reportedDeltaBasis(post) : null;
  const reactorsCount = post.reactorsData?.length ?? 0;
  const image = previewImage ?? post.images?.[0];
  const [imageFailed, setImageFailed] = useState(false);
  const isReel = post.mediaType === "reel" || post.isVideo;
  const metricsAvailable = post.metricsAvailable !== false;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm hover:shadow transition-all">
      <div className={cn("relative overflow-hidden bg-zinc-100", image && !imageFailed ? (isReel ? "aspect-[3/4]" : "aspect-square") : "h-28")}>
        {image && !imageFailed ? (
          <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaProxy(image)}
            alt={post.text ? post.text.slice(0, 120) : isReel ? "Reel thumbnail" : "Facebook photo"}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-contain"
          />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-400">
            <ImageIcon className="h-9 w-9" />
            <span className="text-xs">{imageFailed ? "Preview could not load" : "No saved preview"}</span>
            {post.url && <a href={post.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-indigo-600 hover:underline">{isReel ? "Watch reel on Facebook ↗" : "View photo on Facebook ↗"}</a>}
          </div>
        )}
          {isReel && (
            <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-0.5 text-[10px] font-medium text-white flex items-center gap-1">
              <Play className="h-2.5 w-2.5" /> Reel
            </span>
          )}
          {image && !imageFailed && (
          <a
            href={`${mediaProxy(image)}&dl=${encodeURIComponent(`facebook_${post.postId || "media"}`)}`}
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-black/85"
            title={isReel ? "Download thumbnail" : "Download photo"}
          >
            <Download className="h-3 w-3" /> {isReel ? "Thumbnail" : "Photo"}
          </a>
          )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        {post.text ? (
          <p className="line-clamp-3 whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed">
            {post.text}
          </p>
        ) : (
          <p className="text-xs text-zinc-500">{isReel ? "Reel" : "Photo"}</p>
        )}

        {/* Stats Row */}
        {(metricsAvailable || post.views != null || (post.commentsStatus && post.commentsReportedCount != null)) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-zinc-700">
          {metricsAvailable && !post.engagement && <>
          <span className="inline-flex items-center gap-1 text-rose-600">
            <Heart className="h-3.5 w-3.5 fill-rose-100" /> {fmt(post.likes)}
          </span>
          {post.shares > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600">
              <Share2 className="h-3.5 w-3.5 fill-amber-100" /> {fmt(post.shares)}
            </span>
          )}
          </>}
          {(post.commentsStatus || metricsAvailable) && (post.commentsReportedCount != null || metricsAvailable) && (
            <span className="inline-flex items-center gap-1 text-blue-600">
              <MessageSquare className="h-3.5 w-3.5 fill-blue-100" /> {fmt(post.commentsReportedCount ?? post.comments)} comments
            </span>
          )}
          {post.views != null && (
            <span className="inline-flex items-center gap-1 text-zinc-600">
              <Eye className="h-3.5 w-3.5" /> {fmt(post.views)} views
            </span>
          )}
        </div>
        )}
        {post.engagement && <FbEngagementCounts engagement={post.engagement} />}

        {(post.commentsReportedCount != null || effectiveCommentTarget != null || post.commentsStatus || commentsCount > 0) && (
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-[10px] font-medium text-zinc-600">
            <span>Reported <strong className="block text-xs text-zinc-900">{fmt(effectiveCommentTarget)}</strong></span>
            <span>Delta <strong className={cn("block text-xs", currentCommentDelta != null && currentCommentDelta > 0 ? "text-red-700" : "text-zinc-900")}>{fmt(currentCommentDelta)}</strong></span>
            <span>Scraped <strong className={cn("block text-xs", currentCommentDelta != null && currentCommentDelta > 0 ? "text-red-700" : "text-zinc-900")}>{fmt(commentsCount)}</strong></span>
          </div>
        )}

        {verifiedPublicTarget != null && rawCommentGap != null && rawCommentGap > 0 && (
          <p className="mt-2 text-[11px] text-amber-700">
            {fmt(verifiedPublicTarget)} comments repeatedly verified retrievable to this session; Facebook’s raw total remains {fmt(post.commentsReportedCount)}.
          </p>
        )}

        {post.publishedTime && (
          <p className="mt-2 text-[11px] text-zinc-400">{post.publishedTime}</p>
        )}

        {/* Action Buttons */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 border-t border-zinc-100">
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> Open {isReel ? "reel" : "photo"}
            </a>
          )}
          {post.video && (
            <a href={`${mediaProxy(post.video)}&dl=${encodeURIComponent(`facebook_${post.postId || "reel"}`)}`} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline">
              <Download className="h-3 w-3" /> Video
            </a>
          )}

          {/* Reactors Button */}
          {reactorsCount > 0 && (
            <button
              type="button"
              onClick={onOpenReactors}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50"
            >
              <ThumbsUp className="h-3 w-3 text-indigo-600" /> {reactorsCount}
            </button>
          )}

          {/* Comments Button */}
          {(post.commentsStatus || commentsCount > 0) && (
            <button
              type="button"
              onClick={onOpenComments}
              className="ml-auto inline-flex items-center gap-1 rounded-lg bg-indigo-50 border border-indigo-200 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
            >
              {post.commentsStatus === "running" || post.commentsStatus === "pending" ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
              {commentsCount} Comments
              {post.commentsStatus && post.commentsStatus !== "complete" && <span className="text-[10px] capitalize">· {post.commentsStatus}</span>}
            </button>
          )}
          {onRetryComments && currentCommentDelta != null && currentCommentDelta > 0 && (
            <button
              type="button"
              onClick={onRetryComments}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
            >
              <RefreshCw className="h-3 w-3" /> Retry comments
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FbEngagementCounts({ engagement }: { engagement: NonNullable<FbBrowserPost["engagement"]> }) {
  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-zinc-700">
        <span>Reactions {fmt(engagement.totalReactions)}</span>
        <span>Shares {fmt(engagement.shares)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-zinc-600">
        {(["like", "love", "care", "haha", "wow", "sad", "angry"] as const).map((type) => (
          <div key={type} className="flex items-center justify-between gap-1">
            <dt className="capitalize">{type}</dt>
            <dd className="font-semibold tabular-nums">{fmt(engagement.reactions[type])}</dd>
          </div>
        ))}
      </dl>
      {(engagement.status === "partial" || engagement.approximate) && (
        <p className="mt-2 text-[11px] text-amber-700">
          {engagement.status === "partial" && "Some counts unavailable"}
          {engagement.status === "partial" && engagement.approximate && " · "}
          {engagement.approximate && "Approximate counts"}
        </p>
      )}
      {engagement.error && <p className="mt-2 text-[11px] text-red-700">{engagement.error}</p>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 *  COMMENTS MODAL
 * ──────────────────────────────────────────────────────────────────────────── */

function FbCommentsModal({
  post,
  onClose,
}: {
  post: FbBrowserPost;
  onClose: () => void;
}) {
  const comments = flattenFbComments(post.commentsData ?? []);
  const stopLabel = commentStopLabel(post.commentsStopReason);
  const reportedComments = post.commentsReportedCount ?? (post.metricsAvailable === false ? null : post.comments);
  const verifiedActualTextCount = post.commentsContentScope === "text_only"
    && post.commentsStatus === "complete"
    && reportedComments != null
    && post.commentsObservedCount === reportedComments
    && post.commentsExcludedNonTextCount != null
    ? Math.max(0, reportedComments - post.commentsExcludedNonTextCount)
    : null;
  const unexposedReportedComments = reportedComments != null && post.commentsObservedCount != null && post.commentsObservedCount < reportedComments
    ? reportedComments - post.commentsObservedCount
    : 0;
  const verifiedRetrievableComments = verifiedRetrievableTarget(post);
  const verifiedUnavailableRemainder = reportedComments != null && verifiedRetrievableComments != null
    ? Math.max(0, reportedComments - verifiedRetrievableComments)
    : 0;
  const observedNodeScope = post.commentsContentScope === "observed_nodes";
  const textCommentCount = post.commentsTextCount ?? comments.filter((comment) => (comment.contentType ?? "text") === "text").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div role="dialog" aria-modal="true" aria-labelledby="facebook-comments-heading" className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-4">
          <div>
            <h3 id="facebook-comments-heading" className="font-display text-lg uppercase tracking-tight text-zinc-900 flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-indigo-600" />
              Scraped Comments ({comments.length})
            </h3>
            <p className="text-xs text-zinc-500">
              Reported comments on Facebook: {fmt(reportedComments)}
            </p>
            {post.commentsContentScope === "text_only" && (
              <p className="mt-1 text-xs text-zinc-500">
                Retrieved {fmt(post.commentsObservedCount)} · retained {fmt(post.commentsTextCount ?? comments.length)} text comments
                {post.commentsExcludedAttachmentCount != null && ` · ${fmt(post.commentsExcludedAttachmentCount)} attachment-only excluded`}
              </p>
            )}
            {observedNodeScope && (
              <p className="mt-1 text-xs text-zinc-500">
                Retrieved {fmt(post.commentsObservedCount ?? comments.length)} visible comment nodes · {fmt(textCommentCount)} text comments
              </p>
            )}
            {post.commentsSourceView && post.commentsSourceView !== "unknown" && (
              <p className="mt-1 text-xs text-zinc-500">
                Facebook comment view: {post.commentsSourceView === "all" ? "All comments" : post.commentsSourceView === "newest" ? "Newest (best available)" : "Most relevant"}
                {post.commentsSourceView === "newest" && " · this does not assert Facebook's raw total was fully exposed"}
              </p>
            )}
            {verifiedRetrievableComments != null && verifiedUnavailableRemainder > 0 && (
              <p className="mt-1 text-xs text-amber-800">
                Facebook reports {fmt(reportedComments)}; {fmt(verifiedRetrievableComments)} comments were repeatedly verified retrievable to this session and {fmt(comments.length)} are retained. The remaining {fmt(verifiedUnavailableRemainder)} are currently unavailable in Facebook; the raw reported total is kept for future rechecks.
              </p>
            )}
            {post.commentsContentScope === "text_only" && verifiedActualTextCount != null && (
              <p className="mt-1 text-xs text-emerald-700">Verified actual text comments: {fmt(verifiedActualTextCount)} · scraped text comments: {fmt(post.commentsTextCount ?? comments.length)}</p>
            )}
            {post.commentsContentScope === "text_only" && verifiedActualTextCount == null && unexposedReportedComments > 0 && (
              <p className="mt-1 text-xs text-amber-700">Actual text total is unknown: {fmt(unexposedReportedComments)} reported record{unexposedReportedComments === 1 ? " was" : "s were"} not exposed in the confirmed view.</p>
            )}
            {observedNodeScope ? (
              <p className="mt-1 text-xs text-zinc-500">Visible emoji-only, GIF, image/logo, video, and attachment comments are retained as labels such as [Emoji] and [GIF]. Facebook&apos;s reported total can still include hidden, deleted, or unexposed comments.</p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">This older saved result contains text comments only. A new details run will retain visible rich-media comment nodes too.</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Comments List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {post.commentsStatus && (
            <p role="status" className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              Comments: <span className="capitalize">{post.commentsStatus}</span>
              {stopLabel && ` · ${stopLabel}`}
              {post.commentsError && <span className="mt-1 block text-red-700">{post.commentsError}</span>}
            </p>
          )}
          {comments.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-500">
              <MessageSquare className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
              {post.commentsStatus === "pending" || post.commentsStatus === "running" ? "Comments and replies are loading…" : "No comments were extracted for this post."}
            </div>
          ) : (
            comments.map((c: FbBrowserComment) => (
              <div
                key={c.id || `${c.authorName}:${c.text}`}
                style={{ marginLeft: Math.min(c.depth, 4) * 16 }}
                className={cn(
                  "rounded-xl border p-3 text-sm transition-all",
                  c.depth > 0 ? "border-indigo-100 bg-indigo-50/30" : "border-zinc-200 bg-zinc-50/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {c.authorAvatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaProxy(c.authorAvatar)}
                        alt=""
                        className="h-6 w-6 rounded-full object-cover border border-zinc-200"
                      />
                    ) : (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-bold text-zinc-600">
                        {c.authorName[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    {c.authorProfileUrl ? (
                      <a
                        href={c.authorProfileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-zinc-900 hover:text-indigo-600 transition-colors"
                      >
                        {c.authorName}
                      </a>
                    ) : (
                      <span className="font-semibold text-zinc-900">{c.authorName}</span>
                    )}
                    {c.depth > 0 && (
                      <span className="rounded bg-indigo-100 px-1.5 py-0.2 text-[10px] font-medium text-indigo-700">
                        Reply
                      </span>
                    )}
                    {c.contentType && c.contentType !== "text" && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                        {c.contentType === "image" ? "Image/Logo" : c.contentType === "emoji" ? "Emoji" : c.contentType === "unavailable" ? "No text exposed" : c.contentType.toUpperCase()}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    {c.likeCount > 0 && <span>❤ {c.likeCount}</span>}
                    {(c.createdAt || c.timeLabel) && <span>{c.createdAt ?? c.timeLabel}</span>}
                  </div>
                </div>

                {c.text && <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed">{c.text}</p>}
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
 *  REACTORS / REACTIONS MODAL
 * ──────────────────────────────────────────────────────────────────────────── */

function FbReactorsModal({
  post,
  onClose,
}: {
  post: FbBrowserPost;
  onClose: () => void;
}) {
  const reactors = post.reactorsData || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-4">
          <div>
            <h3 className="font-display text-lg uppercase tracking-tight text-zinc-900 flex items-center gap-2">
              <ThumbsUp className="h-5 w-5 text-indigo-600" />
              Audience Reactions ({reactors.length})
            </h3>
            <p className="text-xs text-zinc-500">
              Total post reactions: {fmt(post.likes)}
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

        {/* List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {reactors.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-500">
              <Smile className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
              No reaction details were extracted for this post.
            </div>
          ) : (
            reactors.map((r: FbBrowserReactor, idx: number) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-2.5 text-sm"
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                    {r.name[0]?.toUpperCase() || "?"}
                  </div>
                  {r.link ? (
                    <a
                      href={r.link}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-zinc-900 hover:text-indigo-600 transition-colors"
                    >
                      {r.name}
                    </a>
                  ) : (
                    <span className="font-medium text-zinc-900">{r.name}</span>
                  )}
                </div>
                <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold capitalize text-indigo-700 border border-indigo-100">
                  {r.type || "like"}
                </span>
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
 *  HELPER COMPONENTS
 * ──────────────────────────────────────────────────────────────────────────── */

function ContactChip({
  href,
  label,
  icon,
}: {
  href?: string;
  label: string;
  icon: React.ReactNode;
}) {
  const inner = (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 shadow-xs">
      {icon}
      <span className="max-w-[12rem] truncate">{label}</span>
    </span>
  );
  if (!href) return inner;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="hover:opacity-80 transition-opacity">
      {inner}
    </a>
  );
}

function FbSkeleton() {
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

// Named export so the Facebook hub can embed the scraper as a tab.
export { FacebookInstantPage as FacebookScraper };
