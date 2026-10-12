"use client";

import * as React from "react";
import { motion, useDragControls, useMotionValue } from "framer-motion";
import type { Layer } from "@/lib/editor/doc";
import { rectToLayerPosition, resolveLayerRect, unitOf } from "@/lib/editor/doc";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";

/** A completed geometry gesture, in document units. */
export interface LayerGeometryChange {
  offset?: { dx: number; dy: number };
  /** Width in `unit` fractions. */
  width?: number;
  rotation?: number;
}

interface LayerViewProps {
  layer: Layer;
  canvas: { w: number; h: number };
  /** Stage pixels per canvas pixel. */
  scale: number;
  selected: boolean;
  /** Resolved preview source for image layers, or null when unavailable. */
  src: string | null;
  /** Outside the layer's video timing window. */
  outOfTime?: boolean;
  onSelect: () => void;
  onGeometry: (change: LayerGeometryChange) => void;
}

const CORNERS = [
  { key: "tl", sx: -1, sy: -1, className: "-top-1 -left-1 cursor-nwse-resize" },
  { key: "tr", sx: 1, sy: -1, className: "-top-1 -right-1 cursor-nesw-resize" },
  { key: "bl", sx: -1, sy: 1, className: "-bottom-1 -left-1 cursor-nesw-resize" },
  { key: "br", sx: 1, sy: 1, className: "-right-1 -bottom-1 cursor-nwse-resize" },
] as const;

const MIN_WIDTH_UNITS = 0.02;
const MAX_WIDTH_UNITS = 4;
const ROTATION_SNAP_DEGREES = 15;

/**
 * Keep pointer events flowing to the handle after the pointer leaves it. Capture
 * can be refused (a pointer the browser no longer considers active), and the
 * gesture's own listeners still work, so a failure must not abort the drag.
 */
function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* non-fatal */
  }
}

/**
 * One layer on the stage: positioned from `resolveLayerRect`, dragged with
 * framer-motion, resized about its own anchor and rotated about its centre.
 *
 * Resize and rotate preview locally (a `factor` on the width and a rotation in
 * degrees) and commit once on pointer-up. Keeping the gesture local means the
 * document — and therefore the undo stack and the autosave timer — sees one
 * change per gesture rather than one per pointer event.
 */
export function LayerView({
  layer,
  canvas,
  scale,
  selected,
  src,
  outOfTime,
  onSelect,
  onGeometry,
}: LayerViewProps) {
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  // Dragging is started by hand from the layer's own surface. framer-motion
  // binds its pointerdown natively on the element, which runs BEFORE React's
  // delegated handlers — so a resize handle inside the box could not cancel it
  // with stopPropagation, and every handle drag moved the layer instead.
  const dragControls = useDragControls();
  const [factor, setFactor] = React.useState(1);
  const [rotationPreview, setRotationPreview] = React.useState<number | null>(null);

  const interactive = !layer.locked;
  const rotation = rotationPreview ?? layer.rotation;

  // The previewed rect: the same geometry engine, fed a scaled width so the
  // anchor stays pinned exactly as it will once committed.
  const rect = React.useMemo(
    () => resolveLayerRect({ ...layer, size: { w: layer.size.w * factor } }, canvas),
    [layer, factor, canvas]
  );

  const box = {
    left: rect.x * scale,
    top: rect.y * scale,
    width: Math.max(1, rect.w * scale),
    height: Math.max(1, rect.h * scale),
  };

  function handleDragEnd(_event: unknown, info: { offset: { x: number; y: number } }) {
    const next = rectToLayerPosition(
      {
        x: rect.x + info.offset.x / scale,
        y: rect.y + info.offset.y / scale,
        w: rect.w,
      },
      layer.anchor,
      canvas,
      layer.aspect
    );
    // Reset the drag transform in the same tick the document moves the box, so
    // the committed `left`/`top` replaces the transform without a visible jump.
    dragX.set(0);
    dragY.set(0);
    onGeometry({ offset: next.offset });
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>, corner: (typeof CORNERS)[number]) {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    capturePointer(handle, event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidthUnits = layer.size.w;
    const startWidthPx = rect.w;
    const unit = unitOf(canvas);
    const radians = (-rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    let latest = 1;

    function onMove(moveEvent: PointerEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      // Project the screen delta onto the layer's own axes so a rotated layer
      // still grows towards the corner the pointer is pulling.
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      const aspect = layer.aspect || 1;
      // Average the two axes so the aspect-locked diagonal tracks the pointer.
      const deltaPx = (corner.sx * localX + (corner.sy * localY) / aspect) / 2 / scale;
      const widthUnits = Math.min(
        MAX_WIDTH_UNITS,
        Math.max(MIN_WIDTH_UNITS, (startWidthPx + deltaPx) / unit)
      );
      latest = widthUnits / startWidthUnits;
      setFactor(latest);
    }

    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setFactor(1);
      if (Math.abs(latest - 1) > 1e-4) {
        onGeometry({ width: startWidthUnits * latest });
      }
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function beginRotate(event: React.PointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    capturePointer(handle, event.pointerId);

    // The axis-aligned bounds of a rotated box still share its centre.
    const bounds = handle.closest("[data-layer-box]")?.getBoundingClientRect();
    if (!bounds) return;
    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;
    let latest = layer.rotation;

    function onMove(moveEvent: PointerEvent) {
      const degrees =
        (Math.atan2(moveEvent.clientY - cy, moveEvent.clientX - cx) * 180) / Math.PI + 90;
      latest = moveEvent.shiftKey
        ? Math.round(degrees / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES
        : Math.round(degrees);
      setRotationPreview(latest);
    }

    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setRotationPreview(null);
      onGeometry({ rotation: latest });
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  return (
    <motion.div
      data-layer-box
      drag={interactive}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      dragElastic={0}
      onDragEnd={handleDragEnd}
      style={{
        x: dragX,
        y: dragY,
        rotate: rotation,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        opacity: outOfTime ? 0.25 : layer.opacity,
        zIndex: layer.z + 1,
      }}
      className={cn(
        "absolute touch-none",
        interactive ? "cursor-grab active:cursor-grabbing" : "cursor-not-allowed"
      )}
    >
      <LayerContent layer={layer} src={src} factor={factor} canvas={canvas} scale={scale} />

      {/* The drag surface sits above the content and below the handles, so a
          handle always wins the hit test where the two overlap. */}
      <div
        className="absolute inset-0"
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
          if (interactive) dragControls.start(event);
        }}
      />

      {selected && (
        <>
          <div className="pointer-events-none absolute -inset-px rounded-[2px] ring-2 ring-primary" />
          {interactive ? (
            <>
              {CORNERS.map((corner) => (
                <div
                  key={corner.key}
                  onPointerDown={(event) => beginResize(event, corner)}
                  className={cn(
                    "absolute h-2.5 w-2.5 touch-none rounded-full border-2 border-primary bg-background shadow-sm",
                    corner.className
                  )}
                />
              ))}
              <div className="pointer-events-none absolute -top-6 left-1/2 h-6 w-px -translate-x-1/2 bg-primary/60" />
              <div
                onPointerDown={beginRotate}
                title="Drag to rotate · hold Shift to snap"
                className="absolute -top-8 left-1/2 h-3.5 w-3.5 -translate-x-1/2 cursor-grab touch-none rounded-full border-2 border-primary bg-background shadow-sm active:cursor-grabbing"
              />
            </>
          ) : (
            <div className="pointer-events-none absolute -top-6 left-0 flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
              <Lock className="h-2.5 w-2.5" />
              Locked
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}

function LayerContent({
  layer,
  src,
  factor,
  canvas,
  scale,
}: {
  layer: Layer;
  src: string | null;
  factor: number;
  canvas: { w: number; h: number };
  scale: number;
}) {
  if (layer.type === "text" && layer.text) {
    const text = layer.text;
    const fontPx = text.sizeInUnits * factor * unitOf(canvas) * scale;
    const justify =
      text.align === "left" ? "flex-start" : text.align === "right" ? "flex-end" : "center";
    return (
      <div
        className="flex h-full w-full items-center overflow-visible"
        style={{
          justifyContent: justify,
          backgroundColor: text.background ?? "transparent",
          borderRadius: text.background ? Math.max(2, fontPx * 0.12) : 0,
        }}
      >
        <span
          style={{
            // `pre` keeps the measured box exact: only explicit newlines break.
            whiteSpace: "pre",
            fontFamily: `${text.fontFamily}, sans-serif`,
            fontSize: fontPx,
            fontWeight: text.weight,
            lineHeight: text.lineHeight,
            color: text.color,
            textAlign: text.align,
            padding: `0 ${fontPx * 0.28}px`,
            textShadow: text.shadow ? `0 ${fontPx * 0.04}px ${fontPx * 0.12}px rgba(0,0,0,0.55)` : "none",
          }}
        >
          {text.content}
        </span>
      </div>
    );
  }

  if (layer.type === "shape") {
    return (
      <div
        className="h-full w-full"
        style={{
          backgroundColor: layer.text?.color ?? "#ffffff",
          borderRadius: Math.max(2, layer.size.w * unitOf(canvas) * scale * 0.04),
        }}
      />
    );
  }

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-white/50 bg-black/30 text-center text-[10px] text-white/70">
        Image unavailable
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="pointer-events-none h-full w-full object-contain select-none"
    />
  );
}
