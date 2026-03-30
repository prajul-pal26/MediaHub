"use client";

import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface CaptionEditorProps {
  caption: string;
  tags: string[];
  activePlatforms: string[];
  overrides: Record<string, string>;
  onOverrideChange: (key: string, value: string) => void;
  onCaptionChange: (caption: string) => void;
}

export function CaptionEditor({
  caption,
  tags,
  activePlatforms,
  overrides,
  onOverrideChange,
  onCaptionChange,
}: CaptionEditorProps) {
  const hasIG = activePlatforms.includes("instagram");
  const hasYT = activePlatforms.includes("youtube");
  const hasLI = activePlatforms.includes("linkedin");
  const hashTags = tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Main Caption</Label>
        <Textarea
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="Caption for all platforms..."
          rows={3}
        />
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Per-platform overrides */}
      {(hasIG || hasYT || hasLI) && (
        <div className="space-y-3 pt-2 border-t">
          <p className="text-xs font-medium text-muted-foreground">Platform overrides (optional)</p>

          {hasIG && (
            <div className="space-y-1">
              <Label className="text-xs">Instagram caption</Label>
              <Textarea
                value={overrides.instagram || ""}
                onChange={(e) => onOverrideChange("instagram", e.target.value)}
                placeholder={`Default: ${(caption + " " + hashTags).slice(0, 60)}...`}
                rows={2}
                className="text-sm"
              />
              {activePlatforms.some((p) => p === "instagram") && (
                <p className="text-[10px] text-muted-foreground">
                  Stories skip captions automatically
                </p>
              )}
            </div>
          )}

          {hasYT && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">YouTube title</Label>
                <Input
                  value={overrides.youtube_title || ""}
                  onChange={(e) => onOverrideChange("youtube_title", e.target.value)}
                  placeholder={`Default: ${caption?.slice(0, 60) || "Untitled"}...`}
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">YouTube description</Label>
                <Textarea
                  value={overrides.youtube_description || ""}
                  onChange={(e) => onOverrideChange("youtube_description", e.target.value)}
                  placeholder="Default: uses main caption"
                  rows={2}
                  className="text-sm"
                />
              </div>
            </>
          )}

          {hasLI && (
            <div className="space-y-1">
              <Label className="text-xs">LinkedIn caption</Label>
              <Textarea
                value={overrides.linkedin || ""}
                onChange={(e) => onOverrideChange("linkedin", e.target.value)}
                placeholder={`Default: ${(caption + " " + hashTags).slice(0, 60)}...`}
                rows={2}
                className="text-sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
