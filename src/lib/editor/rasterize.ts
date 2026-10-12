import { resolveLayerRect, unitOf, type EditDoc, type Layer } from "./doc";

/**
 * Browser-side overlay rasteriser — the keystone of the render architecture.
 *
 * Server-side text rendering can never match the browser. The Alpine images
 * ship only `ttf-freefont` + `font-noto-emoji`; sharp composites text through
 * Pango (different shaper, different metrics, different fallback chain) and
 * ffmpeg's `drawtext` has no word wrap at all. Any attempt to re-render the
 * overlay server-side produces a different image than the one the user
 * approved.
 *
 * So the overlay is rendered exactly once, here, in the same engine that drew
 * the preview, at full output resolution, into one transparent PNG. The server
 * then only does exact maths that cannot disagree:
 *
 *   sharp:  .composite([{ input: png, top: 0, left: 0 }])
 *   ffmpeg: overlay=0:0
 *
 * Preview and final render are identical *by construction* rather than by two
 * implementations happening to agree.
 *
 * This module touches DOM APIs, so it is client-only — but importing it on the
 * server is safe. Every DOM access sits inside a function behind `assertDom()`.
 *
 * ── The box model (mirror this in the preview) ──────────────────────────────
 * `resolveLayerRect` gives the layer's pixel rect. Within it:
 *   - Rotation is about the rect **centre**; op order is scale -> rotate -> translate.
 *   - Text wraps to `rect.w` and the wrapped block is centred **vertically**
 *     in `rect.h`; horizontal placement follows `text.align`.
 *   - A text `background` is a rounded box around the wrapped block, padded
 *     0.32em horizontally and 0.18em vertically.
 *   - Shapes are rounded rects filling the whole rect.
 */

// ── Tunables (shared with the preview so both can reference one number) ──────
export const TEXT_BG_PAD_X_EM = 0.32;
export const TEXT_BG_PAD_Y_EM = 0.18;
/** Corner radius of a text background box, as a fraction of the font size. */
export const TEXT_BG_RADIUS_EM = 0.25;
/** Corner radius of a shape layer, as a fraction of its shorter side. */
export const SHAPE_RADIUS_FRACTION = 0.08;
const SHADOW_BLUR_EM = 0.18;
const SHADOW_OFFSET_EM = 0.06;
const SHADOW_COLOR = "rgba(0,0,0,0.55)";
const DEFAULT_SHAPE_FILL = "#ffffff";
const DEFAULT_IMAGE_TIMEOUT_MS = 15_000;

export interface RasterizeOptions {
  /**
   * Video only. When set, layers whose `timing` window excludes this time are
   * skipped, so the video path can rasterise one PNG per segment. A single
   * still overlay cannot express a layer that appears part-way through a clip.
   *
   * `relative` timings are fractions of the clip, so `durationSeconds` is
   * required to resolve them.
   */
  atTime?: number;
  durationSeconds?: number | null;
  /** How long to wait for one image layer before failing. */
  imageTimeoutMs?: number;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * The 2D APIs used here are identical across both context types, so one cast
 * keeps the call sites free of union-narrowing noise.
 */
type Ctx = CanvasRenderingContext2D;

function assertDom(): void {
  if (typeof globalThis === "undefined" || typeof document === "undefined") {
    throw new Error(
      "rasterizeOverlays is client-only: the overlay PNG must be produced by the " +
        "same engine that drew the preview. Call it from a browser component."
    );
  }
}

function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function getContext(canvas: AnyCanvas): Ctx {
  const ctx = canvas.getContext("2d", { alpha: true }) as Ctx | null;
  if (!ctx) throw new Error("Could not acquire a 2D canvas context for the overlay");
  return ctx;
}

function toBlob(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null for the overlay PNG"));
    }, "image/png");
  });
}

// ── Layer selection ──────────────────────────────────────────────────────────
/** Resolve a layer's timing window to absolute seconds, or null if untimed. */
function timingWindow(
  layer: Layer,
  durationSeconds: number | null | undefined
): { start: number; end: number } | null {
  if (!layer.timing) return null;
  if (layer.timing.mode === "absolute") {
    return { start: layer.timing.start, end: layer.timing.end };
  }
  if (durationSeconds == null) return null;
  return {
    start: layer.timing.start * durationSeconds,
    end: layer.timing.end * durationSeconds,
  };
}

function isVisibleAt(layer: Layer, options: RasterizeOptions): boolean {
  if (options.atTime == null) return true;
  const window = timingWindow(layer, options.durationSeconds);
  if (!window) return true;
  return options.atTime >= window.start && options.atTime <= window.end;
}

/**
 * The layers to draw, in paint order. `Array.prototype.sort` is specified as
 * stable, so equal `z` keeps document order and the output is deterministic.
 */
export function orderedLayers(doc: EditDoc, options: RasterizeOptions = {}): Layer[] {
  return doc.layers
    .filter((layer) => layer.opacity > 0 && isVisibleAt(layer, options))
    .slice()
    .sort((a, b) => a.z - b.z);
}

// ── Image loading ────────────────────────────────────────────────────────────
type Drawable = CanvasImageSource & { width: number; height: number };

async function loadImage(url: string, timeoutMs: number): Promise<Drawable> {
  // `Image` is unavailable in a worker; `createImageBitmap` covers that case.
  if (typeof Image === "undefined") {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`Overlay image ${url} failed: HTTP ${response.status}`);
    return (await createImageBitmap(await response.blob())) as Drawable;
  }

  return new Promise<Drawable>((resolve, reject) => {
    const img = new Image();
    // Without this the canvas is tainted and convertToBlob/toBlob throws.
    img.crossOrigin = "anonymous";
    img.decoding = "sync";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Overlay image timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    }

    img.onload = () => {
      // decode() resolves once the bitmap is ready, so drawImage never
      // silently paints nothing.
      const done = () => {
        cleanup();
        resolve(img as unknown as Drawable);
      };
      if (typeof img.decode === "function") {
        img.decode().then(done, done);
      } else {
        done();
      }
    };
    img.onerror = () => {
      cleanup();
      // Thrown, never swallowed: a dropped layer would make the saved PNG
      // disagree with the preview the user approved, which is the exact
      // failure this module exists to prevent.
      reject(new Error(`Overlay image failed to load: ${url}`));
    };
    img.src = url;
  });
}

// ── Text layout ──────────────────────────────────────────────────────────────
export function fontStringFor(layer: Layer, canvas: { w: number; h: number }): string {
  const text = layer.text;
  const weight = text?.weight ?? 700;
  const sizePx = (text?.sizeInUnits ?? 0.06) * unitOf(canvas);
  const family = text?.fontFamily ?? "Inter";
  return `${weight} ${sizePx}px "${family}", sans-serif`;
}

/**
 * Greedy word wrap against a pixel width. Explicit newlines are honoured, and a
 * single word wider than the box is hard-broken so nothing overflows the rect.
 */
export function wrapText(ctx: Ctx, content: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of content.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }

      // The word alone still does not fit: break it by character.
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && ctx.measureText(current.slice(0, cut)).width > maxWidth) cut--;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

async function ensureFontLoaded(font: string): Promise<void> {
  // Measuring before the face is ready yields fallback metrics, so the saved
  // PNG would wrap differently than the preview.
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    await fonts.load(font);
    await fonts.ready;
  } catch {
    // A font that cannot be loaded falls back to sans-serif in both the
    // preview and here, so the two still agree.
  }
}

// ── Painting ─────────────────────────────────────────────────────────────────
function tracePath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/**
 * Enter a layer's local frame: the origin becomes the rect centre, already
 * rotated, with the layer's opacity applied. Children draw around (0, 0).
 */
function withLayerTransform(
  ctx: Ctx,
  rect: { x: number; y: number; w: number; h: number; rotation: number; opacity: number },
  draw: () => void
): void {
  ctx.save();
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  if (rect.rotation) ctx.rotate((rect.rotation * Math.PI) / 180);
  ctx.globalAlpha = rect.opacity;
  draw();
  ctx.restore();
}

function drawTextLayer(ctx: Ctx, layer: Layer, doc: EditDoc): void {
  const text = layer.text;
  if (!text || !text.content) return;

  const rect = resolveLayerRect(layer, doc.canvas);
  const font = fontStringFor(layer, doc.canvas);
  const sizePx = text.sizeInUnits * unitOf(doc.canvas);
  const lineHeightPx = sizePx * text.lineHeight;

  ctx.font = font;
  const lines = wrapText(ctx, text.content, rect.w);
  const blockHeight = lines.length * lineHeightPx;

  withLayerTransform(ctx, rect, () => {
    // Re-assert the font: ctx.save()/restore() preserves it, but the measuring
    // pass above ran outside this frame.
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = text.align;

    const halfW = rect.w / 2;
    const x = text.align === "left" ? -halfW : text.align === "right" ? halfW : 0;
    const firstLineCentre = -blockHeight / 2 + lineHeightPx / 2;

    if (text.background) {
      const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
      const padX = sizePx * TEXT_BG_PAD_X_EM;
      const padY = sizePx * TEXT_BG_PAD_Y_EM;
      const boxW = widest + padX * 2;
      const boxH = blockHeight + padY * 2;
      const boxX =
        text.align === "left" ? -halfW - padX : text.align === "right" ? halfW - boxW + padX : -boxW / 2;

      ctx.save();
      ctx.fillStyle = text.background;
      tracePath(ctx, boxX, -boxH / 2, boxW, boxH, sizePx * TEXT_BG_RADIUS_EM);
      ctx.fill();
      ctx.restore();
    }

    if (text.shadow) {
      ctx.shadowColor = SHADOW_COLOR;
      ctx.shadowBlur = sizePx * SHADOW_BLUR_EM;
      ctx.shadowOffsetY = sizePx * SHADOW_OFFSET_EM;
    }

    ctx.fillStyle = text.color;
    lines.forEach((line, i) => {
      if (line) ctx.fillText(line, x, firstLineCentre + i * lineHeightPx);
    });
  });
}

function drawShapeLayer(ctx: Ctx, layer: Layer, doc: EditDoc): void {
  const rect = resolveLayerRect(layer, doc.canvas);
  // The schema carries no dedicated shape fill, so a shape reuses the `text`
  // block's colours: `background` first, then `color`.
  const fill = layer.text?.background ?? layer.text?.color ?? DEFAULT_SHAPE_FILL;

  withLayerTransform(ctx, rect, () => {
    ctx.fillStyle = fill;
    tracePath(
      ctx,
      -rect.w / 2,
      -rect.h / 2,
      rect.w,
      rect.h,
      Math.min(rect.w, rect.h) * SHAPE_RADIUS_FRACTION
    );
    ctx.fill();
  });
}

function drawImageLayer(ctx: Ctx, layer: Layer, doc: EditDoc, image: Drawable): void {
  const rect = resolveLayerRect(layer, doc.canvas);
  withLayerTransform(ctx, rect, () => {
    ctx.drawImage(image, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Composite every overlay layer into one transparent PNG at full output
 * resolution. Returns `null` when the document has no layers to draw, so the
 * caller can skip the upload and the server-side composite entirely.
 *
 * Never mutates `doc`. Deterministic for a given document and set of sources.
 *
 * Throws if a layer's image cannot be loaded or decoded — see `loadImage`.
 */
export async function rasterizeOverlays(
  doc: EditDoc,
  resolveSrc: (layer: Layer) => string,
  options: RasterizeOptions = {}
): Promise<Blob | null> {
  assertDom();

  const layers = orderedLayers(doc, options);
  if (layers.length === 0) return null;

  const timeoutMs = options.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;

  // Load every bitmap and font up front: the paint pass must be synchronous so
  // nothing can interleave and change the compositing order.
  const images = new Map<string, Drawable>();
  await Promise.all(
    layers
      .filter((layer) => layer.type === "image")
      .map(async (layer) => {
        const url = resolveSrc(layer);
        if (!url || images.has(layer.id)) return;
        images.set(layer.id, await loadImage(url, timeoutMs));
      })
  );
  await Promise.all(
    layers
      .filter((layer) => layer.type === "text" && layer.text?.content)
      .map((layer) => ensureFontLoaded(fontStringFor(layer, doc.canvas)))
  );

  const canvas = createCanvas(doc.canvas.w, doc.canvas.h);
  const ctx = getContext(canvas);
  // Start fully transparent: the base image is composited underneath on the
  // server, so any opaque pixel here would hide it.
  ctx.clearRect(0, 0, doc.canvas.w, doc.canvas.h);

  for (const layer of layers) {
    switch (layer.type) {
      case "image": {
        const image = images.get(layer.id);
        if (image) drawImageLayer(ctx, layer, doc, image);
        break;
      }
      case "text":
        drawTextLayer(ctx, layer, doc);
        break;
      case "shape":
        drawShapeLayer(ctx, layer, doc);
        break;
      default:
        break;
    }
  }

  return toBlob(canvas);
}

/** Same composite as a data URL — handy for draft thumbnails. */
export async function rasterizeToDataUrl(
  doc: EditDoc,
  resolveSrc: (layer: Layer) => string,
  options: RasterizeOptions = {}
): Promise<string | null> {
  const blob = await rasterizeOverlays(doc, resolveSrc, options);
  if (!blob) return null;

  // OffscreenCanvas has no toDataURL, so go through the blob either way.
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not encode the overlay data URL"));
    reader.readAsDataURL(blob);
  });
}
