"use client";

import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Copy,
  Lock,
  LockOpen,
  MoveDown,
  MoveUp,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ANCHORS, type Anchor, type Layer } from "@/lib/editor/doc";
import { cn } from "@/lib/utils";
import type { EditorApi } from "../api";
import { ColorField, ControlRow, PanelSection, Segmented } from "../controls";
import {
  clamp,
  duplicateLayer,
  removeLayer,
  reorderLayer,
  resizeLayer,
  updateLayer,
  updateTextLayer,
} from "../doc-ops";
import { layerName } from "./LayersPanel";

const FONTS = ["Inter", "Georgia", "Impact", "Courier New", "Arial"];

const ALIGN_OPTIONS = [
  { value: "left" as const, label: "Left", icon: AlignLeft, iconOnly: true },
  { value: "center" as const, label: "Centre", icon: AlignCenter, iconOnly: true },
  { value: "right" as const, label: "Right", icon: AlignRight, iconOnly: true },
];

type WeightOption = "400" | "600" | "800";

const WEIGHT_OPTIONS: { value: WeightOption; label: string }[] = [
  { value: "400", label: "Regular" },
  { value: "600", label: "Medium" },
  { value: "800", label: "Bold" },
];

function nearestWeight(weight: number): WeightOption {
  if (weight >= 700) return "800";
  if (weight >= 500) return "600";
  return "400";
}

/**
 * Everything about the one selected layer, and nothing else.
 *
 * This panel replaces the active tool's panel while a layer is selected, which
 * is the mechanism that keeps the workspace from showing every control at once.
 */
export function LayerInspector({ api, layer }: { api: EditorApi; layer: Layer }) {
  const { doc } = api;
  const isVideo = doc.base.kind === "video";

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{layerName(layer)}</p>
          <p className="text-[11px] text-muted-foreground capitalize">{layer.type} layer</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Deselect"
          title="Deselect · Esc"
          onClick={() => api.select(null)}
        >
          <X />
        </Button>
      </header>

      {layer.type === "text" && layer.text && (
        <PanelSection title="Text">
          <Textarea
            value={layer.text.content}
            rows={3}
            placeholder="Type something"
            onChange={(event) =>
              api.commit(updateTextLayer(doc, layer.id, { content: event.target.value }), {
                coalesce: `text-content-${layer.id}`,
              })
            }
          />
          <Slider
            label="Size"
            formatValue={(value) => `${Math.round(value * 1000)}`}
            min={0.012}
            max={0.3}
            step={0.002}
            value={layer.text.sizeInUnits}
            onValueChange={(next) =>
              api.commit(updateTextLayer(doc, layer.id, { sizeInUnits: next }), {
                coalesce: `text-size-${layer.id}`,
              })
            }
          />
          <Segmented
            options={ALIGN_OPTIONS}
            value={layer.text.align}
            onChange={(align) => api.commit(updateTextLayer(doc, layer.id, { align }))}
          />
          <Segmented
            options={WEIGHT_OPTIONS}
            // Snapped to the nearest offered weight: a document authored
            // elsewhere (or the schema's own 700 default) still shows a
            // selection rather than three unpressed buttons.
            value={nearestWeight(layer.text.weight)}
            onChange={(weight) =>
              api.commit(updateTextLayer(doc, layer.id, { weight: Number(weight) }))
            }
          />
          <ControlRow label="Font">
            <select
              value={layer.text.fontFamily}
              onChange={(event) =>
                api.commit(updateTextLayer(doc, layer.id, { fontFamily: event.target.value }))
              }
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </ControlRow>
          <ColorField
            label="Colour"
            value={layer.text.color}
            onChange={(color) => api.commit(updateTextLayer(doc, layer.id, { color: color ?? "#ffffff" }))}
          />
          <ColorField
            label="Behind the text"
            allowNone
            value={layer.text.background}
            onChange={(background) => api.commit(updateTextLayer(doc, layer.id, { background }))}
          />
          <ToggleRow
            id={`shadow-${layer.id}`}
            label="Drop shadow"
            checked={layer.text.shadow}
            onChange={(shadow) => api.commit(updateTextLayer(doc, layer.id, { shadow }))}
          />
        </PanelSection>
      )}

      <PanelSection title="Position">
        <AnchorGrid
          value={layer.anchor}
          onChange={(anchor) => api.commit(updateLayer(doc, layer.id, { anchor }))}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The anchor is what the layer stays attached to when the output ratio changes.
        </p>
      </PanelSection>

      <PanelSection title="Size & angle">
        {/* A text layer's box is derived from its glyphs, so "Size" above is
            already its width control — a second one would fight with it. */}
        {layer.type !== "text" && (
          <Slider
            label="Size"
            formatValue={(value) => `${Math.round(value * 100)}%`}
            min={0.02}
            max={2}
            step={0.005}
            value={clamp(layer.size.w, 0.02, 2)}
            onValueChange={(next) =>
              api.commit(resizeLayer(doc, layer.id, next), { coalesce: `size-${layer.id}` })
            }
          />
        )}
        <Slider
          label="Rotation"
          formatValue={(value) => `${Math.round(value)}°`}
          min={-180}
          max={180}
          step={1}
          value={clamp(layer.rotation, -180, 180)}
          onValueChange={(next) =>
            api.commit(updateLayer(doc, layer.id, { rotation: next }), {
              coalesce: `rotation-${layer.id}`,
            })
          }
        />
        <Slider
          label="Opacity"
          formatValue={(value) => `${Math.round(value * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          value={layer.opacity}
          onValueChange={(next) =>
            api.commit(updateLayer(doc, layer.id, { opacity: next }), {
              coalesce: `opacity-${layer.id}`,
            })
          }
        />
      </PanelSection>

      {isVideo && <TimingSection api={api} layer={layer} />}

      <PanelSection title="Layer">
        <ToggleRow
          id={`lock-${layer.id}`}
          label="Lock position"
          checked={layer.locked}
          onChange={(locked) => api.commit(updateLayer(doc, layer.id, { locked }))}
          icon={layer.locked ? Lock : LockOpen}
        />
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => api.commit(reorderLayer(doc, layer.id, "up"))}
          >
            <MoveUp />
            Forward
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => api.commit(reorderLayer(doc, layer.id, "down"))}
          >
            <MoveDown />
            Back
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => {
              const result = duplicateLayer(doc, layer.id);
              api.commit(result.doc, { select: result.id });
            }}
          >
            <Copy />
            Duplicate
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="flex-1"
            onClick={() => api.commit(removeLayer(doc, layer.id), { select: null })}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </PanelSection>
    </div>
  );
}

/**
 * Relative timing by default: fractions of the clip survive being applied to a
 * clip of a different length, which absolute seconds cannot.
 */
function TimingSection({ api, layer }: { api: EditorApi; layer: Layer }) {
  const timing = layer.timing;
  const enabled = timing != null;

  return (
    <PanelSection title="Visible for">
      <ToggleRow
        id={`timing-${layer.id}`}
        label="Only part of the clip"
        checked={enabled}
        onChange={(on) =>
          api.commit(
            updateLayer(api.doc, layer.id, {
              timing: on ? { start: 0, end: 1, mode: "relative" } : null,
            })
          )
        }
      />
      {timing && (
        <>
          <Slider
            label="From"
            formatValue={(value) => `${Math.round(value * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            value={timing.start}
            onValueChange={(next) =>
              api.commit(
                updateLayer(api.doc, layer.id, {
                  timing: { ...timing, start: Math.min(next, timing.end - 0.01) },
                }),
                { coalesce: `timing-start-${layer.id}` }
              )
            }
          />
          <Slider
            label="To"
            formatValue={(value) => `${Math.round(value * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            value={timing.end}
            onValueChange={(next) =>
              api.commit(
                updateLayer(api.doc, layer.id, {
                  timing: { ...timing, end: Math.max(next, timing.start + 0.01) },
                }),
                { coalesce: `timing-end-${layer.id}` }
              )
            }
          />
        </>
      )}
    </PanelSection>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
  icon: Icon,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-2.5 py-2">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const ANCHOR_LABELS: Record<Anchor, string> = {
  tl: "Top left",
  tc: "Top centre",
  tr: "Top right",
  cl: "Centre left",
  cc: "Centre",
  cr: "Centre right",
  bl: "Bottom left",
  bc: "Bottom centre",
  br: "Bottom right",
};

function AnchorGrid({ value, onChange }: { value: Anchor; onChange: (anchor: Anchor) => void }) {
  return (
    <div className="grid w-fit grid-cols-3 gap-1 rounded-lg bg-muted p-1">
      {ANCHORS.map((anchor) => {
        const active = anchor === value;
        return (
          <button
            key={anchor}
            type="button"
            title={ANCHOR_LABELS[anchor]}
            aria-label={ANCHOR_LABELS[anchor]}
            aria-pressed={active}
            onClick={() => onChange(anchor)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              active ? "bg-background shadow-sm" : "hover:bg-background/60"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full transition-colors",
                active ? "bg-primary" : "bg-muted-foreground/40"
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
