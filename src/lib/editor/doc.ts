import { z } from "zod";

/**
 * The Edit Document: the single source of truth for an edit.
 *
 * It is rendered twice — once in the browser for preview, once on the server
 * (sharp for images, ffmpeg for video) for the final file. Keeping one
 * serializable document is what makes templates possible: a template is simply
 * this same document with `base.assetId` set to null.
 *
 * Geometry note: lengths are NOT normalised per-axis. A square logo stored as
 * {w: 0.2, h: 0.2} would render 216x384 on a 9:16 canvas — stretched. Instead
 * every 1-D length is a fraction of `unit = min(canvasW, canvasH)` and a layer's
 * height is always derived from its intrinsic aspect. That keeps a watermark the
 * same visual size, and the same visual padding, on every ratio.
 */

// ── Ratios ───────────────────────────────────────────────────────────────────
// rules-engine.getValidActions compares the GCD-reduced "w:h" string EXACTLY
// against a platform's targetRatios, so output dimensions must reduce to one of
// these five strings. 191 is prime: only exact multiples of 191x100 reduce to
// "191:100" (note 1200x627 reduces to 400:209 and would never match).
export const RATIO_PRESETS = {
  "1:1": { w: 1080, h: 1080, label: "Square" },
  "4:5": { w: 1080, h: 1350, label: "Portrait" },
  "9:16": { w: 1080, h: 1920, label: "Story / Reel" },
  "16:9": { w: 1920, h: 1080, label: "Landscape" },
  "191:100": { w: 1146, h: 600, label: "Link / Wide" },
} as const;

export type RatioKey = keyof typeof RATIO_PRESETS;
export const RATIO_KEYS = Object.keys(RATIO_PRESETS) as RatioKey[];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Reduce dimensions the same way the upload route and rules-engine do. */
export function reduceRatio(width: number, height: number): string {
  if (!width || !height) return "";
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

/** Every preset must reduce to its own key, or publishing silently rejects it. */
export function assertPresetsReduceCorrectly(): void {
  for (const key of RATIO_KEYS) {
    const { w, h } = RATIO_PRESETS[key];
    const reduced = reduceRatio(w, h);
    if (reduced !== key) {
      throw new Error(`Ratio preset "${key}" is ${w}x${h} which reduces to "${reduced}"`);
    }
  }
}

// ── Schema ───────────────────────────────────────────────────────────────────
export const ANCHORS = ["tl", "tc", "tr", "cl", "cc", "cr", "bl", "bc", "br"] as const;
export type Anchor = (typeof ANCHORS)[number];

/** Where a layer's own box attaches, as a fraction of its own width/height. */
const ANCHOR_ORIGIN: Record<Anchor, { ax: number; ay: number }> = {
  tl: { ax: 0, ay: 0 }, tc: { ax: 0.5, ay: 0 }, tr: { ax: 1, ay: 0 },
  cl: { ax: 0, ay: 0.5 }, cc: { ax: 0.5, ay: 0.5 }, cr: { ax: 1, ay: 0.5 },
  bl: { ax: 0, ay: 1 }, bc: { ax: 0.5, ay: 1 }, br: { ax: 1, ay: 1 },
};

export const effectSchema = z.object({
  // Only effects expressible as exact per-channel maths are allowed, so sharp
  // and ffmpeg can reproduce the CSS preview. Named filters (sharp.modulate uses
  // LCh, ffmpeg eq is an additive YUV offset, CSS is sRGB slope) do NOT agree.
  type: z.enum(["brightness", "contrast", "saturation", "grayscale", "sepia", "blur"]),
  value: z.number(),
});

export const cropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const layerSchema = z.object({
  id: z.string(),
  type: z.enum(["image", "text", "shape"]),
  anchor: z.enum(ANCHORS).default("cc"),
  /** Offset from the anchor point, in `unit` fractions. */
  offset: z.object({ dx: z.number(), dy: z.number() }).default({ dx: 0, dy: 0 }),
  /** Width in `unit` fractions. Height is always derived via `aspect`. */
  size: z.object({ w: z.number().positive() }),
  /** Intrinsic height / width of the layer's content. */
  aspect: z.number().positive().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  z: z.number().int().default(0),
  locked: z.boolean().default(false),
  src: z
    .object({
      kind: z.enum(["sticker", "upload", "url"]),
      stickerId: z.string().optional(),
      driveFileId: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  text: z
    .object({
      content: z.string(),
      fontFamily: z.string().default("Inter"),
      /** Font size in `unit` fractions — never per-axis. */
      sizeInUnits: z.number().positive().default(0.06),
      color: z.string().default("#ffffff"),
      align: z.enum(["left", "center", "right"]).default("center"),
      weight: z.number().int().default(700),
      lineHeight: z.number().default(1.2),
      background: z.string().nullable().default(null),
      shadow: z.boolean().default(false),
    })
    .optional(),
  /**
   * Video only. `relative` timings are fractions of the clip duration so a
   * template applied to a shorter clip still shows the layer; `absolute` is in
   * seconds and is clamped on apply.
   */
  timing: z
    .object({
      start: z.number().min(0),
      end: z.number().min(0),
      mode: z.enum(["absolute", "relative"]).default("relative"),
    })
    .nullable()
    .default(null),
});

export const editDocSchema = z.object({
  version: z.literal(1).default(1),
  canvas: z.object({
    ratio: z.enum(RATIO_KEYS as [RatioKey, ...RatioKey[]]),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    background: z
      .object({
        type: z.enum(["color", "blur"]).default("color"),
        color: z.string().default("#000000"),
      })
      .default({ type: "color", color: "#000000" }),
  }),
  /** The frame this document was authored in — used to rescale on template apply. */
  refCanvas: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  base: z.object({
    assetId: z.string().nullable(),
    kind: z.enum(["image", "video"]),
    fit: z.enum(["cover", "contain-blur", "contain-color"]).default("cover"),
    /** Normalised to the SOURCE. Discarded and recomputed on template apply. */
    crop: cropSchema.default({ x: 0, y: 0, w: 1, h: 1 }),
    transform: z
      .object({
        rotate: z.number().default(0),
        flipH: z.boolean().default(false),
        flipV: z.boolean().default(false),
        scale: z.number().positive().default(1),
        offsetX: z.number().default(0),
        offsetY: z.number().default(0),
      })
      .default({ rotate: 0, flipH: false, flipV: false, scale: 1, offsetX: 0, offsetY: 0 }),
    /** Float seconds. Source-specific, so never carried into a template. */
    trim: z
      .object({ start: z.number().min(0), end: z.number().min(0) })
      .nullable()
      .default(null),
  }),
  layers: z.array(layerSchema).default([]),
  effects: z.array(effectSchema).default([]),
  audio: z
    .object({
      trackId: z.string().nullable().default(null),
      volume: z.number().min(0).max(2).default(1),
      muteOriginal: z.boolean().default(false),
      startOffset: z.number().min(0).default(0),
      fadeIn: z.number().min(0).default(0),
      fadeOut: z.number().min(0).default(0),
      loop: z.boolean().default(true),
    })
    .default({
      trackId: null, volume: 1, muteOriginal: false,
      startOffset: 0, fadeIn: 0, fadeOut: 0, loop: true,
    }),
  /** Drive id of the browser-rasterised overlay stack (all layers, one PNG). */
  overlayDriveFileId: z.string().nullable().default(null),
});

export type EditDoc = z.infer<typeof editDocSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Effect = z.infer<typeof effectSchema>;

// ── Geometry ─────────────────────────────────────────────────────────────────
/** The scalar every 1-D length is expressed against. */
export function unitOf(canvas: { w: number; h: number }): number {
  return Math.min(canvas.w, canvas.h);
}

export interface LayerRect {
  x: number; y: number; w: number; h: number; rotation: number; opacity: number;
}

/**
 * Resolve a layer to a pixel rect on a canvas. Used identically by the browser
 * preview and the overlay rasteriser, so what you see is what is rendered.
 */
export function resolveLayerRect(layer: Layer, canvas: { w: number; h: number }): LayerRect {
  const unit = unitOf(canvas);
  const w = layer.size.w * unit;
  const h = w * layer.aspect;

  const anchorPoint = {
    tl: { x: 0, y: 0 }, tc: { x: canvas.w / 2, y: 0 }, tr: { x: canvas.w, y: 0 },
    cl: { x: 0, y: canvas.h / 2 }, cc: { x: canvas.w / 2, y: canvas.h / 2 }, cr: { x: canvas.w, y: canvas.h / 2 },
    bl: { x: 0, y: canvas.h }, bc: { x: canvas.w / 2, y: canvas.h }, br: { x: canvas.w, y: canvas.h },
  }[layer.anchor];

  const { ax, ay } = ANCHOR_ORIGIN[layer.anchor];

  return {
    x: anchorPoint.x + layer.offset.dx * unit - w * ax,
    y: anchorPoint.y + layer.offset.dy * unit - h * ay,
    w,
    h,
    rotation: layer.rotation,
    opacity: layer.opacity,
  };
}

/** Inverse of resolveLayerRect — converts a dragged pixel rect back to the doc. */
export function rectToLayerPosition(
  rect: { x: number; y: number; w: number },
  anchor: Anchor,
  canvas: { w: number; h: number },
  aspect: number
): { offset: { dx: number; dy: number }; size: { w: number } } {
  const unit = unitOf(canvas);
  const h = rect.w * aspect;
  const anchorPoint = {
    tl: { x: 0, y: 0 }, tc: { x: canvas.w / 2, y: 0 }, tr: { x: canvas.w, y: 0 },
    cl: { x: 0, y: canvas.h / 2 }, cc: { x: canvas.w / 2, y: canvas.h / 2 }, cr: { x: canvas.w, y: canvas.h / 2 },
    bl: { x: 0, y: canvas.h }, bc: { x: canvas.w / 2, y: canvas.h }, br: { x: canvas.w, y: canvas.h },
  }[anchor];
  const { ax, ay } = ANCHOR_ORIGIN[anchor];

  return {
    offset: {
      dx: (rect.x + rect.w * ax - anchorPoint.x) / unit,
      dy: (rect.y + h * ay - anchorPoint.y) / unit,
    },
    size: { w: rect.w / unit },
  };
}

/** Centre-crop rect that fills `canvas` from a source of the given dimensions. */
export function coverCrop(
  source: { w: number; h: number },
  canvas: { w: number; h: number }
): z.infer<typeof cropSchema> {
  if (!source.w || !source.h || !canvas.w || !canvas.h) return { x: 0, y: 0, w: 1, h: 1 };
  const sourceAspect = source.w / source.h;
  const canvasAspect = canvas.w / canvas.h;

  if (sourceAspect > canvasAspect) {
    // Source is wider: keep full height, trim the sides.
    const w = canvasAspect / sourceAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  // Source is taller: keep full width, trim top/bottom.
  const h = sourceAspect / canvasAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

// ── Documents ────────────────────────────────────────────────────────────────
export function createEmptyDoc(params: {
  ratio: RatioKey;
  kind: "image" | "video";
  assetId: string | null;
  source?: { w: number; h: number };
}): EditDoc {
  const preset = RATIO_PRESETS[params.ratio];
  const canvas = { w: preset.w, h: preset.h };
  return editDocSchema.parse({
    version: 1,
    canvas: { ratio: params.ratio, w: preset.w, h: preset.h },
    refCanvas: canvas,
    base: {
      assetId: params.assetId,
      kind: params.kind,
      crop: params.source ? coverCrop(params.source, canvas) : { x: 0, y: 0, w: 1, h: 1 },
    },
  });
}

/** Strip the source so a document can be reused as a template. */
export function toTemplate(doc: EditDoc): EditDoc {
  return editDocSchema.parse({
    ...doc,
    base: { ...doc.base, assetId: null, crop: { x: 0, y: 0, w: 1, h: 1 }, trim: null },
    overlayDriveFileId: null,
  });
}

/**
 * Apply a template to a new source.
 *
 * "Everything changes accordingly" cannot mean pixel-identical — it means the
 * same intent re-solved for the new frame. Concretely: the crop is recomputed
 * from the fit policy (a stored crop refers to the OLD source and would cut the
 * wrong region), lengths rescale through `unit`, anchors keep watermarks pinned
 * to their corner, relative timings re-expand to the new duration, and the trim
 * is dropped because it belongs to the old clip.
 */
export function applyTemplate(
  template: EditDoc,
  target: {
    /**
     * Null for media uploaded straight into the Editor: it has no
     * `media_assets` row, so the preview resolves its bytes from the draft id
     * instead. `base.assetId` has always been nullable in the schema (that is
     * how a template stores "no source"), so this only widens the parameter to
     * match.
     */
    assetId: string | null;
    kind: "image" | "video";
    source?: { w: number; h: number };
    durationSeconds?: number | null;
  },
  ratio?: RatioKey
): EditDoc {
  const ratioKey = ratio ?? template.canvas.ratio;
  const preset = RATIO_PRESETS[ratioKey];
  const canvas = { w: preset.w, h: preset.h };

  const duration = target.durationSeconds ?? null;

  const layers = template.layers.map((layer) => {
    if (!layer.timing) return layer;
    if (layer.timing.mode === "relative") {
      // Fractions of the clip — already resolution/duration independent.
      return layer;
    }
    if (duration == null) return { ...layer, timing: null };
    // Absolute seconds against a different clip: clamp so the layer still shows.
    return {
      ...layer,
      timing: {
        ...layer.timing,
        start: Math.min(layer.timing.start, duration),
        end: Math.min(layer.timing.end, duration),
      },
    };
  });

  return editDocSchema.parse({
    ...template,
    canvas: { ...template.canvas, ratio: ratioKey, w: preset.w, h: preset.h },
    refCanvas: canvas,
    base: {
      ...template.base,
      assetId: target.assetId,
      kind: target.kind,
      crop: target.source ? coverCrop(target.source, canvas) : { x: 0, y: 0, w: 1, h: 1 },
      trim: null,
    },
    layers,
    audio: {
      ...template.audio,
      // A fade that starts past the end of a shorter clip would never fire.
      fadeOut: duration != null ? Math.min(template.audio.fadeOut, duration) : template.audio.fadeOut,
    },
    overlayDriveFileId: null,
  });
}

/** Re-solve a document for a different output ratio. */
export function changeRatio(doc: EditDoc, ratio: RatioKey, source?: { w: number; h: number }): EditDoc {
  const preset = RATIO_PRESETS[ratio];
  const canvas = { w: preset.w, h: preset.h };
  return editDocSchema.parse({
    ...doc,
    canvas: { ...doc.canvas, ratio, w: preset.w, h: preset.h },
    refCanvas: canvas,
    base: {
      ...doc.base,
      crop: source ? coverCrop(source, canvas) : doc.base.crop,
    },
    overlayDriveFileId: null,
  });
}

/** CSS filter string for preview. The server mirrors these with exact matrices. */
export function effectsToCss(effects: Effect[]): string {
  if (!effects.length) return "none";
  return effects
    .map((e) => {
      switch (e.type) {
        case "brightness": return `brightness(${e.value})`;
        case "contrast": return `contrast(${e.value})`;
        case "saturation": return `saturate(${e.value})`;
        case "grayscale": return `grayscale(${e.value})`;
        case "sepia": return `sepia(${e.value})`;
        case "blur": return `blur(${e.value}px)`;
        default: return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}
