import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFECT_CATALOG,
  EFFECT_TYPES,
  LUMA,
  IDENTITY_MATRIX,
  GRAYSCALE_MATRIX,
  SEPIA_MATRIX,
  saturationMatrix,
  lerpMatrix,
  multiplyMatrix,
  matrixIsIdentity,
  effectToOp,
  isIdentityEffect,
  clampEffectValue,
  defaultValueOf,
  effectsToSharp,
  effectsToCss,
  effectsToFfmpegFilters,
  effectsToFfmpegFilterString,
  applyEffectsToPixel,
  type Matrix3,
} from "../../src/lib/editor/effects";
import type { Effect } from "../../src/lib/editor/doc";

function fx(type: Effect["type"], value: number): Effect {
  return { type, value };
}

/** Every effect at its catalog default — the stack that must be a no-op. */
function defaults(): Effect[] {
  return EFFECT_TYPES.map((type) => fx(type, defaultValueOf(type)));
}

function assertMatrixClose(actual: number[][], expected: number[][], epsilon = 1e-9) {
  assert.equal(actual.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(actual[i].length, 3, `row ${i} must have 3 columns`);
    for (let j = 0; j < 3; j++) {
      assert.ok(
        Math.abs(actual[i][j] - expected[i][j]) <= epsilon,
        `m[${i}][${j}] = ${actual[i][j]}, expected ${expected[i][j]}`
      );
    }
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────
test("catalog covers exactly the six schema effect types", () => {
  assert.deepEqual(
    [...EFFECT_TYPES].sort(),
    ["blur", "brightness", "contrast", "grayscale", "saturation", "sepia"]
  );
  for (const type of EFFECT_TYPES) {
    const spec = EFFECT_CATALOG[type];
    assert.equal(spec.key, type, "key must match its map entry");
    assert.ok(spec.min < spec.max, `${type} range must be non-empty`);
    assert.ok(spec.step > 0, `${type} step must be positive`);
    assert.ok(
      spec.default >= spec.min && spec.default <= spec.max,
      `${type} default ${spec.default} must sit inside [${spec.min}, ${spec.max}]`
    );
  }
});

test("catalog ranges match the documented UI contract", () => {
  assert.equal(EFFECT_CATALOG.brightness.min, 0.5);
  assert.equal(EFFECT_CATALOG.brightness.max, 1.5);
  assert.equal(EFFECT_CATALOG.brightness.default, 1);
  assert.equal(EFFECT_CATALOG.blur.min, 0);
  assert.equal(EFFECT_CATALOG.blur.max, 20);
  assert.equal(EFFECT_CATALOG.blur.default, 0);
  assert.equal(EFFECT_CATALOG.blur.unit, "px");
});

test("clampEffectValue pins to the range and rejects non-finite input", () => {
  assert.equal(clampEffectValue("brightness", 99), 1.5);
  assert.equal(clampEffectValue("brightness", -99), 0.5);
  assert.equal(clampEffectValue("blur", 7.5), 7.5);
  assert.equal(clampEffectValue("saturation", Number.NaN), 1);
  assert.equal(clampEffectValue("saturation", Number.POSITIVE_INFINITY), 1);
});

// ── Identity ─────────────────────────────────────────────────────────────────
test("every effect at its default is a no-op op", () => {
  for (const type of EFFECT_TYPES) {
    const effect = fx(type, defaultValueOf(type));
    assert.equal(effectToOp(effect).kind, "none", `${type} default must be a no-op`);
    assert.equal(isIdentityEffect(effect), true, `${type} default must be identity`);
  }
});

test("the all-defaults stack produces a completely empty sharp plan", () => {
  assert.deepEqual(effectsToSharp(defaults()), {});
  assert.deepEqual(effectsToSharp([]), {});
});

test("the all-defaults stack emits no ffmpeg filters", () => {
  assert.deepEqual(effectsToFfmpegFilters(defaults()), []);
  assert.equal(effectsToFfmpegFilterString(defaults()), "");
});

// ── Grayscale ────────────────────────────────────────────────────────────────
test("grayscale at 1 is the exact luminance matrix", () => {
  const plan = effectsToSharp([fx("grayscale", 1)]);
  assert.ok(plan.recomb, "grayscale must emit a recomb matrix");
  assertMatrixClose(plan.recomb!, [
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
  ]);
  // No brightness/contrast ramp is introduced in passing.
  assert.equal(plan.linear, undefined);
  assert.equal(plan.blur, undefined);
});

test("every grayscale row is the luma vector and sums to 1", () => {
  for (const row of GRAYSCALE_MATRIX) {
    assert.deepEqual(row, [LUMA.r, LUMA.g, LUMA.b]);
    assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-12, "luma coefficients sum to 1");
  }
});

test("grayscale maps any colour to a neutral grey of equal luminance", () => {
  const [r, g, b] = applyEffectsToPixel([fx("grayscale", 1)], [200, 100, 50]);
  const expected = 0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50;
  assert.ok(Math.abs(r - expected) < 1e-9);
  assert.equal(r, g);
  assert.equal(g, b);
});

test("grayscale at 0.5 is halfway to the luminance matrix", () => {
  const plan = effectsToSharp([fx("grayscale", 0.5)]);
  const expected = IDENTITY_MATRIX.map((row, i) =>
    row.map((v, j) => v * 0.5 + GRAYSCALE_MATRIX[i][j] * 0.5)
  );
  assertMatrixClose(plan.recomb!, expected);
});

// ── Sepia ────────────────────────────────────────────────────────────────────
test("sepia at 1 is the canonical Filter Effects matrix", () => {
  const plan = effectsToSharp([fx("sepia", 1)]);
  assertMatrixClose(plan.recomb!, [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131],
  ]);
  assertMatrixClose(SEPIA_MATRIX as unknown as number[][], plan.recomb!);
});

// ── Saturation ───────────────────────────────────────────────────────────────
test("saturation at 1 is the identity matrix", () => {
  assertMatrixClose(saturationMatrix(1) as unknown as number[][], IDENTITY_MATRIX as unknown as number[][]);
  assert.equal(matrixIsIdentity(saturationMatrix(1)), true);
  // ...and therefore drops out of the plan entirely.
  assert.deepEqual(effectsToSharp([fx("saturation", 1)]), {});
});

test("saturation at 0 equals the grayscale matrix", () => {
  assertMatrixClose(
    saturationMatrix(0) as unknown as number[][],
    GRAYSCALE_MATRIX as unknown as number[][]
  );
  const viaSaturation = effectsToSharp([fx("saturation", 0)]).recomb!;
  const viaGrayscale = effectsToSharp([fx("grayscale", 1)]).recomb!;
  assertMatrixClose(viaSaturation, viaGrayscale);
});

test("saturation preserves luminance at any strength", () => {
  const pixel: [number, number, number] = [200, 100, 50];
  const luma = (p: [number, number, number]) => LUMA.r * p[0] + LUMA.g * p[1] + LUMA.b * p[2];
  for (const s of [0, 0.25, 0.5, 1, 1.5, 2]) {
    const out = applyEffectsToPixel([fx("saturation", s)], pixel);
    assert.ok(
      Math.abs(luma(out) - luma(pixel)) < 1e-9,
      `saturation ${s} changed luminance: ${luma(out)} vs ${luma(pixel)}`
    );
  }
});

test("saturation rows use the 0.2126/0.7152/0.0722 coefficients", () => {
  // At s = 0 the matrix collapses to the luma vector in every row, which is the
  // only way grayscale and saturation can agree at their shared extreme.
  const m = saturationMatrix(0);
  for (const row of m) {
    assert.ok(Math.abs(row[0] - 0.2126) < 1e-12);
    assert.ok(Math.abs(row[1] - 0.7152) < 1e-12);
    assert.ok(Math.abs(row[2] - 0.0722) < 1e-12);
  }
});

// ── Brightness and contrast ──────────────────────────────────────────────────
test("brightness is a pure slope through black", () => {
  const plan = effectsToSharp([fx("brightness", 1.2)]);
  assert.deepEqual(plan.linear, { a: 1.2, b: 0 });
  assert.equal(plan.recomb, undefined);
  const [r] = applyEffectsToPixel([fx("brightness", 1.2)], [100, 100, 100]);
  assert.ok(Math.abs(r - 120) < 1e-9);
  // Black stays black, which is what makes it match CSS rather than sharp.modulate.
  assert.deepEqual(applyEffectsToPixel([fx("brightness", 1.2)], [0, 0, 0]), [0, 0, 0]);
});

test("contrast maps the 0-255 midpoint to itself", () => {
  for (const value of [0.5, 0.75, 1.25, 1.5]) {
    const plan = effectsToSharp([fx("contrast", value)]);
    assert.ok(plan.linear, `contrast ${value} must emit a linear ramp`);
    const mid = plan.linear!.a * 127.5 + plan.linear!.b;
    assert.ok(
      Math.abs(mid - 127.5) < 1e-9,
      `contrast ${value} moved the midpoint to ${mid}`
    );
  }
});

test("contrast uses the CSS intercept, not sharp.modulate or ffmpeg eq semantics", () => {
  const plan = effectsToSharp([fx("contrast", 1.5)]);
  assert.deepEqual(plan.linear, { a: 1.5, b: 127.5 * (1 - 1.5) });
  // Pushing contrast up drives darks down and lights up around the midpoint.
  const [dark] = applyEffectsToPixel([fx("contrast", 1.5)], [64, 64, 64]);
  const [light] = applyEffectsToPixel([fx("contrast", 1.5)], [192, 192, 192]);
  assert.ok(dark < 64, `expected darks to fall, got ${dark}`);
  assert.ok(light > 192, `expected lights to rise, got ${light}`);
});

// ── Composition ──────────────────────────────────────────────────────────────
test("stacked linear ramps collapse into one a/b pair", () => {
  const stack = [fx("brightness", 1.2), fx("contrast", 1.5)];
  const plan = effectsToSharp(stack);
  // Composing out = a2*(a1*x + b1) + b2 with b1 = 0.
  assert.ok(Math.abs(plan.linear!.a - 1.2 * 1.5) < 1e-9);
  assert.ok(Math.abs(plan.linear!.b - 127.5 * (1 - 1.5)) < 1e-9);
  // One ramp, applied in order, equals applying them one after the other.
  const once = applyEffectsToPixel(stack, [100, 100, 100]);
  const twice = applyEffectsToPixel(
    [fx("contrast", 1.5)],
    applyEffectsToPixel([fx("brightness", 1.2)], [100, 100, 100])
  );
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(once[i] - twice[i]) < 1e-9);
});

test("stacked matrices collapse into one matrix product", () => {
  const plan = effectsToSharp([fx("saturation", 0.5), fx("sepia", 1)]);
  const expected = multiplyMatrix(lerpMatrix(SEPIA_MATRIX, 1), saturationMatrix(0.5));
  assertMatrixClose(plan.recomb!, expected as unknown as number[][]);
});

test("stacked blurs add in quadrature rather than summing", () => {
  const plan = effectsToSharp([fx("blur", 3), fx("blur", 4)]);
  assert.ok(Math.abs(plan.blur! - 5) < 1e-9, `expected 5, got ${plan.blur}`);
});

test("lerpMatrix at 0 is the identity and clamps out-of-range amounts", () => {
  assertMatrixClose(lerpMatrix(SEPIA_MATRIX, 0) as unknown as number[][], IDENTITY_MATRIX as unknown as number[][]);
  assertMatrixClose(lerpMatrix(SEPIA_MATRIX, 5) as unknown as number[][], SEPIA_MATRIX as unknown as number[][]);
  assertMatrixClose(lerpMatrix(SEPIA_MATRIX, -5) as unknown as number[][], IDENTITY_MATRIX as unknown as number[][]);
});

test("effectToOp ignores unknown types and non-finite values", () => {
  assert.equal(effectToOp({ type: "nope" } as unknown as Effect).kind, "none");
  assert.equal(effectToOp(fx("brightness", Number.NaN)).kind, "none");
});

// ── CSS renderer ─────────────────────────────────────────────────────────────
test("the CSS string round-trips the catalog defaults to a no-op", () => {
  assert.equal(effectsToCss([]), "none");
  // Defaults are real identity values in CSS too: brightness(1) etc. change
  // nothing, so the string is a no-op even though it is not literally "none".
  const css = effectsToCss(defaults());
  assert.equal(
    css,
    "brightness(1) contrast(1) saturate(1) grayscale(0) sepia(0) blur(0px)"
  );
  for (const [, value] of css.matchAll(/\(([\d.]+)px?\)/g)) {
    const n = Number(value);
    assert.ok(n === 0 || n === 1, `identity CSS value must be 0 or 1, got ${value}`);
  }
});

test("the CSS string reflects non-identity values", () => {
  assert.equal(
    effectsToCss([fx("brightness", 1.2), fx("blur", 4)]),
    "brightness(1.2) blur(4px)"
  );
  assert.equal(effectsToCss([fx("saturation", 0)]), "saturate(0)");
});

// ── ffmpeg renderer ──────────────────────────────────────────────────────────
test("effectsToFfmpegFilters emits one filter per non-identity effect", () => {
  const stack = [
    fx("brightness", 1.2), // non-identity
    fx("contrast", 1), // identity -> skipped
    fx("saturation", 0.5), // non-identity
    fx("grayscale", 0), // identity -> skipped
    fx("sepia", 0.3), // non-identity
    fx("blur", 4), // non-identity
  ];
  const filters = effectsToFfmpegFilters(stack);
  assert.equal(filters.length, 4, filters.join(" | "));
  assert.equal(filters.filter((f) => f.startsWith("colorchannelmixer=")).length, 3);
  assert.equal(filters.filter((f) => f.startsWith("gblur=")).length, 1);
  assert.equal(effectsToFfmpegFilterString(stack), filters.join(","));
});

test("ffmpeg never emits eq=, whose brightness is an additive YUV offset", () => {
  const filters = effectsToFfmpegFilters([
    fx("brightness", 1.3),
    fx("contrast", 0.8),
    fx("saturation", 1.4),
  ]);
  for (const f of filters) {
    assert.ok(!f.includes("eq="), `eq= would not match the CSS/sharp path: ${f}`);
    assert.ok(!f.includes("hue="), `hue= would not match the CSS/sharp path: ${f}`);
  }
});

test("ffmpeg matrix coefficients equal the sharp matrix for the same effect", () => {
  const stack = [fx("sepia", 1)];
  const [filter] = effectsToFfmpegFilters(stack);
  const recomb = effectsToSharp(stack).recomb!;
  const read = (key: string) => {
    // Keys are delimited by `:` except the first, which follows the filter's `=`.
    const match = filter.match(new RegExp(`[=:]${key}=(-?[\\d.]+)`));
    assert.ok(match, `${key} missing from ${filter}`);
    return Number(match![1]);
  };
  const names = [
    ["rr", "rg", "rb"],
    ["gr", "gg", "gb"],
    ["br", "bg", "bb"],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(
        Math.abs(read(names[i][j]) - recomb[i][j]) < 1e-6,
        `${names[i][j]} = ${read(names[i][j])}, sharp has ${recomb[i][j]}`
      );
    }
  }
  // Alpha must pass through untouched or the overlay composite goes opaque.
  assert.ok(filter.includes("aa=1"), filter);
});

test("ffmpeg converts the linear offset from 0-255 into 0-1 space", () => {
  const [filter] = effectsToFfmpegFilters([fx("contrast", 1.5)]);
  const expectedOffset = (127.5 * (1 - 1.5)) / 255;
  const match = filter.match(/ra=(-?[\d.]+)/);
  assert.ok(match, filter);
  assert.ok(
    Math.abs(Number(match![1]) - expectedOffset) < 1e-6,
    `ra = ${match![1]}, expected ${expectedOffset}`
  );
  assert.ok(filter.includes("rr=1.5"), filter);
});

test("ffmpeg values are plain decimals, never exponent notation", () => {
  const filters = effectsToFfmpegFilters([fx("blur", 0.5), fx("saturation", 0.000001)]);
  for (const f of filters) {
    assert.ok(!/e[+-]?\d/i.test(f), `ffmpeg cannot parse exponent notation: ${f}`);
  }
});

test("blur is the only effect that is not a point operation", () => {
  const plan = effectsToSharp([fx("blur", 6)]);
  assert.deepEqual(plan, { blur: 6 });
  assert.deepEqual(effectsToFfmpegFilters([fx("blur", 6)]), ["gblur=sigma=6"]);
  // ...so it is excluded from the per-pixel helper.
  assert.deepEqual(applyEffectsToPixel([fx("blur", 6)], [10, 20, 30]), [10, 20, 30]);
});

// ── Cross-renderer agreement ─────────────────────────────────────────────────
test("all three renderers are driven by the same op, so none can drift", () => {
  // A matrix effect must appear as a matrix in sharp AND as a mixer in ffmpeg,
  // and a linear effect as a ramp in both. If effectToOp ever changed shape for
  // one renderer only, this would fail.
  for (const type of EFFECT_TYPES) {
    const spec = EFFECT_CATALOG[type];
    const value = type === "blur" ? 4 : spec.default === 1 ? 1.25 : 0.75;
    const effect = fx(type, value);
    const op = effectToOp(effect);
    const plan = effectsToSharp([effect]);
    const filters = effectsToFfmpegFilters([effect]);

    assert.equal(filters.length, 1, `${type} must emit exactly one ffmpeg filter`);
    if (op.kind === "linear") {
      assert.ok(plan.linear, `${type} must be a sharp linear ramp`);
      assert.ok(filters[0].startsWith("colorchannelmixer="), filters[0]);
    } else if (op.kind === "matrix") {
      assert.ok(plan.recomb, `${type} must be a sharp recomb matrix`);
      assert.ok(filters[0].startsWith("colorchannelmixer="), filters[0]);
    } else if (op.kind === "blur") {
      assert.ok(plan.blur, `${type} must be a sharp blur`);
      assert.ok(filters[0].startsWith("gblur="), filters[0]);
    } else {
      assert.fail(`${type} at ${value} should not be a no-op`);
    }
  }
});

test("matrixIsIdentity tolerates float noise but not real change", () => {
  const noisy: Matrix3 = [
    [1 + 1e-12, 0, 0],
    [0, 1, 0],
    [0, 0, 1 - 1e-12],
  ];
  assert.equal(matrixIsIdentity(noisy), true);
  assert.equal(matrixIsIdentity(GRAYSCALE_MATRIX), false);
});

test("effectsToSharp does not mutate the input effects", () => {
  const stack = [fx("brightness", 1.2), fx("sepia", 0.4)];
  const snapshot = JSON.stringify(stack);
  effectsToSharp(stack);
  effectsToFfmpegFilters(stack);
  effectsToCss(stack);
  assert.equal(JSON.stringify(stack), snapshot);
});
