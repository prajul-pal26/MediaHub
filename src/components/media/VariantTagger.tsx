"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VariantTaggerProps {
  fileType: "image" | "video" | "other";
  value: { platform?: string; accountId?: string; action?: string };
  onChange: (tags: { platform?: string; accountId?: string; action?: string }) => void;
  brandId: string;
}

const imageActions = [
  { value: "post", label: "Post" },
  { value: "story", label: "Story" },
  { value: "carousel", label: "Carousel" },
  { value: "article", label: "Article Cover" },
];

const videoActions = [
  { value: "reel", label: "Reel" },
  { value: "short", label: "Short" },
  { value: "story", label: "Story" },
  { value: "video", label: "Video" },
];

const platforms = [
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "linkedin", label: "LinkedIn" },
];

export function VariantTagger({ fileType, value, onChange, brandId }: VariantTaggerProps) {
  const actions = fileType === "video" ? videoActions : imageActions;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={value.platform || ""}
        onValueChange={(v) => onChange({ ...value, platform: v || undefined })}
      >
        <SelectTrigger className="w-[140px] h-8 text-xs">
          <SelectValue placeholder="Platform" />
        </SelectTrigger>
        <SelectContent>
          {platforms.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.action || ""}
        onValueChange={(v) => onChange({ ...value, action: v || undefined })}
      >
        <SelectTrigger className="w-[130px] h-8 text-xs">
          <SelectValue placeholder="Action" />
        </SelectTrigger>
        <SelectContent>
          {actions.map((a) => (
            <SelectItem key={a.value} value={a.value}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
