import type { Layer } from "@/lib/editor/doc";
import { unitOf } from "@/lib/editor/doc";

/**
 * Text layers store a box (`size.w` + derived `aspect`) like every other layer,
 * so the box has to be measured from the glyphs rather than guessed. Measuring
 * keeps the selection outline tight, keeps `resolveLayerRect` honest, and gives
 * the overlay rasteriser the same box the preview drew.
 *
 * Text is rendered with `white-space: pre` — only explicit newlines break a
 * line — so a measured box is exact rather than an approximation of wrapping.
 */

let ctx: CanvasRenderingContext2D | null | undefined;

function measureContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  if (typeof document === "undefined") {
    ctx = null;
    return ctx;
  }
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

export interface TextBox {
  /** Width in `unit` fractions. */
  w: number;
  /** Height / width of the box. */
  aspect: number;
}

export interface MeasurableText {
  content: string;
  fontFamily: string;
  weight: number;
  /** Font size in `unit` fractions. */
  sizeInUnits: number;
  lineHeight: number;
}

const HORIZONTAL_PADDING = 0.28; // em, matches the preview's px-[0.28em]
const MIN_WIDTH_UNITS = 0.04;

/**
 * Measure a text layer's box. Widths come back in `unit` fractions so the result
 * is resolution independent and survives a ratio change untouched.
 */
export function measureTextBox(text: MeasurableText, canvas: { w: number; h: number }): TextBox {
  const unit = unitOf(canvas);
  const fontPx = Math.max(1, text.sizeInUnits * unit);
  const lines = text.content.length ? text.content.split("\n") : [""];
  const heightPx = lines.length * text.lineHeight * fontPx;

  const c = measureContext();
  let widestPx = 0;
  if (c) {
    c.font = `${text.weight} ${fontPx}px ${text.fontFamily}, sans-serif`;
    for (const line of lines) {
      // A trailing space is trimmed by measureText but is visible in `pre`; the
      // placeholder keeps an empty or space-only line from collapsing to zero.
      widestPx = Math.max(widestPx, c.measureText(line || " ").width);
    }
  } else {
    // Server render / no canvas: 0.55em per character is a reasonable mean for a
    // sans-serif face and is only ever used until the first client measurement.
    for (const line of lines) widestPx = Math.max(widestPx, (line.length || 1) * fontPx * 0.55);
  }

  const widthPx = widestPx + fontPx * HORIZONTAL_PADDING * 2;
  const w = Math.max(MIN_WIDTH_UNITS, widthPx / unit);
  return { w, aspect: heightPx / (w * unit) };
}

/** Re-measure an existing text layer after its content or type scale changed. */
export function remeasureTextLayer(layer: Layer, canvas: { w: number; h: number }): Layer {
  if (layer.type !== "text" || !layer.text) return layer;
  const box = measureTextBox(layer.text, canvas);
  return { ...layer, size: { w: box.w }, aspect: box.aspect };
}
