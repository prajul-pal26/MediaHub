"use client";

import Link from "next/link";
import {
  ArrowLeft,
  BookmarkPlus,
  Check,
  CircleAlert,
  Loader2,
  Redo2,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RATIO_KEYS, RATIO_PRESETS, type RatioKey } from "@/lib/editor/doc";
import { cn } from "@/lib/utils";
import type { SaveStatus } from "./use-autosave";
import { RenderStatusBadge, type RenderStatus } from "./RenderStatusBadge";

interface EditorTopBarProps {
  title: string;
  onTitleChange: (title: string) => void;
  ratio: RatioKey;
  onRatioChange: (ratio: RatioKey) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  saveStatus: SaveStatus;
  onSave: () => void;
  onRender: () => void;
  renderStatus: RenderStatus;
  renderBusy: boolean;
  onSaveTemplate: () => void;
}

function isRatioKey(value: string): value is RatioKey {
  return (RATIO_KEYS as string[]).includes(value);
}

export function EditorTopBar({
  title,
  onTitleChange,
  ratio,
  onRatioChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saveStatus,
  onSave,
  onRender,
  renderStatus,
  renderBusy,
  onSaveTemplate,
}: EditorTopBarProps) {
  return (
    // Scrolls rather than clipping: on a narrow window the ratio group and the
    // actions together exceed the bar, and Render must never be the part that
    // falls off the edge.
    <header className="flex h-13 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-3">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="All edits"
        title="All edits"
        // The rendered element is an <a>, not a <button>.
        nativeButton={false}
        render={<Link href="/editor" />}
      >
        <ArrowLeft />
      </Button>

      <input
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        placeholder="Untitled edit"
        aria-label="Edit title"
        className="h-8 w-44 min-w-0 shrink-0 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium transition-colors outline-none hover:border-border focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />

      <ToggleGroup
        variant="segmented"
        value={ratio}
        onValueChange={(next) => {
          // Base UI reports "" when the pressed item is toggled off; the canvas
          // always has a ratio, so that is simply not a state to enter.
          if (next && isRatioKey(next)) onRatioChange(next);
        }}
        aria-label="Output ratio"
        className="shrink-0"
      >
        {RATIO_KEYS.map((key) => (
          <ToggleGroupItem
            key={key}
            value={key}
            className="px-2 text-xs"
            title={`${RATIO_PRESETS[key].label} · ${RATIO_PRESETS[key].w}×${RATIO_PRESETS[key].h}`}
          >
            {key}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Undo"
          title="Undo · ⌘Z"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Redo"
          title="Redo · ⇧⌘Z"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 />
        </Button>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SaveIndicator status={saveStatus} />
        {renderStatus !== "idle" && <RenderStatusBadge status={renderStatus} />}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Save as template"
          title="Save as template"
          onClick={onSaveTemplate}
        >
          <BookmarkPlus />
        </Button>

        <Button variant="outline" size="sm" onClick={onSave} disabled={saveStatus === "saving"}>
          Save
        </Button>

        <Button size="sm" onClick={onRender} disabled={renderBusy}>
          {renderBusy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {renderBusy ? "Rendering…" : "Render"}
        </Button>
      </div>
    </header>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlert />
        Not saved
      </Badge>
    );
  }
  const saving = status === "saving" || status === "dirty";
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs transition-colors",
        saving ? "text-muted-foreground" : "text-emerald-600"
      )}
    >
      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      {saving ? "Saving…" : "Saved"}
    </span>
  );
}
