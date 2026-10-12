"use client";

import * as React from "react";
import { Crop, Crosshair, FlipHorizontal, FlipVertical, Maximize2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { coverCrop } from "@/lib/editor/doc";
import type { EditorApi } from "../api";
import { ColorField, PanelSection, Segmented } from "../controls";
import { PanelHeader } from "../library/panel-chrome";
import {
  clamp,
  cropPan,
  panCrop,
  recentreCrop,
  setBackground,
  setBase,
  setTransform,
  zoomCrop,
} from "../doc-ops";

const FIT_OPTIONS = [
  { value: "cover" as const, label: "Fill" },
  { value: "contain-blur" as const, label: "Blur bars" },
  { value: "contain-color" as const, label: "Colour bars" },
];

/**
 * The base media: how it fills the canvas, where the crop sits, and — for video
 * — the trim and the original audio.
 */
export function AdjustPanel({ api }: { api: EditorApi }) {
  const { doc, source } = api;
  const base = doc.base;
  const isVideo = base.kind === "video";

  // The un-zoomed cover crop is the reference every zoom level is measured from.
  const fullCrop = React.useMemo(
    () => (source ? coverCrop(source, doc.canvas) : { x: 0, y: 0, w: 1, h: 1 }),
    [source, doc.canvas]
  );
  const zoom = clamp(fullCrop.w / Math.max(base.crop.w, 1e-4), 1, 4);
  const pan = cropPan(doc);
  const panXAvailable = 1 - base.crop.w > 1e-3;
  const panYAvailable = 1 - base.crop.h > 1e-3;
  const duration = source?.durationSeconds ?? null;
  const trim = base.trim;

  return (
    <div className="space-y-6">
      <PanelHeader icon={Crop} title="Adjust & crop" hint="How the source fills the canvas" />

      <PanelSection title="Frame">
        <Segmented
          options={FIT_OPTIONS}
          value={base.fit}
          onChange={(fit) => api.commit(setBase(doc, { fit }))}
        />
        {(base.fit === "contain-color" || doc.canvas.background.type === "color") && (
          <ColorField
            label="Background"
            value={doc.canvas.background.color}
            onChange={(color) =>
              api.commit(setBackground(doc, { type: "color", color: color ?? "#000000" }))
            }
          />
        )}
      </PanelSection>

      {base.fit === "cover" && (
        <PanelSection
          title="Crop"
          action={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => api.commit(recentreCrop(doc, source))}
              title="Recentre the crop on the source"
            >
              <Crosshair />
              Recentre
            </Button>
          }
        >
          {source ? (
            <>
              <Slider
                label="Zoom"
                formatValue={(value) => `${value.toFixed(2)}×`}
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onValueChange={(next) =>
                  api.commit(zoomCrop(doc, fullCrop, next), { coalesce: "crop-zoom" })
                }
              />
              <Slider
                label="Pan X"
                formatValue={(value) => `${Math.round(value * 100)}%`}
                min={0}
                max={1}
                step={0.005}
                value={pan.px}
                disabled={!panXAvailable}
                onValueChange={(next) => api.commit(panCrop(doc, next, pan.py), { coalesce: "crop-pan-x" })}
              />
              <Slider
                label="Pan Y"
                formatValue={(value) => `${Math.round(value * 100)}%`}
                min={0}
                max={1}
                step={0.005}
                value={pan.py}
                disabled={!panYAvailable}
                onValueChange={(next) => api.commit(panCrop(doc, pan.px, next), { coalesce: "crop-pan-y" })}
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Crop controls appear once the source has loaded.
            </p>
          )}
        </PanelSection>
      )}

      <PanelSection title="Transform">
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => api.commit(setTransform(doc, { flipH: !base.transform.flipH }))}
            aria-pressed={base.transform.flipH}
          >
            <FlipHorizontal />
            Flip
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => api.commit(setTransform(doc, { flipV: !base.transform.flipV }))}
            aria-pressed={base.transform.flipV}
          >
            <FlipVertical />
            Flip
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() =>
              api.commit(setTransform(doc, { rotate: (base.transform.rotate + 90) % 360 }))
            }
            title="Rotate 90°"
          >
            <RotateCw />
            90°
          </Button>
        </div>
        <Slider
          label="Scale"
          formatValue={(value) => `${value.toFixed(2)}×`}
          min={0.5}
          max={2}
          step={0.01}
          value={base.transform.scale}
          onValueChange={(next) =>
            api.commit(setTransform(doc, { scale: next }), { coalesce: "base-scale" })
          }
        />
        {(base.transform.rotate !== 0 ||
          base.transform.scale !== 1 ||
          base.transform.flipH ||
          base.transform.flipV) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              api.commit(
                setTransform(doc, { rotate: 0, scale: 1, flipH: false, flipV: false, offsetX: 0, offsetY: 0 })
              )
            }
          >
            <Maximize2 />
            Reset transform
          </Button>
        )}
      </PanelSection>

      {isVideo && (
        <PanelSection title="Clip">
          {duration ? (
            <>
              <Slider
                label="Trim start"
                formatValue={(value) => `${value.toFixed(1)}s`}
                min={0}
                max={duration}
                step={0.1}
                value={trim?.start ?? 0}
                onValueChange={(next) =>
                  api.commit(
                    setBase(doc, {
                      trim: { start: Math.min(next, (trim?.end ?? duration) - 0.1), end: trim?.end ?? duration },
                    }),
                    { coalesce: "trim-start" }
                  )
                }
              />
              <Slider
                label="Trim end"
                formatValue={(value) => `${value.toFixed(1)}s`}
                min={0}
                max={duration}
                step={0.1}
                value={trim?.end ?? duration}
                onValueChange={(next) =>
                  api.commit(
                    setBase(doc, {
                      trim: { start: trim?.start ?? 0, end: Math.max(next, (trim?.start ?? 0) + 0.1) },
                    }),
                    { coalesce: "trim-end" }
                  )
                }
              />
              {trim && (
                <Button variant="ghost" size="xs" onClick={() => api.commit(setBase(doc, { trim: null }))}>
                  Use the whole clip
                </Button>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Trim controls appear once the clip&apos;s duration is known.
            </p>
          )}
        </PanelSection>
      )}

      {/* Music and Templates used to be nested here. Both now have their own
          rail entry: music because it applies to photos too (a photo with a
          track renders as a video), and templates because they are meant to be
          reused constantly and were effectively hidden three levels down. */}
    </div>
  );
}
