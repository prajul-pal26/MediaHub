"use client";

import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Image, FileVideo, Layers, Play, Clock, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const isImage = fileType.startsWith("image/");
  const isVideo = fileType.startsWith("video/");
  return {
    label: ext === "JPEG" ? "JPG" : ext,
    isImage,
    isVideo,
    icon: isImage ? Image : FileVideo,
    accentColor: isVideo ? "from-purple-500/10 to-indigo-500/10" : "from-blue-500/10 to-cyan-500/10",
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
};

export function MediaGroupCard({ group, onDelete }: MediaGroupCardProps & { onDelete?: (groupId: string) => void }) {
  const router = useRouter();
  const firstAsset = group.media_assets?.[0];
  const typeInfo = firstAsset ? getFileTypeInfo(firstAsset.file_type) : null;
  const TypeIcon = typeInfo?.icon || Image;
  const thumbnail = firstAsset?.metadata?.thumbnail;

  return (
    <div
      className={cn(
        "group relative rounded-xl border border-zinc-200 shadow-sm overflow-hidden cursor-pointer transition-all duration-200",
        "hover:shadow-md hover:border-zinc-300 hover:-translate-y-0.5",
        "bg-white"
      )}
      onClick={() => router.push(`/publish/${group.id}`)}
    >
      {/* Thumbnail */}
      {thumbnail ? (
        <div className="relative h-36 bg-zinc-100">
          <img src={thumbnail} alt={group.title} className="w-full h-full object-cover" />
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(group.id); }}
              className="absolute top-2 left-2 h-7 w-7 rounded-full bg-black/50 hover:bg-red-600 text-white flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {firstAsset?.duration_seconds && firstAsset.duration_seconds > 0 && (
            <div className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1">
              <Play className="h-2.5 w-2.5" />
              {formatDuration(firstAsset.duration_seconds)}
            </div>
          )}
          <div className="absolute top-2 right-2">
            <Badge variant="outline" className={cn("text-[10px] border bg-white/90", typeInfo?.badgeColor || "")}>
              {typeInfo?.label || "FILE"}
            </Badge>
          </div>
        </div>
      ) : (
        <div className="relative h-24 bg-zinc-50 flex items-center justify-center">
          <TypeIcon className="h-8 w-8 text-zinc-300" />
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(group.id); }}
              className="absolute top-2 left-2 h-7 w-7 rounded-full bg-black/50 hover:bg-red-600 text-white flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", typeInfo?.iconBg || "bg-gray-100 text-gray-500")}>
              <TypeIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm truncate">{group.title}</h3>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>{timeAgo(group.created_at)}</span>
                {group.variant_count > 1 && (
                  <>
                    <span>&middot;</span>
                    <Layers className="h-3 w-3" />
                    <span>{group.variant_count} variants</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <Badge variant="outline" className={cn("text-[10px] shrink-0 border", typeInfo?.badgeColor || "")}>
            {typeInfo?.label || "FILE"}
          </Badge>
        </div>

        {/* Middle row: status + metadata */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={group.status} />
          {firstAsset?.aspect_ratio && (
            <span className="text-xs text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded">
              {firstAsset.aspect_ratio}
            </span>
          )}
          {firstAsset?.width && firstAsset?.height && (
            <span className="text-xs text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded">
              {firstAsset.width}x{firstAsset.height}
            </span>
          )}
          {firstAsset?.duration_seconds && firstAsset.duration_seconds > 0 && (
            <span className="text-xs text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded flex items-center gap-1">
              <Play className="h-2.5 w-2.5" />
              {formatDuration(firstAsset.duration_seconds)}
            </span>
          )}
        </div>

        {/* Tags */}
        {group.tags && group.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {group.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="text-[11px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded">
                #{tag}
              </span>
            ))}
            {group.tags.length > 4 && (
              <span className="text-[11px] text-muted-foreground">+{group.tags.length - 4}</span>
            )}
          </div>
        )}

        {/* Platform badges */}
        {group.media_assets && group.media_assets.some((a) => a.tagged_platform) && (
          <div className="flex flex-wrap gap-1">
            {group.media_assets
              .filter((a) => a.tagged_platform)
              .map((a) => (
                <Badge
                  key={a.id}
                  variant="outline"
                  className={cn("text-[10px] border", platformColors[a.tagged_platform!] || "")}
                >
                  {a.tagged_platform}
                </Badge>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
