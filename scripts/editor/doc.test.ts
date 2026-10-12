import test from "node:test";
import assert from "node:assert/strict";
import {
  RATIO_PRESETS,
  RATIO_KEYS,
  reduceRatio,
  assertPresetsReduceCorrectly,
  unitOf,
  resolveLayerRect,
  rectToLayerPosition,
  coverCrop,
  createEmptyDoc,
  toTemplate,
  applyTemplate,
  changeRatio,
  layerSchema,
} from "../../src/lib/editor/doc";

function layer(overrides: Record<string, unknown> = {}) {
  return layerSchema.parse({
    id: "l1",
    type: "image",
    size: { w: 0.2 },
    aspect: 1,
    ...overrides,
  });
}

test("every ratio preset reduces to its own key", () => {
  assertPresetsReduceCorrectly();
  for (const key of RATIO_KEYS) {
    const { w, h } = RATIO_PRESETS[key];
    assert.equal(reduceRatio(w, h), key, `${key} -> ${w}x${h}`);
  }
});

test("191:100 is reachable and the known-bad size is rejected", () => {
  // 191 is prime, so only exact multiples reduce correctly.
  assert.equal(reduceRatio(1146, 600), "191:100");
  assert.equal(reduceRatio(1910, 1000), "191:100");
  // li_article.preferredSize would never match its own declared targetRatio.
  assert.equal(reduceRatio(1200, 627), "400:209");
  // Instagram's own 1.91:1 landscape size also does not reduce to 191:100.
  assert.equal(reduceRatio(1080, 566), "540:283");
});

test("video output dimensions are even (libx264 yuv420p requirement)", () => {
  for (const key of RATIO_KEYS) {
    const { w, h } = RATIO_PRESETS[key];
    assert.equal(w % 2, 0, `${key} width ${w} must be even`);
    assert.equal(h % 2, 0, `${key} height ${h} must be even`);
  }
});

test("a square layer keeps its aspect when the canvas ratio changes", () => {
  // This is the bug plain 0..1 normalisation causes: {w:.2,h:.2} on 1080x1920
  // would be 216x384. Deriving height from `aspect` keeps it square.
  const l = layer({ size: { w: 0.2 }, aspect: 1 });
  const square = resolveLayerRect(l, { w: 1080, h: 1080 });
  const story = resolveLayerRect(l, { w: 1080, h: 1920 });

  assert.equal(square.w, square.h);
  assert.equal(story.w, story.h);
  // unit = min(w,h) = 1080 on both, so the visual size is identical.
  assert.equal(square.w, story.w);
});

test("an anchored watermark keeps the same visual inset across ratios", () => {
  const l = layer({ anchor: "br", offset: { dx: -0.05, dy: -0.05 }, size: { w: 0.15 } });
  const a = resolveLayerRect(l, { w: 1080, h: 1080 });
  const b = resolveLayerRect(l, { w: 1080, h: 1920 });

  const insetRight = (c: { w: number; h: number }, r: { x: number; w: number }) => c.w - (r.x + r.w);
  const insetBottom = (c: { w: number; h: number }, r: { y: number; h: number }) => c.h - (r.y + r.h);

  assert.equal(insetRight({ w: 1080, h: 1080 }, a), insetRight({ w: 1080, h: 1920 }, b));
  assert.equal(insetBottom({ w: 1080, h: 1080 }, a), insetBottom({ w: 1080, h: 1920 }, b));
  assert.equal(a.w, b.w);
});

test("resolveLayerRect and rectToLayerPosition round-trip", () => {
  const canvas = { w: 1080, h: 1920 };
  const l = layer({ anchor: "tl", offset: { dx: 0.11, dy: 0.23 }, size: { w: 0.31 }, aspect: 1.5 });
  const rect = resolveLayerRect(l, canvas);
  const back = rectToLayerPosition({ x: rect.x, y: rect.y, w: rect.w }, l.anchor, canvas, l.aspect);

  assert.ok(Math.abs(back.offset.dx - l.offset.dx) < 1e-9);
  assert.ok(Math.abs(back.offset.dy - l.offset.dy) < 1e-9);
  assert.ok(Math.abs(back.size.w - l.size.w) < 1e-9);
});

test("centre anchor puts the layer in the middle", () => {
  const canvas = { w: 1080, h: 1920 };
  const r = resolveLayerRect(layer({ anchor: "cc", offset: { dx: 0, dy: 0 }, size: { w: 0.5 } }), canvas);
  assert.equal(r.x + r.w / 2, canvas.w / 2);
  assert.equal(r.y + r.h / 2, canvas.h / 2);
});

test("coverCrop fills the canvas and stays inside the source", () => {
  // Landscape source into a 9:16 canvas: full height, sides trimmed.
  const wide = coverCrop({ w: 1920, h: 1080 }, { w: 1080, h: 1920 });
  assert.equal(wide.h, 1);
  assert.ok(wide.w < 1 && wide.w > 0);
  assert.ok(Math.abs(wide.x - (1 - wide.w) / 2) < 1e-9);

  // Portrait source into a 16:9 canvas: full width, top/bottom trimmed.
  const tall = coverCrop({ w: 1080, h: 1920 }, { w: 1920, h: 1080 });
  assert.equal(tall.w, 1);
  assert.ok(tall.h < 1 && tall.h > 0);

  // Matching aspect: no crop at all.
  const same = coverCrop({ w: 1080, h: 1080 }, { w: 1080, h: 1080 });
  assert.deepEqual(same, { x: 0, y: 0, w: 1, h: 1 });
});

test("the cropped region has the canvas aspect", () => {
  const source = { w: 4000, h: 3000 };
  const canvas = RATIO_PRESETS["9:16"];
  const c = coverCrop(source, { w: canvas.w, h: canvas.h });
  const croppedAspect = (source.w * c.w) / (source.h * c.h);
  assert.ok(Math.abs(croppedAspect - canvas.w / canvas.h) < 1e-9);
});

test("toTemplate strips the source but keeps the look", () => {
  const doc = createEmptyDoc({ ratio: "9:16", kind: "video", assetId: "asset-1", source: { w: 1920, h: 1080 } });
  doc.layers = [layer({ anchor: "br", size: { w: 0.15 } })];
  doc.base.trim = { start: 2, end: 10 };

  const tpl = toTemplate(doc);
  assert.equal(tpl.base.assetId, null);
  assert.equal(tpl.base.trim, null, "trim belongs to the old clip");
  assert.deepEqual(tpl.base.crop, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(tpl.layers.length, 1);
  assert.equal(tpl.layers[0].anchor, "br");
});

test("applyTemplate recomputes the crop for the new source", () => {
  const tpl = toTemplate(
    createEmptyDoc({ ratio: "9:16", kind: "image", assetId: "old", source: { w: 1080, h: 1920 } })
  );
  const applied = applyTemplate(tpl, { assetId: "new", kind: "image", source: { w: 1920, h: 1080 } });

  assert.equal(applied.base.assetId, "new");
  // A stored 9:16 crop copied onto a landscape photo would cut the wrong region.
  assert.ok(applied.base.crop.w < 1, "crop must be recomputed, not copied");
  assert.equal(applied.base.crop.h, 1);
});

test("applyTemplate clamps absolute timings to a shorter clip", () => {
  const tpl = toTemplate(createEmptyDoc({ ratio: "9:16", kind: "video", assetId: "old" }));
  tpl.layers = [layer({ timing: { start: 2, end: 30, mode: "absolute" } })];

  const applied = applyTemplate(tpl, { assetId: "new", kind: "video", durationSeconds: 10 });
  assert.equal(applied.layers[0].timing?.end, 10, "end must clamp or the layer never shows");

  // Relative timings are duration independent and pass through untouched.
  tpl.layers = [layer({ timing: { start: 0, end: 1, mode: "relative" } })];
  const rel = applyTemplate(tpl, { assetId: "new", kind: "video", durationSeconds: 10 });
  assert.equal(rel.layers[0].timing?.end, 1);
});

test("applyTemplate can retarget to a different ratio", () => {
  const tpl = toTemplate(createEmptyDoc({ ratio: "9:16", kind: "image", assetId: "old" }));
  const applied = applyTemplate(tpl, { assetId: "new", kind: "image", source: { w: 1000, h: 1000 } }, "1:1");

  assert.equal(applied.canvas.ratio, "1:1");
  assert.equal(applied.canvas.w, RATIO_PRESETS["1:1"].w);
  assert.equal(reduceRatio(applied.canvas.w, applied.canvas.h), "1:1");
});

test("changeRatio always yields publishable dimensions", () => {
  let doc = createEmptyDoc({ ratio: "1:1", kind: "image", assetId: "a", source: { w: 4000, h: 3000 } });
  for (const key of RATIO_KEYS) {
    doc = changeRatio(doc, key, { w: 4000, h: 3000 });
    assert.equal(doc.canvas.ratio, key);
    assert.equal(reduceRatio(doc.canvas.w, doc.canvas.h), key);
  }
});

test("unit is the smaller canvas side", () => {
  assert.equal(unitOf({ w: 1080, h: 1920 }), 1080);
  assert.equal(unitOf({ w: 1920, h: 1080 }), 1080);
  assert.equal(unitOf({ w: 1080, h: 1080 }), 1080);
});
