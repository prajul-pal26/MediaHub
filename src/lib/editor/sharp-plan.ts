/**
 * Geometry for the sharp (image) render path.
 *
 * The counterpart to `ffmpeg-plan.ts`: pure, no sharp import, no filesystem, so
 * the maths can be unit-tested without a render. The worker imports this rather
 * than carrying its own copy, so the preview, the image render and the video
 * render all resolve framing from one place.
 */

export type BaseTransform = {
  rotate: number;
  flipH: boolean;
  flipV: boolean;
  scale: number;
  offsetX: number;
  offsetY: number;
};

export interface CoverGeometry {
  /** Source-pixel rect to `sharp.extract()`. Always inside the source. */
  extract: { left: number; top: number; width: number; height: number };
  /**
   * Background margin to `sharp.extend()` after extracting, restoring the part
   * of the requested rect that fell outside the source. Null when the rect sat
   * wholly inside it (the common case).
   */
  extend: { left: number; top: number; right: number; bottom: number } | null;
  /** Set when the framing was clamped — useful for a render note. */
  clamped: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function isIdentityTransform(t: BaseTransform): boolean {
  return (
    t.rotate % 360 === 0 &&
    !t.flipH &&
    !t.flipV &&
    Math.abs(t.scale - 1) < 1e-6 &&
    t.offsetX === 0 &&
    t.offsetY === 0
  );
}

/**
 * The source rectangle whose transformed image fills the canvas, for `fit: cover`.
 *
 * Mirrors `BaseMedia.tsx` exactly, so the render cannot diverge from what the
 * user saw. The preview lays the WHOLE source out in a box of `fullW x fullH`
 * canvas px (`fullW = canvas.w / crop.w`), slides it so the crop window lands
 * on the canvas, then applies `translate(ox,oy) rotate(r) scale(sx,sy)` about
 * the BOX CENTRE (`transformOrigin: center`).
 *
 * Rather than materialise that box — `fullW` is 10x the canvas at a 0.1 crop,
 * and a 10800x13500 RGBA intermediate is 583 MB against the worker's 1536 MB
 * heap — this inverts the affine and reads back the source rect that maps onto
 * the canvas. Flips are folded into the signed scale, so the SIGNED inverse is
 * what yields the correct rect; `flop`/`flip` then reproduce the mirroring.
 *
 * With an identity transform this reduces algebraically to `crop * source`,
 * i.e. the plain extract it replaces. There is a test pinning that.
 *
 * The caller must apply, in this order, to match CSS `rotate(r) scale(sx,sy)`:
 *   extract -> extend -> flop/flip -> rotate(r) -> resize(canvas, fit:"fill")
 * and must stage those through separate sharp invocations, because sharp
 * applies operations in its own fixed internal order, not call order.
 */
export function planCoverGeometry(
  canvasW: number,
  canvasH: number,
  crop: { x: number; y: number; w: number; h: number },
  t: BaseTransform,
  srcW: number,
  srcH: number
): CoverGeometry {
  const cropW = Math.max(crop.w, 1e-6);
  const cropH = Math.max(crop.h, 1e-6);
  const fullW = canvasW / cropW;
  const fullH = canvasH / cropH;
  // Box px per source px. `coverCrop` guarantees fullW/fullH === srcW/srcH, so
  // these agree; both are kept so a hand-edited crop degrades gracefully
  // instead of skewing.
  const kx = fullW / Math.max(srcW, 1);
  const ky = fullH / Math.max(srcH, 1);

  // Offsets are `unit` fractions like every other length in the document.
  const unit = Math.min(canvasW, canvasH);
  const ox = t.offsetX * unit;
  const oy = t.offsetY * unit;
  const sx = t.scale * (t.flipH ? -1 : 1) || 1e-6;
  const sy = t.scale * (t.flipV ? -1 : 1) || 1e-6;

  // Inverse rotation. CSS rotate() is clockwise in a y-down frame.
  const rad = (-t.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const cx = fullW / 2;
  const cy = fullH / 2;
  const x0 = crop.x * fullW;
  const y0 = crop.y * fullH;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [x0, y0],
    [x0 + canvasW, y0],
    [x0, y0 + canvasH],
    [x0 + canvasW, y0 + canvasH],
  ]) {
    const dx = px - cx - ox;
    const dy = py - cy - oy;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const qx = cx + rx / sx;
    const qy = cy + ry / sy;
    if (qx < minX) minX = qx;
    if (qx > maxX) maxX = qx;
    if (qy < minY) minY = qy;
    if (qy > maxY) maxY = qy;
  }

  // Box px -> source px.
  const wantLeft = Math.round(minX / kx);
  const wantTop = Math.round(minY / ky);
  const wantW = Math.max(1, Math.round((maxX - minX) / kx));
  const wantH = Math.max(1, Math.round((maxY - minY) / ky));

  // Intersect with the source. BOTH bounds must be clamped: clamping only the
  // lower one leaves `left > srcW` for a framing that sits off the right edge,
  // and sharp rejects that with "bad extract area" rather than rendering
  // background. Reachable from a template or hand-edited document even though
  // the UI's own scale slider is bounded to 0.5..2.
  const left = clampInt(wantLeft, 0, Math.max(0, srcW - 1));
  const top = clampInt(wantTop, 0, Math.max(0, srcH - 1));
  const width = clampInt(Math.min(wantW, srcW - left), 1, Math.max(1, srcW - left));
  const height = clampInt(Math.min(wantH, srcH - top), 1, Math.max(1, srcH - top));

  // Pads restore the geometry the clamp removed, so the extracted patch still
  // lands in the right place within the canvas.
  //
  // Capped: a document framed far off the source would otherwise request a
  // multi-gigapixel intermediate, and after the final resize to the canvas none
  // of that detail is visible. Four canvases of margin is already far more than
  // any reachable edit needs.
  const padCapX = Math.max(canvasW * 4, width);
  const padCapY = Math.max(canvasH * 4, height);
  const padLeft = Math.min(Math.max(0, left - wantLeft), padCapX);
  const padTop = Math.min(Math.max(0, top - wantTop), padCapY);
  const padRight = Math.min(Math.max(0, wantLeft + wantW - (left + width)), padCapX);
  const padBottom = Math.min(Math.max(0, wantTop + wantH - (top + height)), padCapY);

  const clamped =
    left !== wantLeft || top !== wantTop || width !== wantW || height !== wantH;

  return {
    extract: { left, top, width, height },
    extend:
      padLeft || padTop || padRight || padBottom
        ? { left: padLeft, top: padTop, right: padRight, bottom: padBottom }
        : null,
    clamped,
  };
}
