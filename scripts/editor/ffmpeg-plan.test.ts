import test from "node:test";
import assert from "node:assert/strict";
import {
  editDocSchema,
  RATIO_PRESETS,
  RATIO_KEYS,
  type EditDoc,
  type Effect,
  type RatioKey,
} from "../../src/lib/editor/doc";
import {
  parseProbe,
  buildRenderPlan,
  parseProgress,
  validateFilterGraph,
  derotationFilters,
  isHdrProbe,
  TONEMAP_FILTERS,
  type ProbeResult,
  type RenderPlan,
} from "../../src/lib/editor/ffmpeg-plan";

// ── Fixtures ─────────────────────────────────────────────────────────────────
interface DocOptions {
  ratio?: RatioKey;
  fit?: "cover" | "contain-blur" | "contain-color";
  crop?: { x: number; y: number; w: number; h: number };
  trim?: { start: number; end: number } | null;
  transform?: Partial<EditDoc["base"]["transform"]>;
  effects?: Effect[];
  audio?: Partial<EditDoc["audio"]>;
  canvas?: { w: number; h: number };
}

function makeDoc(options: DocOptions = {}): EditDoc {
  const ratio = options.ratio ?? "9:16";
  const preset = RATIO_PRESETS[ratio];
  return editDocSchema.parse({
    version: 1,
    canvas: {
      ratio,
      w: options.canvas?.w ?? preset.w,
      h: options.canvas?.h ?? preset.h,
      background: { type: "color", color: "#101010" },
    },
    refCanvas: { w: preset.w, h: preset.h },
    base: {
      assetId: "asset-1",
      kind: "video",
      fit: options.fit ?? "cover",
      crop: options.crop ?? { x: 0, y: 0, w: 1, h: 1 },
      transform: {
        rotate: 0,
        flipH: false,
        flipV: false,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        ...(options.transform ?? {}),
      },
      trim: options.trim ?? null,
    },
    layers: [],
    effects: options.effects ?? [],
    audio: {
      trackId: null,
      volume: 1,
      muteOriginal: false,
      startOffset: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: true,
      ...(options.audio ?? {}),
    },
    overlayDriveFileId: null,
  });
}

function makeProbe(options: Partial<ProbeResult> = {}): ProbeResult {
  return {
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    hasAudio: true,
    rotation: 0,
    colorTransfer: null,
    colorPrimaries: null,
    ...options,
  };
}

function plan(doc: EditDoc, probe: ProbeResult, extra: Partial<Parameters<typeof buildRenderPlan>[0]> = {}) {
  return buildRenderPlan({
    doc,
    probe,
    inputVideoPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    ...extra,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function hasSequence(args: string[], seq: string[]): boolean {
  outer: for (let i = 0; i + seq.length <= args.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (args[i + j] !== seq[j]) continue outer;
    }
    return true;
  }
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}

/** Every purely numeric positional size in a crop/scale/pad must be even. */
function numericDimensions(graph: string): number[] {
  const found: number[] = [];
  for (const match of graph.matchAll(/\b(?:crop|scale|pad)=([^,;[\]]+)/g)) {
    for (const token of match[1].split(":")) {
      if (/^\d+$/.test(token)) found.push(Number(token));
    }
  }
  return found;
}

/**
 * Does the plan reference the source's audio stream anywhere?
 *
 * Must match the label form `[0:a]` rather than a bare "0:a" substring: filter
 * arguments like `adelay=500:all=1` contain "0:a" by coincidence.
 */
function referencesOriginalAudio(result: RenderPlan): boolean {
  if (/\[0:a\]/.test(result.filterGraph)) return true;
  return result.args.some((a, i) => result.args[i - 1] === "-map" && /^\[?0:a\]?$/.test(a));
}

/**
 * Structural check for the failure ffmpeg reports as "Output with label '...'
 * does not exist in any defined filter graph".
 */
function labelProblems(result: RenderPlan): string[] {
  const problems: string[] = [];
  const produced = new Set<string>();
  const consumed = new Set<string>();

  for (const chain of result.filterGraph.split(";")) {
    const leading = /^(?:\[[^\]]+\])+/.exec(chain);
    const trailing = /(?:\[[^\]]+\])+$/.exec(chain);
    const body = chain.slice(leading?.[0].length ?? 0, chain.length - (trailing?.[0].length ?? 0));
    if (body.trim() === "") problems.push(`chain with no filters: ${chain}`);

    for (const label of leading?.[0].match(/\[([^\]]+)\]/g) ?? []) {
      consumed.add(label.slice(1, -1));
    }
    for (const label of trailing?.[0].match(/\[([^\]]+)\]/g) ?? []) {
      produced.add(label.slice(1, -1));
    }
  }

  const mapped = new Set<string>();
  for (let i = 0; i < result.args.length - 1; i++) {
    if (result.args[i] === "-map") mapped.add(result.args[i + 1].replace(/^\[|\]$/g, ""));
  }

  for (const label of produced) {
    if (!consumed.has(label) && !mapped.has(label)) {
      problems.push(`label [${label}] is produced but never consumed or mapped`);
    }
  }
  for (const label of consumed) {
    // A consumed label is legal if some chain produces it, or it names a file
    // stream like "0:v" / "2:a".
    if (!produced.has(label) && !/^\d+:[va]$/.test(label)) {
      problems.push(`label [${label}] is consumed but never produced`);
    }
  }
  for (const label of mapped) {
    if (!produced.has(label) && !/^\d+:[va]$/.test(label)) {
      problems.push(`-map ${label} refers to nothing the graph produces`);
    }
  }
  return problems;
}

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${expected}, got ${actual}`
  );
}

// ── parseProbe ───────────────────────────────────────────────────────────────
test("parseProbe reads a real ffprobe payload, strings and all", () => {
  const probe = parseProbe({
    streams: [
      {
        index: 0,
        codec_type: "video",
        width: 1920,
        height: 1080,
        duration: "3.000000",
        color_transfer: "bt709",
        color_primaries: "bt709",
      },
      { index: 1, codec_type: "audio", duration: "3.000000" },
    ],
    format: { duration: "3.041667" },
  });

  assert.equal(probe.width, 1920);
  assert.equal(probe.height, 1080);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.rotation, 0);
  // The video stream's own duration wins: format.duration is the longest stream,
  // so a long music bed must not let a trim run past the end of the picture.
  approx(probe.durationSeconds, 3);
});

test("parseProbe tolerates a JSON string, N/A and missing sections", () => {
  const fromString = parseProbe(
    JSON.stringify({ streams: [{ codec_type: "video", width: 640, height: 480, duration: "N/A" }] })
  );
  assert.equal(fromString.width, 640);
  assert.equal(fromString.durationSeconds, 0);
  assert.equal(fromString.hasAudio, false);

  const empty = parseProbe({});
  assert.equal(empty.width, 0);
  assert.equal(empty.hasAudio, false);
  assert.equal(empty.durationSeconds, 0);

  const junk = parseProbe("not json at all");
  assert.equal(junk.width, 0);

  const unknownColour = parseProbe({
    streams: [{ codec_type: "video", width: 10, height: 10, color_transfer: "unknown" }],
  });
  assert.equal(unknownColour.colorTransfer, null);
});

test("parseProbe negates the display matrix into a clockwise angle", () => {
  // ffprobe prints av_display_rotation_get(), the COUNTER-clockwise angle.
  // Verified against ffmpeg 8.0.1: a file reporting rotation:90 is corrected by
  // transpose=cclock, which is the 270-clockwise case.
  const ccw90 = parseProbe({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
      },
    ],
  });
  assert.equal(ccw90.rotation, 270);
  assert.deepEqual(derotationFilters(ccw90.rotation), ["transpose=cclock"]);

  // The classic iPhone portrait capture reports -90.
  const iphone = parseProbe({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
      },
    ],
  });
  assert.equal(iphone.rotation, 90);
  assert.deepEqual(derotationFilters(iphone.rotation), ["transpose=clock"]);

  const upsideDown = parseProbe({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }],
      },
    ],
  });
  assert.equal(upsideDown.rotation, 180);
  assert.deepEqual(derotationFilters(180), ["hflip", "vflip"]);
});

test("parseProbe prefers a non-zero legacy rotate tag, like ffmpeg does", () => {
  const legacy = parseProbe({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        tags: { rotate: "90" },
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }],
      },
    ],
  });
  // The tag is already a clockwise angle and takes precedence.
  assert.equal(legacy.rotation, 90);

  const zeroTag = parseProbe({
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        tags: { rotate: "0" },
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
      },
    ],
  });
  assert.equal(zeroTag.rotation, 90, "a zero tag must fall through to the matrix");
});

test("derotationFilters ignores non-orthogonal angles, matching ffmpeg autorotate", () => {
  assert.deepEqual(derotationFilters(0), []);
  assert.deepEqual(derotationFilters(37), []);
  assert.deepEqual(derotationFilters(360), []);
  // Within ffmpeg's own 1-degree tolerance.
  assert.deepEqual(derotationFilters(89.6), ["transpose=clock"]);
});

// ── Rotation before crop ─────────────────────────────────────────────────────
test("a 90-degree rotated source crops the correct region", () => {
  // Stored landscape 1920x1080, displayed as portrait 1080x1920.
  const doc = makeDoc({ ratio: "9:16", crop: { x: 0, y: 0, w: 1, h: 0.5 } });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080, rotation: 90 }));

  const transposeAt = result.filterGraph.indexOf("transpose=clock");
  const cropAt = result.filterGraph.indexOf("crop=");
  assert.ok(transposeAt >= 0, "must de-rotate");
  assert.ok(cropAt > transposeAt, "crop must come AFTER the de-rotation");

  // The top half of the DE-ROTATED 1080x1920 frame.
  assert.match(result.filterGraph, /crop=1080:960:0:0/);
  // The region you would get by cropping the stored frame first.
  assert.ok(
    !result.filterGraph.includes("crop=1920:540"),
    "cropping before de-rotating cuts the wrong region"
  );
});

test("a 270-degree rotated source also swaps the crop axes", () => {
  const doc = makeDoc({ ratio: "9:16", crop: { x: 0, y: 0.5, w: 1, h: 0.5 } });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080, rotation: 270 }));
  assert.match(result.filterGraph, /transpose=cclock/);
  // Bottom half of the de-rotated 1080x1920 frame.
  assert.match(result.filterGraph, /crop=1080:960:0:960/);
});

test("an unrotated source crops against the stored dimensions", () => {
  const doc = makeDoc({ ratio: "16:9", crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080, rotation: 0 }));
  assert.match(result.filterGraph, /crop=960:1080:480:0/);
  assert.ok(!result.filterGraph.includes("transpose"), "no rotation, no transpose");
});

test("autorotate is disabled and the display matrix is actually stripped", () => {
  const result = plan(makeDoc(), makeProbe({ rotation: 90 }));
  const inputAt = result.args.indexOf("-i");

  // ffmpeg autorotates by DEFAULT, so our own transpose would rotate twice.
  assert.ok(result.args.includes("-noautorotate"));
  assert.ok(result.args.indexOf("-noautorotate") < inputAt, "-noautorotate is an input option");

  // Verified against ffmpeg 8.0.1: -metadata:s:v:0 rotate=0 alone does NOT
  // remove the display matrix from the output; -display_rotation 0 does.
  assert.equal(argValue(result.args, "-display_rotation"), "0");
  assert.ok(result.args.indexOf("-display_rotation") < inputAt, "-display_rotation is an input option");
  assert.ok(hasSequence(result.args, ["-metadata:s:v:0", "rotate=0"]));
});

// ── CFR ──────────────────────────────────────────────────────────────────────
test("constant frame rate is forced with the ffmpeg 8 spelling", () => {
  const result = plan(makeDoc(), makeProbe());
  assert.equal(argValue(result.args, "-fps_mode"), "cfr");
  assert.ok(!result.args.includes("-vsync"), "-vsync is the deprecated spelling");
});

// ── Crop then scale, even dimensions ─────────────────────────────────────────
test("crop comes before scale, and setsar follows", () => {
  const result = plan(makeDoc(), makeProbe());
  const graph = result.filterGraph;
  assert.ok(graph.indexOf("crop=") < graph.indexOf("scale="));
  assert.ok(graph.indexOf("scale=") < graph.indexOf("setsar=1"));
});

test("crop maths rounds to even on awkward sources and fractions", () => {
  // Odd source dimensions and a crop that lands on .5 pixels.
  const doc = makeDoc({ ratio: "1:1", crop: { x: 0.333, y: 0.111, w: 0.777, h: 0.555 } });
  const result = plan(doc, makeProbe({ width: 1081, height: 607 }));
  for (const dimension of numericDimensions(result.filterGraph)) {
    assert.equal(dimension % 2, 0, `${dimension} must be even in ${result.filterGraph}`);
  }
});

test("a non-even canvas is rounded to even and noted", () => {
  const doc = makeDoc({ canvas: { w: 1081, h: 1921 } });
  const result = plan(doc, makeProbe());
  assert.match(result.filterGraph, /scale=1080:1920/);
  assert.ok(result.notes.some((n) => n.includes("rounded")));
});

test("the crop rect never leaves the source frame", () => {
  // A crop whose x+w exceeds 1 must be clamped, not emitted out of bounds.
  const doc = makeDoc({ ratio: "1:1", crop: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080 }));
  const match = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(result.filterGraph);
  assert.ok(match);
  const [, w, h, x, y] = match.map(Number);
  assert.ok(x + w <= 1920, `${x}+${w} must stay inside 1920`);
  assert.ok(y + h <= 1080, `${y}+${h} must stay inside 1080`);
});

test("default transform leaves the crop exactly crop x dimensions", () => {
  const doc = makeDoc({ ratio: "1:1", crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
  const result = plan(doc, makeProbe({ width: 1000, height: 800 }));
  assert.match(result.filterGraph, /crop=500:800:250:0/);
  assert.ok(
    !result.notes.some((n) => n.includes("folded")),
    "nothing should be inferred when the transform is at its defaults"
  );
});

// ── Overlay ──────────────────────────────────────────────────────────────────
test("the overlay is exactly one overlay=0:0 of the rasterised PNG", () => {
  const result = plan(makeDoc(), makeProbe(), { overlayPngPath: "/tmp/ov.png" });
  assert.equal(countOccurrences(result.filterGraph, "overlay=0:0"), 1);
  assert.match(result.filterGraph, /\[1:v\]scale=1080:1920,format=rgba\[vovl\]/);
  assert.ok(hasSequence(result.args, ["-i", "/tmp/ov.png"]));
});

test("no overlay input means no overlay filter and no dangling stream", () => {
  const result = plan(makeDoc(), makeProbe());
  assert.ok(!result.filterGraph.includes("overlay="));
  assert.ok(!result.filterGraph.includes("1:v"));
  assert.deepEqual(labelProblems(result), []);
});

test("drawtext is never emitted", () => {
  for (const ratio of RATIO_KEYS) {
    const result = plan(makeDoc({ ratio }), makeProbe(), { overlayPngPath: "/tmp/ov.png" });
    assert.ok(!result.filterGraph.includes("drawtext"));
  }
});

test("effects apply to the base before the overlay is composited", () => {
  const doc = makeDoc({ effects: [{ type: "grayscale", value: 1 }] });
  const result = plan(doc, makeProbe(), { overlayPngPath: "/tmp/ov.png" });
  const effectAt = result.filterGraph.indexOf("colorchannelmixer");
  const overlayAt = result.filterGraph.indexOf("overlay=0:0");
  assert.ok(effectAt >= 0 && overlayAt >= 0);
  assert.ok(effectAt < overlayAt, "the overlay artwork must not be re-coloured by base effects");
});

// ── HDR ──────────────────────────────────────────────────────────────────────
test("HLG input inserts the tonemap chain and records it", () => {
  const result = plan(makeDoc(), makeProbe({ colorTransfer: "arib-std-b67", colorPrimaries: "bt2020" }));
  assert.ok(result.filterGraph.includes(TONEMAP_FILTERS.join(",")), result.filterGraph);
  assert.ok(result.notes.some((n) => n.toLowerCase().includes("tonemap")));
});

test("PQ and bare bt2020 primaries also tonemap; bt709 does not", () => {
  assert.ok(isHdrProbe({ colorTransfer: "smpte2084", colorPrimaries: null }));
  assert.ok(isHdrProbe({ colorTransfer: null, colorPrimaries: "bt2020" }));
  assert.ok(isHdrProbe({ colorTransfer: "bt2020-10", colorPrimaries: null }));
  assert.ok(!isHdrProbe({ colorTransfer: "bt709", colorPrimaries: "bt709" }));
  assert.ok(!isHdrProbe({ colorTransfer: null, colorPrimaries: null }));

  const sdr = plan(makeDoc(), makeProbe({ colorTransfer: "bt709", colorPrimaries: "bt709" }));
  assert.ok(!sdr.filterGraph.includes("zscale"));
  assert.ok(!sdr.filterGraph.includes("tonemap"));
});

test("tonemapping happens before the effects stage", () => {
  const doc = makeDoc({ effects: [{ type: "saturation", value: 1.4 }] });
  const result = plan(doc, makeProbe({ colorTransfer: "smpte2084" }));
  assert.ok(result.filterGraph.indexOf("tonemap=hable") < result.filterGraph.indexOf("colorchannelmixer"));
});

// ── Effects ──────────────────────────────────────────────────────────────────
test("effects run on an alpha format, because the offset lives in the alpha column", () => {
  // Verified against ffmpeg 8.0.1: colorchannelmixer's ra/ga/ba offset terms are
  // silently DROPPED on a format without alpha (measured 62 vs 190 on mid-grey),
  // so contrast would become a no-op without this format=rgba.
  const doc = makeDoc({ effects: [{ type: "contrast", value: 1.3 }] });
  const result = plan(doc, makeProbe());
  const formatAt = result.filterGraph.indexOf("format=rgba");
  const mixerAt = result.filterGraph.indexOf("colorchannelmixer");
  assert.ok(formatAt >= 0, "effects must be preceded by format=rgba");
  assert.ok(formatAt < mixerAt);
});

test("eq= is never used for brightness or contrast", () => {
  const doc = makeDoc({
    effects: [
      { type: "brightness", value: 1.2 },
      { type: "contrast", value: 0.8 },
    ],
  });
  const result = plan(doc, makeProbe());
  assert.ok(!result.filterGraph.includes("eq="), "eq=brightness is an additive YUV offset, not CSS brightness");
  assert.equal(countOccurrences(result.filterGraph, "colorchannelmixer"), 2);
});

test("blur uses gblur and identity effects emit nothing", () => {
  const blurred = plan(makeDoc({ effects: [{ type: "blur", value: 4 }] }), makeProbe());
  assert.match(blurred.filterGraph, /gblur=sigma=4/);

  // Catalog defaults are no-ops and must not clutter the graph.
  const identity = plan(
    makeDoc({ effects: [{ type: "brightness", value: 1 }, { type: "grayscale", value: 0 }] }),
    makeProbe()
  );
  assert.ok(!identity.filterGraph.includes("colorchannelmixer"));
  assert.ok(!identity.filterGraph.includes("format=rgba"));
});

// ── Audio: the four cases ────────────────────────────────────────────────────
test("case 1: original audio kept, no music -> maps 0:a directly", () => {
  const result = plan(makeDoc(), makeProbe({ hasAudio: true }));
  assert.ok(hasSequence(result.args, ["-map", "0:a"]));
  assert.ok(!result.filterGraph.includes("amix"));
  assert.ok(!result.args.includes("-an"));
  assert.ok(hasSequence(result.args, ["-c:a", "aac", "-b:a", "128k"]));
});

test("case 2: muteOriginal with music maps only the music input", () => {
  const doc = makeDoc({ audio: { trackId: "t1", muteOriginal: true } });
  const result = plan(doc, makeProbe({ hasAudio: true }), { audioPath: "/tmp/music.m4a" });
  assert.ok(!referencesOriginalAudio(result), "the muted original must not be referenced");
  assert.ok(!result.filterGraph.includes("amix"), "one source is not a mix");
  assert.ok(hasSequence(result.args, ["-map", "[amusic]"]));
});

test("case 3: original plus music mixes with amix, original first", () => {
  const doc = makeDoc({ audio: { trackId: "t1", volume: 0.4 } });
  const result = plan(doc, makeProbe({ hasAudio: true }), { audioPath: "/tmp/music.m4a" });
  assert.match(result.filterGraph, /amix=inputs=2:duration=first:dropout_transition=0/);
  // duration=first reads the FIRST input, which must be the -ss/-t bounded original.
  assert.match(result.filterGraph, /\[aorig\]\[amusic\]amix=/);
  // Per-input volume.
  assert.match(result.filterGraph, /\[0:a\]volume=1\[aorig\]/);
  assert.match(result.filterGraph, /volume=0\.4/);
  // amix's default normalize halves every input; the original must stay at unity.
  assert.match(result.filterGraph, /normalize=0/);
});

test("case 4: silent source and no music emits -an and no audio codec", () => {
  const result = plan(makeDoc(), makeProbe({ hasAudio: false }));
  assert.ok(result.args.includes("-an"));
  assert.ok(!referencesOriginalAudio(result));
  assert.ok(!result.args.includes("-c:a"), "no audio stream means no audio encoder");
  assert.ok(!result.filterGraph.includes("amix"));
});

test("case 4b: muted original with no music track also emits -an", () => {
  const doc = makeDoc({ audio: { muteOriginal: true } });
  const result = plan(doc, makeProbe({ hasAudio: true }));
  assert.ok(result.args.includes("-an"));
  assert.ok(!referencesOriginalAudio(result));
});

test("a silent source with music never references 0:a", () => {
  // Referencing ':a' on a silent input is the ffmpeg error
  // "Stream specifier ':a' matches no streams".
  const doc = makeDoc({ audio: { trackId: "t1" } });
  const result = plan(doc, makeProbe({ hasAudio: false }), { audioPath: "/tmp/music.m4a" });
  assert.ok(!referencesOriginalAudio(result));
  assert.ok(!result.filterGraph.includes("amix"), "there is only one real audio input");
  assert.ok(hasSequence(result.args, ["-map", "[amusic]"]));
  assert.ok(hasSequence(result.args, ["-c:a", "aac", "-b:a", "128k"]));
});

test("amix appears only when there are genuinely two audio inputs", () => {
  const cases: Array<{ hasAudio: boolean; mute: boolean; music: boolean; amix: boolean }> = [
    { hasAudio: true, mute: false, music: true, amix: true },
    { hasAudio: true, mute: true, music: true, amix: false },
    { hasAudio: false, mute: false, music: true, amix: false },
    { hasAudio: true, mute: false, music: false, amix: false },
    { hasAudio: false, mute: false, music: false, amix: false },
    { hasAudio: false, mute: true, music: true, amix: false },
  ];
  for (const c of cases) {
    const doc = makeDoc({ audio: { muteOriginal: c.mute, trackId: c.music ? "t1" : null } });
    const result = plan(doc, makeProbe({ hasAudio: c.hasAudio }), {
      audioPath: c.music ? "/tmp/music.m4a" : null,
    });
    assert.equal(
      result.filterGraph.includes("amix"),
      c.amix,
      `amix expectation failed for ${JSON.stringify(c)}: ${result.filterGraph}`
    );
    if (!c.hasAudio) {
      assert.ok(!referencesOriginalAudio(result), `0:a leaked for ${JSON.stringify(c)}`);
    }
  }
});

test("startOffset delays the music on the output timeline", () => {
  const doc = makeDoc({ audio: { trackId: "t1", startOffset: 1.5 } });
  const result = plan(doc, makeProbe(), { audioPath: "/tmp/music.m4a" });
  assert.match(result.filterGraph, /adelay=1500:all=1/);
  // and the track is still bounded to the output length
  assert.match(result.filterGraph, /atrim=0:10/);
});

test("loop uses -stream_loop before the music input, and only the music input", () => {
  const looped = plan(makeDoc({ audio: { trackId: "t1", loop: true } }), makeProbe(), {
    audioPath: "/tmp/music.m4a",
  });
  const loopAt = looped.args.indexOf("-stream_loop");
  assert.ok(loopAt >= 0);
  assert.equal(looped.args[loopAt + 1], "-1");
  // It must bind to the LAST -i (the music), not the video.
  assert.ok(loopAt > looped.args.indexOf("-i"));
  assert.equal(looped.args[looped.args.lastIndexOf("-i") + 1], "/tmp/music.m4a");

  const unlooped = plan(makeDoc({ audio: { trackId: "t1", loop: false } }), makeProbe(), {
    audioPath: "/tmp/music.m4a",
  });
  assert.ok(!unlooped.args.includes("-stream_loop"));
});

test("an unbounded duration disables looping so the render can finish", () => {
  const doc = makeDoc({ audio: { trackId: "t1", loop: true } });
  const result = plan(doc, makeProbe({ durationSeconds: 0 }), { audioPath: "/tmp/music.m4a" });
  assert.ok(!result.args.includes("-stream_loop"), "an infinite loop with no -t never finishes");
  assert.ok(!result.args.includes("-t"));
  assert.ok(result.notes.some((n) => n.includes("looping disabled")));
});

// ── Trim ─────────────────────────────────────────────────────────────────────
test("trim uses accurate input seeking and an output duration", () => {
  const doc = makeDoc({ trim: { start: 2.5, end: 7.25 } });
  const result = plan(doc, makeProbe({ durationSeconds: 30 }));

  const inputAt = result.args.indexOf("-i");
  assert.ok(result.args.indexOf("-accurate_seek") < inputAt, "accurate, not keyframe-snapped");
  assert.ok(result.args.indexOf("-ss") < inputAt, "-ss is an input option here");
  assert.equal(argValue(result.args, "-ss"), "2.5");
  assert.equal(argValue(result.args, "-t"), "4.75");
  assert.ok(result.args.indexOf("-t") > result.args.indexOf("-filter_complex"), "-t is an output option");
  approx(result.expectedDurationSeconds, 4.75);
});

test("trim clamps past the source end", () => {
  const doc = makeDoc({ trim: { start: 2, end: 999 } });
  const result = plan(doc, makeProbe({ durationSeconds: 10 }));
  approx(result.expectedDurationSeconds, 8);
  assert.equal(argValue(result.args, "-t"), "8");
  assert.ok(result.notes.some((n) => n.includes("clamped")));
});

test("a start past the source end resets instead of rendering nothing", () => {
  const doc = makeDoc({ trim: { start: 99, end: 120 } });
  const result = plan(doc, makeProbe({ durationSeconds: 10 }));
  assert.ok(result.expectedDurationSeconds > 0, "must never plan a zero-length render");
  approx(result.expectedDurationSeconds, 10);
});

test("an inverted or empty trim range extends to the source end", () => {
  const doc = makeDoc({ trim: { start: 6, end: 3 } });
  const result = plan(doc, makeProbe({ durationSeconds: 10 }));
  approx(result.expectedDurationSeconds, 4);
  assert.ok(result.notes.some((n) => n.includes("at or before")));
});

test("no trim means no -ss and the full source duration", () => {
  const result = plan(makeDoc({ trim: null }), makeProbe({ durationSeconds: 12.5 }));
  assert.ok(!result.args.includes("-ss"));
  assert.equal(argValue(result.args, "-t"), "12.5");
  approx(result.expectedDurationSeconds, 12.5);
});

// ── Fades against the FINAL duration ─────────────────────────────────────────
test("fades are computed from the trimmed duration, not the source duration", () => {
  const doc = makeDoc({ trim: { start: 5, end: 13 }, audio: { fadeIn: 1, fadeOut: 2 } });
  const result = plan(doc, makeProbe({ durationSeconds: 30, hasAudio: true }));

  approx(result.expectedDurationSeconds, 8);
  assert.match(result.filterGraph, /afade=t=in:st=0:d=1/);
  // 8s output - 2s fade = start at 6s, NOT 30 - 2 = 28s.
  assert.match(result.filterGraph, /afade=t=out:st=6:d=2/);
  assert.ok(!result.filterGraph.includes("st=28"), "a source-relative fade would never fire");
});

test("fades apply to the mixed result when there is music too", () => {
  const doc = makeDoc({ trim: { start: 0, end: 4 }, audio: { trackId: "t1", fadeOut: 1 } });
  const result = plan(doc, makeProbe({ durationSeconds: 20 }), { audioPath: "/tmp/m.m4a" });
  assert.match(result.filterGraph, /\[amix\]afade=t=out:st=3:d=1\[aout\]/);
  assert.ok(hasSequence(result.args, ["-map", "[aout]"]));
});

test("a fadeOut longer than the clip is clamped", () => {
  const doc = makeDoc({ trim: { start: 0, end: 3 }, audio: { fadeOut: 10 } });
  const result = plan(doc, makeProbe({ durationSeconds: 20 }));
  assert.match(result.filterGraph, /afade=t=out:st=0:d=3/);
  assert.ok(result.notes.some((n) => n.includes("fadeOut")));
});

test("fades on a silent source with no music produce no audio chain at all", () => {
  const doc = makeDoc({ audio: { fadeIn: 1, fadeOut: 1 } });
  const result = plan(doc, makeProbe({ hasAudio: false }));
  assert.ok(result.args.includes("-an"));
  assert.ok(!result.filterGraph.includes("afade"));
  assert.ok(!referencesOriginalAudio(result));
});

// ── Output settings ──────────────────────────────────────────────────────────
test("the prescribed encoder settings are emitted verbatim", () => {
  const result = plan(makeDoc(), makeProbe());
  assert.ok(
    hasSequence(result.args, [
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
    ])
  );
  assert.ok(hasSequence(result.args, ["-movflags", "+faststart"]));
  assert.ok(hasSequence(result.args, ["-c:a", "aac", "-b:a", "128k"]));
  assert.equal(result.args[result.args.length - 1], "/tmp/out.mp4");
  assert.equal(argValue(result.args, "-filter_complex"), result.filterGraph);
});

test("the graph always ends in yuv420p on the mapped video label", () => {
  for (const overlay of [null, "/tmp/ov.png"]) {
    const result = plan(makeDoc(), makeProbe(), { overlayPngPath: overlay });
    assert.match(result.filterGraph, /format=yuv420p\[vout\]/);
    assert.ok(hasSequence(result.args, ["-map", "[vout]"]));
  }
});

// ── fit modes ────────────────────────────────────────────────────────────────
test("contain-color pads to the canvas background with even sizes", () => {
  const doc = makeDoc({ ratio: "9:16", fit: "contain-color" });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080 }));
  assert.match(result.filterGraph, /force_original_aspect_ratio=decrease:force_divisible_by=2/);
  assert.match(result.filterGraph, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:#101010/);
  for (const d of numericDimensions(result.filterGraph)) assert.equal(d % 2, 0);
});

test("contain-blur composes a blurred bed without a second overlay=0:0", () => {
  const doc = makeDoc({ ratio: "9:16", fit: "contain-blur" });
  const result = plan(doc, makeProbe({ width: 1920, height: 1080 }), { overlayPngPath: "/tmp/ov.png" });
  assert.match(result.filterGraph, /split=2/);
  assert.match(result.filterGraph, /gblur=sigma=/);
  assert.equal(countOccurrences(result.filterGraph, "overlay=0:0"), 1);
  assert.deepEqual(labelProblems(result), []);
});

// ── Graph hygiene sweep ──────────────────────────────────────────────────────
test("validateFilterGraph catches the malformed shapes it is meant to", () => {
  assert.deepEqual(validateFilterGraph("[0:v]null[vout]"), []);
  assert.ok(validateFilterGraph("").length > 0);
  assert.ok(validateFilterGraph("[0:v]crop=2:2,,scale=4:4[v]").length > 0);
  assert.ok(validateFilterGraph("[0:v]a[x];;[x]b[y]").length > 0);
  assert.ok(validateFilterGraph(",[0:v]a[x]").length > 0);
  assert.ok(validateFilterGraph("[0:v]a[x];").length > 0);
  assert.ok(validateFilterGraph("[0:v]a[x];[x]b[y],").length > 0);
});

test("no combination of document options produces a malformed graph", () => {
  const effectSets: Effect[][] = [
    [],
    [
      { type: "brightness", value: 1.2 },
      { type: "contrast", value: 0.85 },
      { type: "saturation", value: 1.3 },
      { type: "grayscale", value: 0.5 },
      { type: "sepia", value: 0.3 },
      { type: "blur", value: 3.5 },
    ],
  ];
  const fits: Array<"cover" | "contain-blur" | "contain-color"> = [
    "cover",
    "contain-blur",
    "contain-color",
  ];
  let checked = 0;

  for (const ratio of RATIO_KEYS) {
    for (const fit of fits) {
      for (const rotation of [0, 90, 180, 270]) {
        for (const hasAudio of [true, false]) {
          for (const music of [true, false]) {
            for (const overlay of [true, false]) {
              for (const effects of effectSets) {
                for (const hdr of [true, false]) {
                  for (const trim of [null, { start: 1.25, end: 6.5 }]) {
                    for (const mute of [true, false]) {
                      for (const fades of [true, false]) {
                        const doc = makeDoc({
                          ratio,
                          fit,
                          trim,
                          effects,
                          crop: { x: 0.1, y: 0.05, w: 0.85, h: 0.9 },
                          audio: {
                            trackId: music ? "t1" : null,
                            muteOriginal: mute,
                            volume: 0.6,
                            startOffset: music ? 0.5 : 0,
                            fadeIn: fades ? 0.5 : 0,
                            fadeOut: fades ? 0.75 : 0,
                            loop: true,
                          },
                        });
                        const result = plan(
                          doc,
                          makeProbe({
                            width: 1920,
                            height: 1080,
                            rotation,
                            hasAudio,
                            durationSeconds: 11,
                            colorTransfer: hdr ? "arib-std-b67" : "bt709",
                            colorPrimaries: hdr ? "bt2020" : "bt709",
                          }),
                          {
                            overlayPngPath: overlay ? "/tmp/ov.png" : null,
                            audioPath: music ? "/tmp/m.m4a" : null,
                          }
                        );
                        checked++;

                        const label = `${ratio}/${fit}/rot${rotation}/a${hasAudio}/m${music}/o${overlay}/e${effects.length}/hdr${hdr}/t${!!trim}/mute${mute}/f${fades}`;
                        assert.deepEqual(validateFilterGraph(result.filterGraph), [], label);
                        assert.deepEqual(labelProblems(result), [], label);

                        for (const d of numericDimensions(result.filterGraph)) {
                          assert.equal(d % 2, 0, `${label}: odd dimension ${d}`);
                        }
                        assert.equal(
                          countOccurrences(result.filterGraph, "overlay=0:0"),
                          overlay ? 1 : 0,
                          label
                        );
                        assert.ok(!result.filterGraph.includes("drawtext"), label);
                        assert.ok(!result.filterGraph.includes("eq="), label);
                        if (!hasAudio || mute) {
                          assert.ok(!referencesOriginalAudio(result), `${label}: 0:a leaked`);
                        }
                        assert.ok(result.expectedDurationSeconds >= 0, label);
                        for (const arg of result.args) {
                          assert.equal(typeof arg, "string", label);
                          assert.notEqual(arg, "", `${label}: empty argv entry`);
                        }
                        // Exactly one audio decision.
                        const audioMaps = result.args.filter(
                          (a, i) => result.args[i - 1] === "-map" && (a.includes(":a") || a.includes("a"))
                        );
                        if (result.args.includes("-an")) {
                          assert.equal(audioMaps.length, 0, `${label}: -an with an audio map`);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, `expected a broad sweep, checked ${checked}`);
});

// ── parseProgress ────────────────────────────────────────────────────────────
test("parseProgress reads the -stats clock", () => {
  // The exact shape ffmpeg 8.0.1 emits with -loglevel error -stats.
  const line =
    "frame=  370 fps=0.0 q=28.0 size=    1024KiB time=00:00:12.34 bitrate= 679.9kbits/s speed=24.6x";
  approx(parseProgress(line, 100)!, 12.34);
  approx(parseProgress("time=00:00:12.34", 100)!, 12.34);
  approx(parseProgress("time=00:01:02.50", 125)!, 50);
});

test("parseProgress clamps to 0..100", () => {
  assert.equal(parseProgress("time=00:00:30.00", 10), 100);
  assert.equal(parseProgress("time=00:00:00.00", 10), 0);
  // ffmpeg emits a negative clock from an unset pts before the first frame.
  assert.equal(parseProgress("time=-00:00:00.01", 10), 0);
});

test("parseProgress returns null for junk and unusable totals", () => {
  assert.equal(parseProgress("Lorem ipsum dolor", 10), null);
  assert.equal(parseProgress("", 10), null);
  assert.equal(parseProgress("time=N/A", 10), null);
  // VERIFIED: ffmpeg 8.0.1 really does emit this line, twice, before the first
  // packet is muxed. Reporting 0% for it would make the bar jump backwards.
  assert.equal(
    parseProgress(
      "frame=   55 fps= 55 q=26.0 size=       0KiB time=N/A bitrate=N/A speed=N/A elapsed=0:00:01.00",
      10
    ),
    null
  );
  assert.equal(parseProgress("time=garbage", 10), null);
  assert.equal(parseProgress("frame= 10 fps=5 q=20.0 size=1kB bitrate=1.0kbits/s", 10), null);
  // An unknown total cannot produce a percentage.
  assert.equal(parseProgress("time=00:00:05.00", 0), null);
  assert.equal(parseProgress("time=00:00:05.00", Number.NaN), null);
  assert.equal(parseProgress("time=00:00:05.00", -1), null);
});

test("parseProgress also understands -progress pipe output", () => {
  // out_time= contains time=, and out_time_us is microseconds.
  approx(parseProgress("out_time=00:00:05.000000", 10)!, 50);
  approx(parseProgress("out_time_us=5000000", 10)!, 50);
  approx(parseProgress("out_time_ms=5000000", 10)!, 50);
});

// ── Notes ────────────────────────────────────────────────────────────────────
test("notes explain the decisions a human would want to audit", () => {
  const doc = makeDoc({ trim: { start: 1, end: 99 }, audio: { trackId: "t1" } });
  const result = plan(doc, makeProbe({ rotation: 90, colorTransfer: "arib-std-b67" }), {
    overlayPngPath: "/tmp/ov.png",
    audioPath: "/tmp/m.m4a",
  });
  const joined = result.notes.join(" | ");
  assert.match(joined, /de-rotated/);
  assert.match(joined, /tonemap/i);
  assert.match(joined, /clamped/);
  assert.match(joined, /overlay/i);
  assert.match(joined, /amix/);
});
