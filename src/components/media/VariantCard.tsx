"use client";

import { Image, FileVideo, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VariantTagger } from "./VariantTagger";

interface VariantCardProps {
  file: File;
  index: number;
  metadata: {
    width?: number;
    height?: number;
    aspectRatio?: string;
    duration?: number;
  };
  tagging?: {
    platform?: string;
    accountId?: string;
    action?: string;
  };
  showTagger: boolean;
  onRemove: () => void;
  onTagChange: (tags: { platform?: string; accountId?: string; action?: string }) => void;
  brandId: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VariantCard({
  file,
  index,
  metadata,
  tagging,
  showTagger,
  onRemove,
  onTagChange,
  brandId,
}: VariantCardProps) {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const Icon = isVideo ? FileVideo : Image;
  const ext = file.name.split(".").pop()?.toUpperCase() || "";

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate max-w-[200px]">{file.name}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium">{ext}</span>
              <span>&middot;</span>
              <span>{formatFileSize(file.size)}</span>
              {metadata.width && metadata.height && (
                <>
                  <span>&middot;</span>
                  <span>
                    {metadata.width}x{metadata.height}
                  </span>
                </>
              )}
              {metadata.aspectRatio && (
                <>
                  <span>&middot;</span>
                  <span>{metadata.aspectRatio}</span>
                </>
              )}
              {metadata.duration != null && metadata.duration > 0 && (
                <>
                  <span>&middot;</span>
                  <span>{metadata.duration}s</span>
                </>
              )}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} className="h-8 w-8 p-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {showTagger && (
        <VariantTagger
          fileType={isImage ? "image" : isVideo ? "video" : "other"}
          value={tagging || {}}
          onChange={onTagChange}
          brandId={brandId}
        />
      )}
    </div>
  );
}
