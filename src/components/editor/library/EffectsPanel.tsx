"use client";

import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { Effect } from "@/lib/editor/doc";
import { EFFECT_CATALOG, effectsToCss } from "@/lib/editor/effects";
import {
  Aperture,
  CircleOff,
  Coffee,
  Contrast,
  Droplet,
  RotateCcw,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { PanelHeader } from "./panel-chrome";

/**
 * Colour adjustments for the base media.
 *
 * `effects` is treated as immutable throughout: every handler returns a brand
 * new array because the shell keeps an undo/redo history that compares by
 * identity, and mutating in place would silently lose a step.
 *
 * The catalog is the single source of ranges, steps and no-op defaults, so the
 * same numbers drive the CSS preview, sharp and ffmpeg.
 */

interface EffectsPanelProps {
  effects: Effect[];
  onChange: (next: Effect[]) => void;
}

/** Structural copy of the catalog entry, so this panel owns no catalog shape. */
interface EffectSpecLike {
  key: Effect["type"];
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  icon?: string;
}

/** The catalog stays DOM-free and names its icon, so the UI resolves it. */
const ICONS: Record<string, React.ElementType> = {
  Sun,
  Contrast,
  Droplet,
  CircleOff,
  Coffee,
  Aperture,
};

// `Object.values` reads a record and an array identically, so the panel does not
// care which shape the catalog is exported as.
const SPECS: EffectSpecLike[] = Object.values(EFFECT_CATALOG);

/**
 * Blur is a radius in pixels; everything else is a multiplier where the no-op
 * is 1 (brightness) or 0 (grayscale). Percentages are what editing software
 * shows for those, and they keep the column of readouts one width.
 */
function readout(value: number, spec: EffectSpecLike): string {
  if (spec.unit === "px") return `${Math.round(value)}px`;
  return `${Math.round(value * 100)}%`;
}

export function EffectsPanel({ effects, onChange }: EffectsPanelProps) {
  const previewFilter = useMemo(() => effectsToCss(effects), [effects]);

  function setValue(spec: EffectSpecLike, value: number) {
    const existing = effects.some((effect) => effect.type === spec.key);
    if (existing) {
      // Map, never splice — the order of the stack is how the renderers compose
      // their matrices, so it has to survive a drag unchanged.
      onChange(
        effects.map((effect) =>
          effect.type === spec.key ? { type: effect.type, value } : effect
        )
      );
      return;
    }
    onChange([...effects, { type: spec.key, value }]);
  }

  function resetOne(spec: EffectSpecLike) {
    onChange(effects.filter((effect) => effect.type !== spec.key));
  }

  return (
    <div className="space-y-4">
      <PanelHeader icon={SlidersHorizontal} title="Adjust" hint="Applied to the base media">
        {effects.length > 0 && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
            <RotateCcw />
            Reset all
          </Button>
        )}
      </PanelHeader>

      <EffectPreview filter={previewFilter} />

      <div className="space-y-3.5">
        {SPECS.map((spec) => {
          const entry = effects.find((effect) => effect.type === spec.key);
          return (
            <EffectRow
              key={spec.key}
              spec={spec}
              value={entry ? entry.value : spec.default}
              // An entry exists ⇒ resetting it changes the document. No entry and
              // the value is already the no-op, so the control would do nothing.
              resettable={Boolean(entry)}
              onValueChange={(value) => setValue(spec, value)}
              onReset={() => resetOne(spec)}
            />
          );
        })}
      </div>
    </div>
  );
}

function EffectRow({
  spec,
  value,
  resettable,
  onValueChange,
  onReset,
}: {
  spec: EffectSpecLike;
  value: number;
  resettable: boolean;
  onValueChange: (value: number) => void;
  onReset: () => void;
}) {
  const labelId = useId();
  const Icon = spec.icon ? ICONS[spec.icon] : undefined;
  const modified = value !== spec.default;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          id={labelId}
          className="flex items-center gap-1.5 text-sm leading-none font-medium"
        >
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          {spec.label}
        </span>
        <span className="flex items-center gap-0.5">
          <span
            className={cn(
              "text-xs tabular-nums",
              modified ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {readout(value, spec)}
          </span>
          {/* Rendered only when it would actually change something; the fixed
              box keeps the readout from shifting as it appears. */}
          <span className="flex size-6 items-center justify-center">
            {resettable && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                onClick={onReset}
                aria-label={`Reset ${spec.label}`}
                title={`Reset ${spec.label}`}
                className="text-muted-foreground"
              >
                <RotateCcw />
              </Button>
            )}
          </span>
        </span>
      </div>

      {/* The label is outside the slider so the reset button is not nested in a
          <label>; aria-labelledby is what gives the thumb its accessible name. */}
      <Slider
        aria-labelledby={labelId}
        value={value}
        onValueChange={onValueChange}
        min={spec.min}
        max={spec.max}
        step={spec.step}
      />
    </div>
  );
}

/**
 * A live swatch rather than a thumbnail of the real media: the panel is
 * independently mountable and must not need the canvas to be useful. The hues
 * make saturation/sepia/grayscale legible and the stripes make blur legible.
 */
function EffectPreview({ filter }: { filter: string }) {
  return (
    <div
      aria-hidden="true"
      className="relative h-12 overflow-hidden rounded-lg border bg-muted"
    >
      {/* Oversized so a blur does not reveal transparent edges. */}
      <div className="absolute -inset-4" style={{ filter }}>
        <div
          className="h-full w-full"
          style={{
            background:
              "linear-gradient(90deg,#f43f5e 0%,#f59e0b 25%,#22c55e 50%,#0ea5e9 75%,#8b5cf6 100%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(255,255,255,0.5) 0 7px, rgba(0,0,0,0.22) 7px 14px)",
          }}
        />
      </div>
    </div>
  );
}
