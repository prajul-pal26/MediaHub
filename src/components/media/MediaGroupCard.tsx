"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Image, FileVideo, Layers, Play, Clock, Trash2, Wand2, Grid3x3, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// Per-media publishing breakdown (same model + colours as the old Queue card):
// gray = queued, blue = processing, green = completed, red = failed,
// slate = cancelled. Cancelled is deliberately NOT red: a run the user stopped
// on purpose must not look like a broken one.
export type JobCounts = {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
};
export interface GroupJobStats {
  post: JobCounts;
  reel: JobCounts;
  hasPost: boolean;
  hasReel: boolean;
  totalJobs: number;
}

// A clean per-category indicator: category chip + a proportional segmented bar
// (green=published, blue=processing, gray=queued, red=failed) + a readable
// "done/total" summary, a failed count, and a retry action when needed.
const barSegments: Array<{ key: keyof JobCounts; color: string }> = [
  { key: "completed", color: "bg-emerald-500" },
  { key: "processing", color: "bg-blue-500" },
  { key: "queued", color: "bg-zinc-300" },
  { key: "failed", color: "bg-red-500" },
  // Slate, not red: a cancelled job was stopped on purpose and is not a failure.
  { key: "cancelled", color: "bg-slate-400" },
];

function CategoryStat({
  label,
  icon: Icon,
  accent,
  counts,
  onRetry,
  retrying,
}: {
  label: string;
  icon: typeof Grid3x3;
  accent: string;
  counts: JobCounts;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const total =
    counts.queued + counts.processing + counts.completed + counts.failed + counts.cancelled;
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2.5">
      <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border shrink-0", accent)}>
        <Icon className="h-3 w-3" /> {label}
      </span>

      {/* Proportional status bar */}
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-zinc-100 shrink-0" title={`${counts.completed} published · ${counts.processing} processing · ${counts.queued} queued · ${counts.failed} failed · ${counts.cancelled} cancelled`}>
        {barSegments.map((seg) =>
          counts[seg.key] > 0 ? (
            <div key={seg.key} className={seg.color} style={{ flexGrow: counts[seg.key] }} />
          ) : null
        )}
      </div>

      {/* Readable summary */}
      <span className="text-[11px] tabular-nums shrink-0">
        <span className="font-semibold text-emerald-600">{counts.completed}</span>
        <span className="text-muted-foreground">/{total}</span>
      </span>
      {counts.processing > 0 && (
        <span className="text-[11px] font-medium text-blue-600 tabular-nums shrink-0">{counts.processing} sending</span>
      )}
      {counts.failed > 0 && (
        <span className="text-[11px] font-medium text-red-600 tabular-nums shrink-0">{counts.failed} failed</span>
      )}
      {counts.cancelled > 0 && (
        <span className="text-[11px] font-medium text-slate-500 tabular-nums shrink-0">
          {counts.cancelled} cancelled
        </span>
      )}
      {(counts.failed > 0 || counts.cancelled > 0) && onRetry && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRetry(); }}
          disabled={retrying}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={cn("h-2.5 w-2.5", retrying && "animate-spin")} /> Retry
        </button>
      )}
    </div>
  );
}

interface MediaGroupCardProps {
  group: {
    id: string;
    title: string;
    caption?: string;
    tags?: string[];
    variant_count: number;
    status: string;
    created_at: string;
    media_assets?: Array<{
      id: string;
      file_name: string;
      file_type: string;
      width?: number;
      height?: number;
      aspect_ratio?: string;
      duration_seconds?: number;
      tagged_platform?: string;
      tagged_account_id?: string;
      metadata?: { thumbnail?: string };
    }>;
  };
}

function getFileTypeInfo(fileType: string) {
  const ext = fileType.split("/")[1]?.toUpperCase() || "FILE";
  const isVideo = fileType.startsWith("video/");
  return {
    label: ext === "JPEG" ? "JPG" : ext,
    isVideo,
    icon: isVideo ? FileVideo : Image,
    iconBg: isVideo ? "bg-purple-100 text-purple-600" : "bg-blue-100 text-blue-600",
    badgeColor: isVideo ? "bg-purple-100 text-purple-700 border-purple-200" : "bg-blue-100 text-blue-700 border-blue-200",
  };
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const platformColors: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  youtube: "bg-red-100 text-red-700 border-red-200",
  linkedin: "bg-blue-100 text-blue-700 border-blue-200",
  facebook: "bg-blue-100 text-blue-700 border-blue-200",
};

export function MediaGroupCard({
  group,
  onDelete,
  onEdit,
  jobStats,
  onRetryJobs,
  retryingCategory,
}: MediaGroupCardProps & {
  onDelete?: (groupId: string) => void;
  onEdit?: (groupId: string) => void;
  jobStats?: GroupJobStats;
  onRetryJobs?: (groupId: string, category: "post" | "reel" | "all") => void;
  retryingCategory?: { groupId: string; category: "post" | "reel" | "all" } | null;
}) {
  const router = useRouter();
  const [posterFailed, setPosterFailed] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const firstAsset = group.media_assets?.[0];
  const typeInfo = firstAsset ? getFileTypeInfo(firstAsset.file_type) : null;
  const TypeIcon = typeInfo?.icon || Image;
  const isImage = Boolean(firstAsset?.file_type?.startsWith("image/"));
  const isVideo = Boolean(firstAsset?.file_type?.startsWith("video/"));
  // One tiny WebP per tile, image or video, from the byte proxy's ?variant=thumb
  // (ffmpeg is in the app image, so videos get a real poster frame). Never the
  // original: that measured 1.94 MB / 1.53s EACH, and a video tile streaming its
  // own file was the slowest thing left on a mostly-video library. The proxy
  // caches to disk, so this survives restarts.
  const imgSrc =
    firstAsset?.metadata?.thumbnail ||
    (firstAsset ? `/api/media/${firstAsset.id}?variant=thumb` : undefined);
  // Only if the poster itself fails: then fall back to the streamed first frame.
  const videoSrc = isVideo && firstAsset && posterFailed
    ? `/api/media/${firstAsset.id}#t=0.1`
    : undefined;
  const taggedPlatforms = Array.from(
    new Set((group.media_assets || []).map((a) => a.tagged_platform).filter(Boolean) as string[])
  );

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border border-zinc-200 bg-white overflow-hidden cursor-pointer transition-all",
        "hover:border-zinc-300 hover:shadow-md"
      )}
      onClick={() => router.push(`/publish/${group.id}`)}
    >
      {/* Preview */}
      <div className="relative aspect-[4/5] w-full bg-zinc-900 overflow-hidden flex items-center justify-center">
        {imgSrc && !posterFailed ? (
          <img
            src={imgSrc}
            alt={group.title}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setPosterFailed(true)}
          />
        ) : videoSrc && !previewFailed ? (
          <video
            src={videoSrc}
            preload="metadata"
            muted
            playsInline
            className="h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-zinc-500">
            <TypeIcon className="h-9 w-9" />
            <span className="text-[10px] font-medium uppercase tracking-wide">{typeInfo?.label || "File"}</span>
          </div>
        )}

        {/* Type badge */}
        {typeInfo && (
          <Badge variant="outline" className={cn("absolute top-2 right-2 text-[9px] px-1 py-0 border bg-white/90", typeInfo.badgeColor)}>
            {typeInfo.label}
          </Badge>
        )}

        {/* Status badge */}
        <div className="absolute top-2 left-2">
          <StatusBadge status={group.status} className="text-[9px] shadow-sm" />
        </div>

        {/* Duration */}
        {firstAsset?.duration_seconds && firstAsset.duration_seconds > 0 && (
          <span className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] font-medium leading-none px-1.5 py-0.5 rounded flex items-center gap-1">
            <Play className="h-2.5 w-2.5" />
            {formatDuration(firstAsset.duration_seconds)}
          </span>
        )}

        {/* Hover actions */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEdit && (
            <button
              title="Edit"
              className="h-7 w-7 rounded-md bg-white/90 hover:bg-white text-zinc-700 flex items-center justify-center shadow-sm"
              onClick={(e) => { e.stopPropagation(); onEdit(group.id); }}
            >
              <Wand2 className="h-3.5 w-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              title="Delete"
              className="h-7 w-7 rounded-md bg-white/90 hover:bg-white text-zinc-700 hover:text-red-600 flex items-center justify-center shadow-sm"
              onClick={(e) => { e.stopPropagation(); onDelete(group.id); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-3 space-y-1.5">
        <h3 className="font-medium text-sm truncate">{group.title}</h3>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
          <Clock className="h-3 w-3 shrink-0" />
          <span>{timeAgo(group.created_at)}</span>
          {group.variant_count > 1 && (
            <>
              <span>·</span>
              <Layers className="h-3 w-3 shrink-0" />
              <span>{group.variant_count}</span>
            </>
          )}
          {firstAsset?.width && firstAsset?.height && (
            <>
              <span>·</span>
              <span>{firstAsset.width}×{firstAsset.height}</span>
            </>
          )}
        </div>

        {taggedPlatforms.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {taggedPlatforms.map((p) => (
              <Badge key={p} variant="outline" className={cn("text-[9px] px-1 py-0 border capitalize", platformColors[p] || "")}>
                {p}
              </Badge>
            ))}
          </div>
        )}

        {/* Publishing breakdown — Post + Reel combined into one line */}
        {jobStats && jobStats.totalJobs > 0 && (
          <div className="pt-1" onClick={(e) => e.stopPropagation()}>
            <CategoryStat
              label="Jobs"
              icon={Layers}
              accent="text-zinc-700 bg-zinc-50 border-zinc-200"
              counts={{
                queued: jobStats.post.queued + jobStats.reel.queued,
                processing: jobStats.post.processing + jobStats.reel.processing,
                completed: jobStats.post.completed + jobStats.reel.completed,
                failed: jobStats.post.failed + jobStats.reel.failed,
                cancelled: jobStats.post.cancelled + jobStats.reel.cancelled,
              }}
              onRetry={onRetryJobs ? () => onRetryJobs(group.id, "all") : undefined}
              retrying={retryingCategory?.groupId === group.id}
            />
          </div>
        )}
      </div>
    </div>
  );
}
