"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";

type ResizeOption = "auto_crop" | "blur_bg" | "custom_crop" | "keep_original";

interface ResizeOptionsProps {
  needsResize: boolean;
  currentRatio: string;
  targetRatios: string[];
  selectedOption: ResizeOption;
  onChange: (option: ResizeOption) => void;
}

const options: { value: ResizeOption; label: string; description: string }[] = [
  { value: "auto_crop", label: "Auto center-crop", description: "Crop to target ratio from center" },
  { value: "blur_bg", label: "Blur background", description: "Keep full content, blur-fill background" },
  { value: "custom_crop", label: "Custom crop", description: "Manual crop tool at publish time" },
  { value: "keep_original", label: "Keep original", description: "Platform may add black bars" },
];

export function ResizeOptions({
  needsResize,
  currentRatio,
  targetRatios,
  selectedOption,
  onChange,
}: ResizeOptionsProps) {
  if (!needsResize) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600">
        <CheckCircle2 className="h-4 w-4" />
        Already {currentRatio} — no resizing needed
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Current ratio: {currentRatio} → Target: {targetRatios.join(" or ")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex flex-col items-start p-2.5 rounded-md border text-left transition-colors",
              selectedOption === opt.value
                ? "border-primary bg-primary/5"
                : "border-input hover:bg-accent"
            )}
          >
            <span className="text-xs font-medium">{opt.label}</span>
            <span className="text-[10px] text-muted-foreground">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
