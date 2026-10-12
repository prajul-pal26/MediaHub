import type { EditDoc, Layer } from "@/lib/editor/doc";
import { coverCrop } from "@/lib/editor/doc";
import { measureTextBox, remeasureTextLayer } from "./text-measure";

/**
 * Pure, immutable transforms over an Edit Document.
 *
 * Every function returns a NEW document — the reducer's history stack holds
 * references to previous documents, so a single in-place mutation would corrupt
 * undo for every entry that shares the mutated object.
 */

export function newLayerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Layers ───────────────────────────────────────────────────────────────────
/** Ascending z — the order layers must be painted in. */
export function paintOrder(doc: EditDoc): Layer[] {
  return [...doc.layers].sort((a, b) => a.z - b.z);
}

/** Descending z — the order a layers list should read in (front first). */
export function stackOrder(doc: EditDoc): Layer[] {
  return [...doc.layers].sort((a, b) => b.z - a.z);
}

export function topZ(doc: EditDoc): number {
  return doc.layers.reduce((max, l) => Math.max(max, l.z), -1);
}

export function findLayer(doc: EditDoc, id: string | null): Layer | null {
  if (!id) return null;
  return doc.layers.find((l) => l.id === id) ?? null;
}

export function addLayer(doc: EditDoc, layer: Omit<Layer, "z"> & { z?: number }): EditDoc {
  const next: Layer = { ...layer, z: layer.z ?? topZ(doc) + 1 } as Layer;
  return { ...doc, layers: [...doc.layers, next] };
}

export function updateLayer(doc: EditDoc, id: string, patch: Partial<Layer>): EditDoc {
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  };
}

/** Patch a text layer's typography and re-measure its box in one step. */
export function updateTextLayer(
  doc: EditDoc,
  id: string,
  patch: Partial<NonNullable<Layer["text"]>>
): EditDoc {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.id !== id || !l.text) return l;
      return remeasureTextLayer({ ...l, text: { ...l.text, ...patch } }, doc.canvas);
    }),
  };
}

export function removeLayer(doc: EditDoc, id: string): EditDoc {
  return { ...doc, layers: doc.layers.filter((l) => l.id !== id) };
}

export function duplicateLayer(doc: EditDoc, id: string): { doc: EditDoc; id: string | null } {
  const source = findLayer(doc, id);
  if (!source) return { doc, id: null };
  const copy: Layer = {
    ...source,
    id: newLayerId(),
    // Nudged so the copy is visibly a second object rather than a perfect overlap.
    offset: { dx: source.offset.dx + 0.04, dy: source.offset.dy + 0.04 },
    z: topZ(doc) + 1,
    locked: false,
  };
  return { doc: { ...doc, layers: [...doc.layers, copy] }, id: copy.id };
}

/** Swap z with the nearest neighbour in that direction. */
export function reorderLayer(doc: EditDoc, id: string, direction: "up" | "down"): EditDoc {
  const layer = findLayer(doc, id);
  if (!layer) return doc;

  const neighbours = doc.layers
    .filter((l) => (direction === "up" ? l.z > layer.z : l.z < layer.z))
    .sort((a, b) => (direction === "up" ? a.z - b.z : b.z - a.z));
  const neighbour = neighbours[0];
  if (!neighbour) return doc;

  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.id === layer.id) return { ...l, z: neighbour.z };
      if (l.id === neighbour.id) return { ...l, z: layer.z };
      return l;
    }),
  };
}

/** Move a layer by a delta in `unit` fractions. */
export function nudgeLayer(doc: EditDoc, id: string, dx: number, dy: number): EditDoc {
  const layer = findLayer(doc, id);
  if (!layer || layer.locked) return doc;
  return updateLayer(doc, id, {
    offset: { dx: layer.offset.dx + dx, dy: layer.offset.dy + dy },
  });
}

// ── Layer factories ──────────────────────────────────────────────────────────
export interface TextPreset {
  key: string;
  label: string;
  sizeInUnits: number;
  weight: number;
  anchor: Layer["anchor"];
  offset: { dx: number; dy: number };
  background: string | null;
}

export const TEXT_PRESETS: TextPreset[] = [
  { key: "headline", label: "Headline", sizeInUnits: 0.11, weight: 800, anchor: "cc", offset: { dx: 0, dy: 0 }, background: null },
  { key: "subtitle", label: "Subtitle", sizeInUnits: 0.055, weight: 600, anchor: "bc", offset: { dx: 0, dy: -0.12 }, background: null },
  { key: "caption", label: "Caption bar", sizeInUnits: 0.042, weight: 600, anchor: "bc", offset: { dx: 0, dy: -0.06 }, background: "#000000" },
];

export function createTextLayer(doc: EditDoc, preset: TextPreset, content = "Your text"): Layer {
  const text = {
    content,
    fontFamily: "Inter",
    sizeInUnits: preset.sizeInUnits,
    color: "#ffffff",
    align: "center" as const,
    weight: preset.weight,
    lineHeight: 1.2,
    background: preset.background,
    shadow: true,
  };
  const box = measureTextBox(text, doc.canvas);
  return {
    id: newLayerId(),
    type: "text",
    anchor: preset.anchor,
    offset: preset.offset,
    size: { w: box.w },
    aspect: box.aspect,
    rotation: 0,
    opacity: 1,
    z: topZ(doc) + 1,
    locked: false,
    text,
    timing: null,
  };
}

export function createStickerLayer(
  doc: EditDoc,
  sticker: { id: string; driveFileId?: string; aspect?: number | null; width?: number | null; height?: number | null }
): Layer {
  const aspect =
    sticker.aspect && sticker.aspect > 0
      ? Number(sticker.aspect)
      : sticker.width && sticker.height
        ? sticker.height / sticker.width
        : 1;
  return {
    id: newLayerId(),
    type: "image",
    anchor: "cc",
    offset: { dx: 0, dy: 0 },
    // A third of the short edge: visible on every ratio without dominating it.
    size: { w: 0.33 },
    aspect,
    rotation: 0,
    opacity: 1,
    z: topZ(doc) + 1,
    locked: false,
    // The id is what the preview and the rasteriser resolve; the Drive id rides
    // along so the server renderer never has to look the sticker up again.
    src: { kind: "sticker", stickerId: sticker.id, driveFileId: sticker.driveFileId },
    timing: null,
  };
}

/**
 * Resize a layer to a new width in `unit` fractions.
 *
 * For a text layer the box is derived from the glyphs, so a resize has to change
 * the type scale and re-measure; writing `size.w` directly would be overwritten
 * by the next measurement.
 */
export function resizeLayer(doc: EditDoc, id: string, width: number): EditDoc {
  const layer = findLayer(doc, id);
  if (!layer) return doc;

  if (layer.type === "text" && layer.text) {
    const factor = width / layer.size.w;
    if (!Number.isFinite(factor) || factor <= 0) return doc;
    return updateTextLayer(doc, id, {
      sizeInUnits: clamp(layer.text.sizeInUnits * factor, 0.012, 0.6),
    });
  }
  return updateLayer(doc, id, { size: { w: width } });
}

// ── Base media ───────────────────────────────────────────────────────────────
export function setBase(doc: EditDoc, patch: Partial<EditDoc["base"]>): EditDoc {
  return { ...doc, base: { ...doc.base, ...patch } };
}

export function setTransform(doc: EditDoc, patch: Partial<EditDoc["base"]["transform"]>): EditDoc {
  return { ...doc, base: { ...doc.base, transform: { ...doc.base.transform, ...patch } } };
}

export function setBackground(doc: EditDoc, patch: Partial<EditDoc["canvas"]["background"]>): EditDoc {
  return { ...doc, canvas: { ...doc.canvas, background: { ...doc.canvas.background, ...patch } } };
}

/** Re-centre the crop so the source fills the canvas with nothing stretched. */
export function recentreCrop(doc: EditDoc, source: { w: number; h: number } | null): EditDoc {
  if (!source || !source.w || !source.h) return setBase(doc, { crop: { x: 0, y: 0, w: 1, h: 1 } });
  return setBase(doc, { crop: coverCrop(source, doc.canvas) });
}

/**
 * Pan the crop window inside the source. `px`/`py` are 0..1 positions of the
 * window within the slack left over by the crop size, so panning can never walk
 * the window off the source.
 */
export function panCrop(doc: EditDoc, px: number, py: number): EditDoc {
  const { w, h } = doc.base.crop;
  return setBase(doc, {
    crop: {
      w,
      h,
      x: clamp(px, 0, 1) * (1 - w),
      y: clamp(py, 0, 1) * (1 - h),
    },
  });
}

/** Inverse of `panCrop` — where the window currently sits in its slack. */
export function cropPan(doc: EditDoc): { px: number; py: number } {
  const { x, y, w, h } = doc.base.crop;
  return {
    px: 1 - w > 1e-6 ? clamp(x / (1 - w), 0, 1) : 0.5,
    py: 1 - h > 1e-6 ? clamp(y / (1 - h), 0, 1) : 0.5,
  };
}

/**
 * Zoom the crop window about its own centre. `zoom` of 1 is the full cover crop;
 * larger values keep less of the source, which reads as moving in closer.
 */
export function zoomCrop(doc: EditDoc, base: EditDoc["base"]["crop"], zoom: number): EditDoc {
  const { px, py } = cropPan(doc);
  const z = clamp(zoom, 1, 4);
  const w = clamp(base.w / z, 0.02, 1);
  const h = clamp(base.h / z, 0.02, 1);
  return setBase(doc, {
    crop: { w, h, x: px * (1 - w), y: py * (1 - h) },
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
