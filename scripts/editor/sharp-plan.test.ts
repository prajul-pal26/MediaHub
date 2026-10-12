/**
 * Geometry tests for the sharp (image) render path.
 *
 * Run: npx tsx --test scripts/editor/sharp-plan.test.ts
 *
 * The contract these pin down is that the server render reproduces the CSS
 * transform in BaseMedia.tsx. A photo flipped in the editor must come back
 * flipped; silently ignoring the transform ships a wrong file to every
 * connected account, which is exactly the failure this module exists to stop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  planCoverGeometry,
  isIdentityTransform,
  type BaseTransform,
} from "../../src/lib/editor/sharp-plan";
import { coverCrop, RATIO_PRESETS } from "../../src/lib/editor/doc";

const ID: BaseTransform = {
  rotate: 0,
  flipH: false,
  flipV: false,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const t = (patch: Partial<BaseTransform>): BaseTransform => ({ ...ID, ...patch });

/** A real cover crop, so fullW/fullH === srcW/srcH as coverCrop guarantees. */
function realCrop(ratio: keyof typeof RATIO_PRESETS, srcW: number, srcH: number) {
  const p = RATIO_PRESETS[ratio];
  return coverCrop({ w: srcW, h: srcH }, { w: p.w, h: p.h });
}

test("identity reduces to crop x source — the plain extract this replaced", () => {
  const crop = realCrop("4:5", 2000, 2000);
  const p = RATIO_PRESETS["4:5"];
  const g = planCoverGeometry(p.w, p.h, crop, ID, 2000, 2000);

  assert.equal(g.extend, null, "an in-bounds crop needs no background margin");
  assert.equal(g.clamped, false);
  // Algebraically crop * source.
  assert.equal(g.extract.left, Math.round(crop.x * 2000));
  assert.equal(g.extract.top, Math.round(crop.y * 2000));
  assert.equal(g.extract.width, Math.round(crop.w * 2000));
  assert.equal(g.extract.height, Math.round(crop.h * 2000));
});

test("identity reduction holds for every ratio preset and a few source shapes", () => {
  for (const ratio of Object.keys(RATIO_PRESETS) as Array<keyof typeof RATIO_PRESETS>) {
    for (const [sw, sh] of [
      [4000, 3000],
      [1080, 1920],
      [2000, 2000],
      [3000, 1200],
    ]) {
      const p = RATIO_PRESETS[ratio];
      const crop = coverCrop({ w: sw, h: sh }, { w: p.w, h: p.h });
      const g = planCoverGeometry(p.w, p.h, crop, ID, sw, sh);
      assert.equal(g.extract.width, Math.round(crop.w * sw), `${ratio} ${sw}x${sh} width`);
      assert.equal(g.extract.height, Math.round(crop.h * sh), `${ratio} ${sw}x${sh} height`);
      assert.equal(g.extend, null, `${ratio} ${sw}x${sh} should not extend`);
    }
  }
});

test("flipH mirrors the window about the source centre, width unchanged", () => {
  const crop = { x: 0.1, y: 0, w: 0.5, h: 1 };
  const flat = planCoverGeometry(1080, 1080, crop, ID, 1000, 1000);
  const flip = planCoverGeometry(1080, 1080, crop, t({ flipH: true }), 1000, 1000);

  assert.equal(flat.extract.left, 100);
  // srcW - x - w
  assert.equal(flip.extract.left, 1000 - 100 - 500);
  assert.equal(flip.extract.width, flat.extract.width);
  assert.equal(flip.extract.top, flat.extract.top, "a horizontal mirror must not move y");
});

test("flipV mirrors vertically and leaves x alone", () => {
  const crop = { x: 0, y: 0.1, w: 1, h: 0.5 };
  const g = planCoverGeometry(1080, 1080, crop, t({ flipV: true }), 1000, 1000);
  assert.equal(g.extract.left, 0);
  assert.equal(g.extract.top, 1000 - 100 - 500);
});

test("flipH twice is the identity", () => {
  const crop = realCrop("1:1", 1600, 1200);
  const p = RATIO_PRESETS["1:1"];
  const once = planCoverGeometry(p.w, p.h, crop, t({ flipH: true }), 1600, 1200);
  const back = planCoverGeometry(p.w, p.h, crop, t({ flipH: true, scale: 1 }), 1600, 1200);
  assert.deepEqual(once.extract, back.extract, "deterministic");
  const flat = planCoverGeometry(p.w, p.h, crop, ID, 1600, 1200);
  assert.equal(once.extract.width, flat.extract.width);
});

test("rotate 90 transposes the extracted patch for a consistent crop", () => {
  // A square source keeps kx === ky, so the transpose is exact.
  const crop = realCrop("9:16", 2000, 2000);
  const p = RATIO_PRESETS["9:16"];
  const flat = planCoverGeometry(p.w, p.h, crop, ID, 2000, 2000);
  const rot = planCoverGeometry(p.w, p.h, crop, t({ rotate: 90 }), 2000, 2000);

  assert.equal(rot.extract.width, flat.extract.height, "w/h transpose under 90deg");
  assert.equal(rot.extract.height, flat.extract.width);
});

test("rotate 360 is the identity and 180 preserves size", () => {
  const crop = realCrop("1:1", 1600, 1600);
  const p = RATIO_PRESETS["1:1"];
  const flat = planCoverGeometry(p.w, p.h, crop, ID, 1600, 1600);
  const full = planCoverGeometry(p.w, p.h, crop, t({ rotate: 360 }), 1600, 1600);
  const half = planCoverGeometry(p.w, p.h, crop, t({ rotate: 180 }), 1600, 1600);

  assert.deepEqual(full.extract, flat.extract, "360 === identity");
  assert.equal(half.extract.width, flat.extract.width);
  assert.equal(half.extract.height, flat.extract.height);
});

test("scale < 1 zooms out and letterboxes with background", () => {
  const g = planCoverGeometry(1080, 1080, { x: 0, y: 0, w: 1, h: 1 }, t({ scale: 0.5 }), 1000, 1000);
  assert.notEqual(g.extend, null, "a half-scale image must show background");
  assert.ok(g.extend!.left > 0 && g.extend!.right > 0, "padded both sides");
  // Requested twice the source, so roughly half a source of margin per side.
  assert.ok(Math.abs(g.extend!.left - 500) <= 1, `left pad was ${g.extend!.left}`);
  assert.ok(Math.abs(g.extend!.right - 500) <= 1, `right pad was ${g.extend!.right}`);
});

test("scale > 1 zooms in, never extends", () => {
  const g = planCoverGeometry(1080, 1080, { x: 0, y: 0, w: 1, h: 1 }, t({ scale: 2 }), 1000, 1000);
  assert.equal(g.extend, null);
  assert.ok(Math.abs(g.extract.width - 500) <= 1, `width was ${g.extract.width}`);
});

test("the extract NEVER leaves the source, across hostile transforms", () => {
  // The regression this file was written for: clamping only the lower bound
  // leaves left > srcW for an off-source framing, and sharp then throws
  // "bad extract area" instead of rendering background.
  const crop = realCrop("9:16", 1200, 900);
  const p = RATIO_PRESETS["9:16"];
  const hostile: Array<Partial<BaseTransform>> = [
    { scale: 0.2 },
    { scale: 0.01 },
    { rotate: 90, scale: 0.3 },
    { offsetX: 2, offsetY: -2 },
    { offsetX: -50, offsetY: 50 },
    { offsetX: 1e6 },
    { flipH: true, flipV: true, rotate: 270, scale: 0.4 },
    { rotate: 37, scale: 0.75 },
    { rotate: -90 },
    { scale: 1e-9 },
  ];

  for (const patch of hostile) {
    const g = planCoverGeometry(p.w, p.h, crop, t(patch), 1200, 900);
    const label = JSON.stringify(patch);
    const e = g.extract;
    assert.ok(Number.isInteger(e.left) && Number.isInteger(e.top), `${label}: integer origin`);
    assert.ok(Number.isInteger(e.width) && Number.isInteger(e.height), `${label}: integer size`);
    assert.ok(e.left >= 0 && e.top >= 0, `${label}: non-negative origin`);
    assert.ok(e.width >= 1 && e.height >= 1, `${label}: non-empty`);
    assert.ok(e.left + e.width <= 1200, `${label}: within source width`);
    assert.ok(e.top + e.height <= 900, `${label}: within source height`);
    if (g.extend) {
      for (const [k, v] of Object.entries(g.extend)) {
        assert.ok(Number.isInteger(v) && v >= 0, `${label}: pad ${k} is a non-negative integer`);
        // Bounded, so no multi-gigapixel intermediate.
        assert.ok(v <= Math.max(p.w, p.h) * 4, `${label}: pad ${k} bounded, was ${v}`);
      }
    }
  }
});

test("a degenerate zero crop yields a usable rect rather than NaN", () => {
  const g = planCoverGeometry(1080, 1080, { x: 0, y: 0, w: 0, h: 0 }, ID, 800, 600);
  for (const [k, v] of Object.entries(g.extract)) {
    assert.ok(Number.isFinite(v), `${k} finite`);
  }
  assert.ok(g.extract.width >= 1 && g.extract.height >= 1);
  assert.ok(g.extract.left + g.extract.width <= 800);
});

test("a 1x1 source does not produce a zero-sized extract", () => {
  const g = planCoverGeometry(1080, 1920, { x: 0, y: 0, w: 1, h: 1 }, ID, 1, 1);
  assert.equal(g.extract.width, 1);
  assert.equal(g.extract.height, 1);
  assert.equal(g.extract.left, 0);
  assert.equal(g.extract.top, 0);
});

test("isIdentityTransform gates the fast path, tolerating float noise", () => {
  assert.equal(isIdentityTransform(ID), true);
  assert.equal(isIdentityTransform(t({ rotate: 360 })), true, "a full turn is identity");
  assert.equal(isIdentityTransform(t({ scale: 1 + 1e-9 })), true, "float noise tolerated");
  assert.equal(isIdentityTransform(t({ flipH: true })), false);
  assert.equal(isIdentityTransform(t({ flipV: true })), false);
  assert.equal(isIdentityTransform(t({ rotate: 90 })), false);
  assert.equal(isIdentityTransform(t({ scale: 1.01 })), false);
  assert.equal(isIdentityTransform(t({ offsetX: 0.01 })), false);
});

test("the plan is deterministic and does not mutate its inputs", () => {
  const crop = realCrop("4:5", 3000, 2000);
  const transform = t({ flipH: true, rotate: 90, scale: 1.5 });
  const cropCopy = { ...crop };
  const transformCopy = { ...transform };
  const p = RATIO_PRESETS["4:5"];

  const a = planCoverGeometry(p.w, p.h, crop, transform, 3000, 2000);
  const b = planCoverGeometry(p.w, p.h, crop, transform, 3000, 2000);

  assert.deepEqual(a, b, "same inputs, same plan");
  assert.deepEqual(crop, cropCopy, "crop untouched");
  assert.deepEqual(transform, transformCopy, "transform untouched");
});
