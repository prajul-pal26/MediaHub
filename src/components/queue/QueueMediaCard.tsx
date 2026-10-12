"use client";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, FileVideo, Layers, Play, Clock, Grid3x3, Film, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type Counts = { queued: number; processing: number; completed: number; failed: number };

export interface QueueMediaGroup {
  id: string;
  title: string;
  tags?: string[];
  variant_count: number;
  status: string;
  created_at: string | null;
  totalJobs: number;
  hasPost: boolean;
  hasReel: boolean;
  post: Counts;
  reel: Counts;
  media_assets?: Array<{
    id: string;
    file_name: string;
    file_type: string;
    width?: number;
    height?: number;
    aspect_ratio?: string;
    duration_seconds?: number;
  }>;
}

const statItems: Array<{ key: keyof Counts; label: string; short: string; color: string; dot: string }> = [
  { key: "queued", label: "Queued", short: "Q", color: "text-gray-600", dot: "bg-gray-400" },
  { key: "processing", label: "Processing", short: "P", color: "text-blue-600", dot: "bg-blue-500" },
  { key: "completed", label: "Completed", short: "C", color: "text-green-600", dot: "bg-green-500" },
  { key: "failed", label: "Failed", short: "F", color: "text-red-600", dot: "bg-red-500" },
];

function getFileTypeInfo(fileType: string) {
  const ext = fileType.split("/")[1]?.toUpperCase() || "FILE";
  const isVideo = fileType.startsWith("video/");
  return {
    label: ext === "JPEG" ? "JPG" : ext,
    isVideo,
    icon: isVideo ? FileVideo : ImageIcon,
    badgeColor: isVideo ? "bg-purple-100 text-purple-700 border-purple-200" : "bg-blue-100 text-blue-700 border-blue-200",
  };
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
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

function BreakdownRow({
  label,
  icon: Icon,
  accent,
  counts,
  active,
  onRetry,
  retrying,
}: {
  label: string;
  icon: typeof Grid3x3;
  accent: string;
  counts: Counts;
  active: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 flex-wrap", !active && "opacity-50")}>
      <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border w-14 justify-center", accent)}>
        <Icon className="h-3 w-3" /> {label}
      </span>
      {active ? (
        <>
          <div className="flex items-center gap-2">
            {statItems.map((item) => (
              <span key={item.key} className="inline-flex items-center gap-1 text-xs" title={item.label}>
                <span className={cn("h-1.5 w-1.5 rounded-full", item.dot)} />
                <span className={cn("font-semibold tabular-nums", counts[item.key] > 0 ? item.color : "text-muted-foreground/50")}>
                  {counts[item.key]}
                </span>
              </span>
            ))}
          </div>
          {counts.failed > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px] ml-auto"
              onClick={onRetry}
              disabled={retrying}
            >
              <RefreshCw className={cn("h-3 w-3 mr-1", retrying && "animate-spin")} />
              Retry {counts.failed}
            </Button>
          )}
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">no jobs</span>
      )}
    </div>
  );
}

export function QueueMediaCard({
  group,
  onRetry,
  retryingCategory,
}: {
  group: QueueMediaGroup;
  onRetry: (groupId: string, category: "post" | "reel") => void;
  retryingCategory: { groupId: string; category: "post" | "reel" } | null;
}) {
  const firstAsset = group.media_assets?.[0];
  const typeInfo = firstAsset ? getFileTypeInfo(firstAsset.file_type) : null;
  const TypeIcon = typeInfo?.icon || ImageIcon;
  // A resized WebP from the byte proxy, not the base64 blob that used to ride
  // along in `metadata` — that blob made this endpoint 6.58 MB. Videos have no
  // server-side thumbnail (no ffmpeg in the `app` image), so they keep the icon.
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbnail =
    !thumbFailed && firstAsset?.id && (firstAsset.file_type || "").startsWith("image/")
      ? `/api/media/${firstAsset.id}?variant=thumb`
      : null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 flex items-start gap-3">
      {/* Compact thumbnail */}
      <div className="relative h-11 w-11 shrink-0 rounded-md overflow-hidden bg-zinc-100 flex items-center justify-center">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={group.title}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <TypeIcon className={cn("h-5 w-5", typeInfo?.isVideo ? "text-purple-400" : "text-zinc-400")} />
        )}
        {firstAsset?.duration_seconds && firstAsset.duration_seconds > 0 && (
          <span className="absolute bottom-0 right-0 bg-black/70 text-white text-[8px] leading-none px-1 py-0.5 rounded-tl flex items-center gap-0.5">
            <Play className="h-2 w-2" />
            {formatDuration(firstAsset.duration_seconds)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {/* Title row */}
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate">{group.title}</h3>
          {typeInfo && (
            <Badge variant="outline" className={cn("text-[9px] px-1 py-0 border shrink-0", typeInfo.badgeColor)}>
              {typeInfo.label}
            </Badge>
          )}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto shrink-0">
            <Clock className="h-3 w-3" />
            <span>{timeAgo(group.created_at)}</span>
            {group.variant_count > 1 && (
              <>
                <span>·</span>
                <Layers className="h-3 w-3" />
                <span>{group.variant_count}</span>
              </>
            )}
            <span>·</span>
            <span>{group.totalJobs} jobs</span>
          </div>
        </div>

        {/* Breakdown rows */}
        <div className="space-y-1.5">
          <BreakdownRow
            label="Post"
            icon={Grid3x3}
            accent="text-sky-700 bg-sky-50 border-sky-200"
            counts={group.post}
            active={group.hasPost}
            onRetry={() => onRetry(group.id, "post")}
            retrying={retryingCategory?.groupId === group.id && retryingCategory?.category === "post"}
          />
          <BreakdownRow
            label="Reel"
            icon={Film}
            accent="text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200"
            counts={group.reel}
            active={group.hasReel}
            onRetry={() => onRetry(group.id, "reel")}
            retrying={retryingCategory?.groupId === group.id && retryingCategory?.category === "reel"}
          />
        </div>
      </div>
    </div>
  );
}
