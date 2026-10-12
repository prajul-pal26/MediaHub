"use client";

import {
  Crop,
  Layers,
  LayoutTemplate,
  Music,
  SlidersHorizontal,
  Sticker,
  Type,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EditorTool } from "./editor-state";

interface ToolRailProps {
  tool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  /** Badge counts, e.g. how many layers the document has. */
  layerCount: number;
}

const TOOLS: { tool: EditorTool; label: string; icon: React.ElementType }[] = [
  { tool: "adjust", label: "Adjust & crop", icon: Crop },
  { tool: "stickers", label: "Stickers", icon: Sticker },
  { tool: "text", label: "Text", icon: Type },
  { tool: "effects", label: "Effects", icon: SlidersHorizontal },
  { tool: "audio", label: "Music", icon: Music },
  { tool: "templates", label: "Templates", icon: LayoutTemplate },
  // "Elements", not "Layers": this lists the stickers, text and shapes placed
  // ON TOP of the media. "Layers" is Illustrator jargon and read as "templates"
  // to the person this was built for, which is all the evidence a label needs.
  { tool: "layers", label: "Elements", icon: Layers },
];

/**
 * The left rail. Icons only — every label lives in a tooltip, and every control
 * belonging to a tool lives in the inspector. This is half of what keeps the
 * workspace from turning into a wall of options.
 */
export function ToolRail({ tool, onToolChange, layerCount }: ToolRailProps) {
  return (
    <nav
      aria-label="Editor tools"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-3"
    >
      {TOOLS.map((entry) => {
        const Icon = entry.icon;
        const active = tool === entry.tool;
        return (
          <Tooltip key={entry.tool}>
            <TooltipTrigger
              aria-label={entry.label}
              aria-pressed={active}
              onClick={() => onToolChange(entry.tool)}
              className={cn(
                "relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {entry.tool === "layers" && layerCount > 0 && (
                <span className="absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                  {layerCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">{entry.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
