import { effectsToCss, type Effect } from "./doc";

/**
 * One catalog, three renderers.
 *
 * The same effect has to look the same in the CSS preview, in sharp, and in
 * ffmpeg. Named filters do NOT agree across those engines:
 *
 *   - CSS `brightness()` is a slope on sRGB values.
 *   - `sharp.modulate({brightness})` multiplies **LCh lightness**, not sRGB.
 *   - ffmpeg `eq=brightness` is an **additive YUV offset**, not a multiply.
 *
 * So nothing here calls a named filter. Every effect is reduced to one of two
 * exact primitives by `effectToOp` below — a per-channel linear ramp
 * (`out = a*in + b`) or a 3x3 colour matrix — and each renderer is only a
 * different spelling of that same op. They cannot drift because they all read
 * the same function.
 *
 * Blur is the one exception: it is a convolution, not a point operation, so it
 * stays a separate radius that each engine applies with its own Gaussian.
 */

// ── Catalog ──────────────────────────────────────────────────────────────────
export type EffectType = Effect["type"];

export interface EffectSpec {
  key: EffectType;
  label: string;
  /** lucide-react icon name, resolved by the UI so this module stays DOM-free. */
  icon?: string;
  min: number;
  max: number;
  step: number;
  /** The value at which the effect is a no-op. */
  default: number;
  /** Suffix for the UI readout. Values are multipliers unless stated. */
  unit?: string;
}

export const EFFECT_CATALOG: Record<EffectType, EffectSpec> = {
  brightness: { key: "brightness", label: "Brightness", icon: "Sun", min: 0.5, max: 1.5, step: 0.01, default: 1, unit: "x" },
  contrast: { key: "contrast", label: "Contrast", icon: "Contrast", min: 0.5, max: 1.5, step: 0.01, default: 1, unit: "x" },
  saturation: { key: "saturation", label: "Saturation", icon: "Droplet", min: 0, max: 2, step: 0.01, default: 1, unit: "x" },
  grayscale: { key: "grayscale", label: "Grayscale", icon: "CircleOff", min: 0, max: 1, step: 0.01, default: 0, unit: "" },
  sepia: { key: "sepia", label: "Sepia", icon: "Coffee", min: 0, max: 1, step: 0.01, default: 0, unit: "" },
  blur: { key: "blur", label: "Blur", icon: "Aperture", min: 0, max: 20, step: 0.5, default: 0, unit: "px" },
};

export const EFFECT_TYPES = Object.keys(EFFECT_CATALOG) as EffectType[];

/** The value at which an effect does nothing. */
export function defaultValueOf(type: EffectType): number {
  return EFFECT_CATALOG[type].default;
}

/** Clamp a raw UI value into the catalog's declared range. */
export function clampEffectValue(type: EffectType, value: number): number {
  const spec = EFFECT_CATALOG[type];
  if (!Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, value));
}

// ── The shared primitive ─────────────────────────────────────────────────────
export type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

/** sRGB luma coefficients (Rec. 709) — the ones CSS filters are defined with. */
export const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

export const IDENTITY_MATRIX: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Full-strength grayscale. Every row is the luma vector, so each output channel
 * is the same luminance — this is exactly what CSS `grayscale(1)` computes.
 */
export const GRAYSCALE_MATRIX: Matrix3 = [
  [LUMA.r, LUMA.g, LUMA.b],
  [LUMA.r, LUMA.g, LUMA.b],
  [LUMA.r, LUMA.g, LUMA.b],
];

/** The canonical sepia matrix from the Filter Effects spec. */
export const SEPIA_MATRIX: Matrix3 = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
];

/**
 * Luminance-preserving saturation. `s = 1` is the identity and `s = 0` collapses
 * to GRAYSCALE_MATRIX, which is why saturation and grayscale agree at their
 * extremes instead of being two unrelated filters.
 */
export function saturationMatrix(s: number): Matrix3 {
  const { r, g, b } = LUMA;
  return [
    [r + (1 - r) * s, g * (1 - s), b * (1 - s)],
    [r * (1 - s), g + (1 - g) * s, b * (1 - s)],
    [r * (1 - s), g * (1 - s), b + (1 - b) * s],
  ];
}

/** Linear interpolation between the identity and a target matrix. */
export function lerpMatrix(target: Matrix3, amount: number): Matrix3 {
  const t = Math.min(1, Math.max(0, amount));
  return IDENTITY_MATRIX.map((row, i) =>
    row.map((identityValue, j) => identityValue * (1 - t) + target[i][j] * t)
  ) as Matrix3;
}

export function multiplyMatrix(a: Matrix3, b: Matrix3): Matrix3 {
  const out: number[][] = [];
  for (let i = 0; i < 3; i++) {
    out.push([0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
  }
  return out as Matrix3;
}

export function matrixIsIdentity(m: Matrix3, epsilon = 1e-9): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs(m[i][j] - IDENTITY_MATRIX[i][j]) > epsilon) return false;
    }
  }
  return true;
}

/**
 * The single reduction every renderer reads.
 *
 * `linear` is in **0-255 space** (`out = a*in + b`) because that is the space
 * sharp's `.linear()` works in; `matrix` is in 0-1 space, where colour matrices
 * are defined. `blur` is a Gaussian sigma/radius in output pixels.
 */
export type EffectOp =
  | { kind: "none" }
  | { kind: "linear"; a: number; b: number }
  | { kind: "matrix"; matrix: Matrix3 }
  | { kind: "blur"; radius: number };

export function effectToOp(effect: Effect): EffectOp {
  const spec = EFFECT_CATALOG[effect.type];
  if (!spec) return { kind: "none" };
  const value = Number.isFinite(effect.value) ? effect.value : spec.default;
  if (value === spec.default) return { kind: "none" };

  switch (effect.type) {
    case "brightness":
      // A pure slope through black: identical to CSS brightness().
      return { kind: "linear", a: value, b: 0 };
    case "contrast":
      // Scale about the 0-255 midpoint so that midpoint maps to itself.
      // The midpoint is 127.5, not 128: CSS defines contrast as
      // `slope = v, intercept = 0.5 - 0.5*v` in 0-1 space, which is
      // `b = 255 * (0.5 - 0.5*v) = 127.5 * (1 - v)` in 0-255 space. Using 128
      // would shift every pixel by half a level away from the CSS preview.
      return { kind: "linear", a: value, b: 127.5 * (1 - value) };
    case "saturation":
      return { kind: "matrix", matrix: saturationMatrix(value) };
    case "grayscale":
      return { kind: "matrix", matrix: lerpMatrix(GRAYSCALE_MATRIX, value) };
    case "sepia":
      return { kind: "matrix", matrix: lerpMatrix(SEPIA_MATRIX, value) };
    case "blur":
      return { kind: "blur", radius: value };
    default:
      return { kind: "none" };
  }
}

/** True when the effect sits at its catalog default and can be skipped. */
export function isIdentityEffect(effect: Effect): boolean {
  return effectToOp(effect).kind === "none";
}

// ── Renderer 1: CSS (browser preview) ────────────────────────────────────────
/**
 * Re-exported from `doc.ts` rather than reimplemented — the preview and the
 * document must agree on one string.
 */
export { effectsToCss };

// ── Renderer 2: sharp (server, images) ───────────────────────────────────────
export interface SharpEffectPlan {
  /** `sharp.linear(a, b)` — 0-255 space. */
  linear?: { a: number; b: number };
  /** `sharp.recomb(matrix)` — a 3x3 colour matrix. */
  recomb?: number[][];
  /** `sharp.blur(sigma)`. */
  blur?: number;
}

/**
 * Collapse the stack into one serialisable plan the worker can apply.
 *
 * Multiple linear ramps compose into a single `a`/`b` pair and multiple
 * matrices into a single matrix product, so a long effect stack still costs one
 * `.linear()` and one `.recomb()`.
 */
export function effectsToSharp(effects: Effect[]): SharpEffectPlan {
  let a = 1;
  let b = 0;
  let matrix = IDENTITY_MATRIX;
  let blur = 0;

  for (const effect of effects) {
    const op = effectToOp(effect);
    switch (op.kind) {
      case "linear":
        // Composing out = a2*(a1*x + b1) + b2.
        a = op.a * a;
        b = op.a * b + op.b;
        break;
      case "matrix":
        matrix = multiplyMatrix(op.matrix, matrix);
        break;
      case "blur":
        // Gaussians add in quadrature; this keeps two 3px blurs from reading as 6px.
        blur = Math.sqrt(blur * blur + op.radius * op.radius);
        break;
      default:
        break;
    }
  }

  const plan: SharpEffectPlan = {};
  if (a !== 1 || b !== 0) plan.linear = { a, b };
  if (!matrixIsIdentity(matrix)) plan.recomb = matrix.map((row) => [...row]);
  if (blur > 0) plan.blur = blur;
  return plan;
}

// ── Renderer 3: ffmpeg (server, video) ───────────────────────────────────────
function fmt(n: number): string {
  // Fixed precision keeps the filtergraph deterministic and free of
  // exponent notation, which ffmpeg's parser rejects.
  const rounded = Number(n.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * ffmpeg filter strings, one per non-identity effect.
 *
 * `colorchannelmixer` is a 4x4 affine mixer, so it expresses BOTH primitives:
 * the matrix effects directly, and the linear ramp as a scaled diagonal with
 * the offset in the alpha-origin column (`aa` is left at 1 so alpha survives).
 * Using one filter for both is what keeps the video path matching the image
 * path — `eq=` is deliberately never emitted because its brightness is an
 * additive YUV offset and would not match.
 */
export function effectsToFfmpegFilters(effects: Effect[]): string[] {
  const filters: string[] = [];

  for (const effect of effects) {
    const op = effectToOp(effect);
    switch (op.kind) {
      case "linear": {
        // colorchannelmixer offsets are in 0-1 space; `b` is in 0-255.
        const offset = op.b / 255;
        filters.push(
          `colorchannelmixer=rr=${fmt(op.a)}:rg=0:rb=0:ra=${fmt(offset)}:` +
            `gr=0:gg=${fmt(op.a)}:gb=0:ga=${fmt(offset)}:` +
            `br=0:bg=0:bb=${fmt(op.a)}:ba=${fmt(offset)}:` +
            `ar=0:ag=0:ab=0:aa=1`
        );
        break;
      }
      case "matrix": {
        const m = op.matrix;
        filters.push(
          `colorchannelmixer=rr=${fmt(m[0][0])}:rg=${fmt(m[0][1])}:rb=${fmt(m[0][2])}:ra=0:` +
            `gr=${fmt(m[1][0])}:gg=${fmt(m[1][1])}:gb=${fmt(m[1][2])}:ga=0:` +
            `br=${fmt(m[2][0])}:bg=${fmt(m[2][1])}:bb=${fmt(m[2][2])}:ba=0:` +
            `ar=0:ag=0:ab=0:aa=1`
        );
        break;
      }
      case "blur":
        filters.push(`gblur=sigma=${fmt(op.radius)}`);
        break;
      default:
        break;
    }
  }

  return filters;
}

/** Convenience for callers that want one `-vf` argument. */
export function effectsToFfmpegFilterString(effects: Effect[]): string {
  return effectsToFfmpegFilters(effects).join(",");
}

// ── Shared helper for verification ───────────────────────────────────────────
/**
 * Apply the resolved plan to one sRGB triple in 0-255 space. The tests use this
 * to prove the three renderers describe the same transform; blur is excluded
 * because it is not a point operation.
 */
export function applyEffectsToPixel(
  effects: Effect[],
  pixel: [number, number, number]
): [number, number, number] {
  const plan = effectsToSharp(effects);
  let [r, g, b] = pixel;

  if (plan.linear) {
    r = plan.linear.a * r + plan.linear.b;
    g = plan.linear.a * g + plan.linear.b;
    b = plan.linear.a * b + plan.linear.b;
  }
  if (plan.recomb) {
    const m = plan.recomb;
    [r, g, b] = [
      m[0][0] * r + m[0][1] * g + m[0][2] * b,
      m[1][0] * r + m[1][1] * g + m[1][2] * b,
      m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ];
  }
  return [r, g, b];
}
