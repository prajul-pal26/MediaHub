import { unitOf, type EditDoc } from "./doc";
import { effectsToFfmpegFilters } from "./effects";

/**
 * The video render planner: an Edit Document in, one exact ffmpeg argv out.
 *
 * Nothing here spawns a process or touches the filesystem, so the whole render
 * decision tree is unit-testable without ffmpeg installed. The worker owns
 * execution; this module owns *what* gets executed.
 *
 * Every ordering choice below is load-bearing. The ones that were verified
 * against real ffmpeg 8.0.1 rather than reasoned about are marked VERIFIED.
 */

// ── Formatting ───────────────────────────────────────────────────────────────
/**
 * Deterministic decimals. ffmpeg's expression parser rejects exponent notation,
 * so `1e-7` must never reach a filter string.
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Number(n.toFixed(6));
  if (Object.is(rounded, -0)) return "0";
  return rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// libx264 + yuv420p rejects odd dimensions, so every emitted size is even.
// Sizes and offsets need different floors: a dimension of 0 is not encodable,
// but an offset of 0 is the commonest valid value there is.

/** Even, >= 2, nearest. For sizes where framing fidelity matters. */
function evenSizeNearest(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Even, >= 2, never larger than `n`. For the output canvas: never invent pixels. */
function evenSizeFloor(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Even, >= 0, nearest. For crop offsets, where 0 is valid. */
function evenOffset(n: number): number {
  return Math.max(0, Math.round(n / 2) * 2);
}

/** Even, >= 0, floored. The source bound a crop has to stay inside. */
function evenBound(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2);
}

// ── Probe ────────────────────────────────────────────────────────────────────
export interface ProbeResult {
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  /**
   * Degrees of **clockwise** rotation the stored frame needs in order to
   * display correctly, normalised to one of 0/90/180/270 where possible.
   *
   * This is ffmpeg's internal `theta`, NOT ffprobe's raw `rotation` field.
   * ffprobe prints `av_display_rotation_get()`, which is the *counter*-clockwise
   * angle of the display transform; ffmpeg's autorotate negates it. Storing the
   * clockwise angle is what lets `derotationFilters` map straight onto a
   * transpose chain.
   *
   * VERIFIED: a file whose ffprobe `rotation` is 90 yields 270 here, and
   * `transpose=cclock` on it is bit-identical to ffmpeg's own autorotate output.
   */
  rotation: number;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** ffprobe emits numbers as strings, and "N/A" for anything it could not read. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "N/A") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Collapse ffprobe's several spellings of "I don't know" to null. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "N/A" || trimmed.toLowerCase() === "unknown") {
    return null;
  }
  return trimmed;
}

/** Snap to an orthogonal angle within ffmpeg's own 1-degree tolerance. */
function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  for (const candidate of [0, 90, 180, 270]) {
    if (Math.abs(wrapped - candidate) < 1) return candidate;
  }
  if (Math.abs(wrapped - 360) < 1) return 0;
  return wrapped;
}

function displayMatrixRotation(stream: Record<string, unknown>): number | null {
  const list = stream.side_data_list;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const type = str(record.side_data_type) ?? "";
    const rotation = num(record.rotation);
    if (rotation === null) continue;
    if (type.toLowerCase().includes("display matrix") || type === "") return rotation;
    return rotation;
  }
  return null;
}

/**
 * Read the fields the planner needs out of `ffprobe -show_streams -show_format`
 * JSON. Tolerates a raw JSON string, missing sections and "N/A" values rather
 * than throwing, because a half-readable probe still renders fine.
 */
export function parseProbe(ffprobeJson: unknown): ProbeResult {
  let root = asRecord(ffprobeJson);
  if (!root && typeof ffprobeJson === "string") {
    try {
      root = asRecord(JSON.parse(ffprobeJson));
    } catch {
      root = null;
    }
  }

  const streams = Array.isArray(root?.streams) ? (root!.streams as unknown[]) : [];
  const records = streams.map(asRecord).filter((s): s is Record<string, unknown> => s !== null);

  const video = records.find((s) => str(s.codec_type) === "video") ?? null;
  const hasAudio = records.some((s) => str(s.codec_type) === "audio");

  const width = video ? (num(video.width) ?? 0) : 0;
  const height = video ? (num(video.height) ?? 0) : 0;

  // Prefer the video stream's own duration: `format.duration` is the longest
  // stream, so a music bed longer than the picture would let a trim run past
  // the end of the video and render black tail frames.
  const format = asRecord(root?.format);
  const streamDuration = video ? num(video.duration) : null;
  const formatDuration = format ? num(format.duration) : null;
  const durationSeconds = Math.max(0, streamDuration ?? formatDuration ?? 0);

  // Mirror ffmpeg's own precedence: a non-zero legacy `rotate` tag wins over
  // the display matrix, and the tag is already a clockwise angle.
  let rotation = 0;
  if (video) {
    const tags = asRecord(video.tags);
    const rotateTag = tags ? num(tags.rotate) : null;
    if (rotateTag !== null && rotateTag !== 0) {
      rotation = normalizeRotation(rotateTag);
    } else {
      const matrix = displayMatrixRotation(video);
      if (matrix !== null) rotation = normalizeRotation(-matrix);
    }
  }

  return {
    width,
    height,
    durationSeconds,
    hasAudio,
    rotation,
    colorTransfer: video ? str(video.color_transfer) : null,
    colorPrimaries: video ? str(video.color_primaries) : null,
  };
}

// ── HDR ──────────────────────────────────────────────────────────────────────
/**
 * The exact chain the brief prescribes. Without it iPhone HDR (HLG) renders as
 * washed-out grey, because the BT.2020 code values get interpreted as BT.709.
 */
export const TONEMAP_FILTERS: readonly string[] = [
  "zscale=t=linear:npl=100",
  "tonemap=hable",
  "zscale=p=bt709:t=bt709:m=bt709:r=tv",
  "format=yuv420p",
];

export function isHdrProbe(probe: Pick<ProbeResult, "colorTransfer" | "colorPrimaries">): boolean {
  const transfer = (probe.colorTransfer ?? "").toLowerCase();
  const primaries = (probe.colorPrimaries ?? "").toLowerCase();
  // HLG and PQ respectively, plus the wide-gamut primaries that imply HDR even
  // when the transfer characteristic was not written.
  if (transfer.includes("arib-std-b67") || transfer.includes("smpte2084")) return true;
  if (transfer.startsWith("bt2020")) return true;
  if (primaries.startsWith("bt2020")) return true;
  return false;
}

// ── Rotation ─────────────────────────────────────────────────────────────────
/**
 * The filters that undo a display-matrix rotation, given the clockwise angle
 * from `ProbeResult.rotation`.
 *
 * Non-orthogonal angles return no filters, mirroring ffmpeg's autorotate, which
 * only handles 90/180/270. Guessing with a `rotate=` filter there would change
 * the frame size unpredictably and break the crop maths.
 */
export function derotationFilters(rotation: number): string[] {
  switch (normalizeRotation(rotation)) {
    case 90:
      return ["transpose=clock"];
    case 180:
      return ["hflip", "vflip"];
    case 270:
      return ["transpose=cclock"];
    default:
      return [];
  }
}

function derotatedSize(
  width: number,
  height: number,
  rotation: number
): { w: number; h: number } {
  const normalized = normalizeRotation(rotation);
  return normalized === 90 || normalized === 270 ? { w: height, h: width } : { w: width, h: height };
}

// ── Filter graph assembly ────────────────────────────────────────────────────
/** Drops empties so a skipped filter can never leave a doubled `,`. */
function joinFilters(filters: string[]): string {
  return filters.filter((f) => typeof f === "string" && f.trim() !== "").join(",");
}

/**
 * A malformed filtergraph is the most common silent failure in this whole
 * pipeline, so the plan validates its own output before returning it.
 */
export function validateFilterGraph(graph: string): string[] {
  const problems: string[] = [];
  if (graph.trim() === "") {
    problems.push("filter graph is empty");
    return problems;
  }
  if (/[,;]\s*[,;]/.test(graph)) problems.push("filter graph has doubled , or ; separators");
  if (/^[,;]/.test(graph)) problems.push("filter graph starts with a separator");
  if (/[,;]$/.test(graph)) problems.push("filter graph ends with a separator");
  const chains = graph.split(";");
  for (const chain of chains) {
    if (chain.trim() === "") problems.push("filter graph contains an empty chain");
  }
  // Every label must be consumed somewhere, or ffmpeg exits with
  // "Output with label '...' does not exist in any defined filter graph".
  return problems;
}

// ── Crop ─────────────────────────────────────────────────────────────────────
interface CropPixels {
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * `doc.base.crop` is normalised against the **de-rotated** source, because that
 * is the orientation the browser preview shows (browsers apply the display
 * matrix themselves). Cropping before de-rotating cuts the wrong region on
 * every phone portrait video.
 *
 * `base.transform.scale/offsetX/offsetY` are folded in here as a zoom and pan
 * of that rect rather than emitted as separate filters, which keeps the whole
 * framing decision in one `crop=`.
 *
 * NOTE for reconciliation with the preview renderer: `scale` is treated as a
 * zoom about the crop centre, and `offsetX`/`offsetY` as fractions of the
 * de-rotated source. With the schema defaults (scale 1, offsets 0) this is
 * exactly `crop x dimensions` and nothing is inferred.
 */
function resolveCrop(
  doc: EditDoc,
  source: { w: number; h: number },
  notes: string[]
): CropPixels {
  const raw = doc.base.crop;
  const transform = doc.base.transform;

  let w = raw.w > 0 ? clamp(raw.w, 0, 1) : 1;
  let h = raw.h > 0 ? clamp(raw.h, 0, 1) : 1;
  let x = clamp(raw.x, 0, 1);
  let y = clamp(raw.y, 0, 1);

  const scale = Number.isFinite(transform.scale) && transform.scale > 0 ? transform.scale : 1;
  if (scale !== 1) {
    const centreX = x + w / 2;
    const centreY = y + h / 2;
    w = Math.min(1, w / scale);
    h = Math.min(1, h / scale);
    x = centreX - w / 2;
    y = centreY - h / 2;
    notes.push(`base.transform.scale ${fmt(scale)} folded into the crop rect as a zoom`);
  }

  if (transform.offsetX !== 0 || transform.offsetY !== 0) {
    x += transform.offsetX;
    y += transform.offsetY;
    notes.push(
      `base.transform offset (${fmt(transform.offsetX)}, ${fmt(transform.offsetY)}) folded into the crop rect as a pan`
    );
  }

  x = clamp(x, 0, Math.max(0, 1 - w));
  y = clamp(y, 0, Math.max(0, 1 - h));

  // Even in every component: odd sizes break libx264/yuv420p, and odd offsets
  // land the crop on a half chroma sample.
  const maxW = evenBound(source.w);
  const maxH = evenBound(source.h);
  const cw = clamp(evenSizeNearest(w * source.w), 2, Math.max(2, maxW));
  const ch = clamp(evenSizeNearest(h * source.h), 2, Math.max(2, maxH));
  const cx = clamp(evenOffset(x * source.w), 0, Math.max(0, maxW - cw));
  const cy = clamp(evenOffset(y * source.h), 0, Math.max(0, maxH - ch));

  return { w: cw, h: ch, x: cx, y: cy };
}

// ── Trim ─────────────────────────────────────────────────────────────────────
interface ResolvedTrim {
  start: number;
  duration: number;
  /** False when the probe gave no usable duration, in which case `-t` is omitted. */
  bounded: boolean;
}

function resolveTrim(doc: EditDoc, probe: ProbeResult, notes: string[]): ResolvedTrim {
  const sourceDuration =
    Number.isFinite(probe.durationSeconds) && probe.durationSeconds > 0 ? probe.durationSeconds : 0;

  if (sourceDuration <= 0) {
    notes.push("probe reported no usable duration; -t omitted and audio looping disabled");
    return { start: 0, duration: 0, bounded: false };
  }

  const trim = doc.base.trim;
  if (!trim) return { start: 0, duration: sourceDuration, bounded: true };

  let start = clamp(trim.start, 0, sourceDuration);
  if (start >= sourceDuration) {
    notes.push(
      `trim.start ${fmt(trim.start)}s is at or past the source end ${fmt(sourceDuration)}s; reset to 0`
    );
    start = 0;
  }

  let end = clamp(trim.end, 0, sourceDuration);
  if (trim.end > sourceDuration) {
    notes.push(
      `trim.end ${fmt(trim.end)}s clamped to the source duration ${fmt(sourceDuration)}s`
    );
  }
  if (end <= start) {
    notes.push(
      `trim.end ${fmt(trim.end)}s is at or before trim.start ${fmt(start)}s; extended to the source end`
    );
    end = sourceDuration;
  }

  return { start, duration: end - start, bounded: true };
}

// ── Plan ─────────────────────────────────────────────────────────────────────
export interface PlanInput {
  doc: EditDoc;
  probe: ProbeResult;
  inputVideoPath: string;
  /** The browser-rasterised overlay stack, already one flattened PNG. */
  overlayPngPath?: string | null;
  audioPath?: string | null;
  outputPath: string;
}

export interface RenderPlan {
  args: string[];
  filterGraph: string;
  expectedDurationSeconds: number;
  notes: string[];
}

export function buildRenderPlan(input: PlanInput): RenderPlan {
  const { doc, probe } = input;
  const notes: string[] = [];

  if (doc.base.kind === "image") {
    notes.push("doc.base.kind is image; this planner targets video and assumes a video input");
  }

  // ── Canvas ──
  const canvasW = evenSizeFloor(doc.canvas.w);
  const canvasH = evenSizeFloor(doc.canvas.h);
  if (canvasW !== doc.canvas.w || canvasH !== doc.canvas.h) {
    notes.push(
      `canvas ${doc.canvas.w}x${doc.canvas.h} rounded to ${canvasW}x${canvasH} for libx264/yuv420p`
    );
  }

  // ── Trim ──
  const trim = resolveTrim(doc, probe, notes);
  const outDuration = trim.duration;

  // ── Rotation, then crop against the de-rotated frame ──
  const rotation = normalizeRotation(probe.rotation);
  const derotate = derotationFilters(rotation);
  if (rotation !== 0 && derotate.length === 0) {
    notes.push(
      `display rotation ${fmt(rotation)} deg is not orthogonal; left uncorrected (matches ffmpeg autorotate)`
    );
  } else if (rotation !== 0) {
    notes.push(`de-rotated ${fmt(rotation)} deg clockwise before cropping (${derotate.join(",")})`);
  }
  const source = derotatedSize(probe.width, probe.height, rotation);
  const crop = resolveCrop(doc, source, notes);

  // ── Video chain ──
  const preFit: string[] = [...derotate];
  const transform = doc.base.transform;
  if (transform.flipH) preFit.push("hflip");
  if (transform.flipV) preFit.push("vflip");

  const userRotate = normalizeRotation(transform.rotate);
  if (transform.rotate !== 0) {
    const userFilters = derotationFilters(userRotate);
    if (userFilters.length > 0) {
      preFit.push(...userFilters);
      notes.push(`applied base.transform.rotate ${fmt(userRotate)} deg`);
    } else {
      notes.push(
        `base.transform.rotate ${fmt(transform.rotate)} deg is not a multiple of 90 and was skipped`
      );
    }
  }

  // A user 90/270 rotate swaps the frame again, so crop before it would be
  // measured against the wrong axis. Crop sits immediately after de-rotation
  // and before the user rotate for exactly that reason.
  preFit.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);

  const chains: string[] = [];
  const backgroundColor = doc.canvas.background.color || "#000000";

  if (doc.base.fit === "contain-blur") {
    // Two contexts over one split: a cover-cropped blurred bed, and the whole
    // cropped frame fitted inside it.
    const sigma = Math.max(8, Math.round(unitOf({ w: canvasW, h: canvasH }) * 0.02));
    chains.push(`[0:v]${joinFilters([...preFit, "split=2"])}[vbg][vfg]`);
    chains.push(
      `[vbg]${joinFilters([
        `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:force_divisible_by=2`,
        `crop=${canvasW}:${canvasH}:(in_w-out_w)/2:(in_h-out_h)/2`,
        `gblur=sigma=${sigma}`,
        "setsar=1",
      ])}[vbgb]`
    );
    chains.push(
      `[vfg]${joinFilters([
        `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "setsar=1",
      ])}[vfgs]`
    );
    chains.push(`[vbgb][vfgs]overlay=(W-w)/2:(H-h)/2[vbase]`);
    notes.push(`fit contain-blur: blurred bed at sigma ${sigma}`);
  } else if (doc.base.fit === "contain-color") {
    chains.push(
      `[0:v]${joinFilters([
        ...preFit,
        // force_divisible_by=2 is what keeps a "decrease" fit from producing an
        // odd intermediate size that libx264 would then reject.
        `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:${backgroundColor}`,
        "setsar=1",
      ])}[vbase]`
    );
    notes.push(`fit contain-color: padded to ${backgroundColor}`);
  } else {
    chains.push(
      `[0:v]${joinFilters([...preFit, `scale=${canvasW}:${canvasH}`, "setsar=1"])}[vbase]`
    );
  }

  // ── Tonemap + effects, applied to the base only ──
  // The overlay PNG was rasterised by the browser with the effects already
  // baked into nothing (layers are not filtered), so effects must land before
  // the overlay composite, exactly as the CSS preview filters only the media
  // element.
  const post: string[] = [];
  const hdr = isHdrProbe(probe);
  if (hdr) {
    post.push(...TONEMAP_FILTERS);
    notes.push(
      `tonemapped HDR input (transfer=${probe.colorTransfer ?? "unknown"}, primaries=${probe.colorPrimaries ?? "unknown"})`
    );
  }

  const effectFilters = effectsToFfmpegFilters(doc.effects);
  if (effectFilters.length > 0) {
    // Known, deliberate redundancy: on an HDR source this produces
    // `...,format=yuv420p,format=rgba,...` because TONEMAP_FILTERS ends with the
    // prescribed format=yuv420p. It costs one extra chroma subsample round trip
    // on HDR-plus-effects renders only. Kept because the tonemap chain is
    // specified verbatim; drop that trailing entry if the two are ever merged.
    // VERIFIED, and non-obvious: effects.ts carries the brightness/contrast
    // additive offset in colorchannelmixer's alpha-origin column (ra/ga/ba).
    // On a pixel format without alpha, ffmpeg silently DROPS those terms --
    // measured 62 vs 190 on a mid-grey source for the same filter. So the
    // effects chain must run on an alpha-bearing format or contrast becomes a
    // no-op that nobody notices until the render looks wrong.
    post.push("format=rgba");
    post.push(...effectFilters);
    notes.push(`${effectFilters.length} effect filter(s) applied on rgba (alpha-column offsets)`);
  }

  // ── Inputs ──
  let nextInput = 1;
  const overlayPath =
    typeof input.overlayPngPath === "string" && input.overlayPngPath.trim() !== ""
      ? input.overlayPngPath
      : null;
  const overlayIndex = overlayPath !== null ? nextInput++ : null;

  const musicPath =
    typeof input.audioPath === "string" && input.audioPath.trim() !== "" ? input.audioPath : null;
  const musicIndex = musicPath !== null ? nextInput++ : null;

  if (overlayIndex !== null) {
    // The effect/tonemap stage lands on the base BEFORE the composite, so the
    // overlay artwork is never re-coloured by the base's effects.
    chains.push(`[vbase]${joinFilters(post.length > 0 ? post : ["null"])}[vfx]`);
    chains.push(
      `[${overlayIndex}:v]${joinFilters([`scale=${canvasW}:${canvasH}`, "format=rgba"])}[vovl]`
    );
    // eof_action=repeat holds the single decoded PNG frame for the whole clip,
    // which is why the overlay input needs no -loop and no shortest=1.
    chains.push(
      `[vfx][vovl]${joinFilters([
        "overlay=0:0:eof_action=repeat:format=auto",
        "format=yuv420p",
      ])}[vout]`
    );
    notes.push("composited the pre-rasterised overlay PNG (no drawtext)");
  } else {
    chains.push(`[vbase]${joinFilters([...post, "format=yuv420p"])}[vout]`);
  }

  // ── Audio ──
  const audio = doc.audio;
  const keepOriginal = probe.hasAudio && !audio.muteOriginal;
  const hasMusic = musicIndex !== null;

  if (!probe.hasAudio) notes.push("source has no audio stream; 0:a is never referenced");
  if (audio.muteOriginal && probe.hasAudio) notes.push("original audio muted by the document");

  const fadeIn = Math.max(0, audio.fadeIn);
  let fadeOut = Math.max(0, audio.fadeOut);
  if (trim.bounded && fadeOut > outDuration) {
    notes.push(`audio.fadeOut ${fmt(audio.fadeOut)}s clamped to the output duration`);
    fadeOut = outDuration;
  }
  if (fadeOut > 0 && !trim.bounded) {
    notes.push("audio.fadeOut skipped: the output duration is unknown");
    fadeOut = 0;
  }

  let audioMapLabel: string | null = null;
  let audioDirectMap: string | null = null;
  const loopMusic = hasMusic && audio.loop && trim.bounded;

  if (!keepOriginal && !hasMusic) {
    notes.push("no audio anywhere; emitting -an");
  } else if (hasMusic) {
    const music: string[] = [];
    if (audio.startOffset > 0) {
      // startOffset places the track on the OUTPUT timeline (the music starts
      // this far into the clip), which is why it is a delay and not an atrim
      // into the source.
      music.push(`adelay=${Math.round(audio.startOffset * 1000)}:all=1`);
      notes.push(`music delayed ${fmt(audio.startOffset)}s into the clip`);
    }
    if (trim.bounded) {
      // Bounds a looped track, and stops a long track from extending the file.
      music.push(`atrim=0:${fmt(outDuration)}`);
    }
    if (audio.volume !== 1) music.push(`volume=${fmt(audio.volume)}`);

    chains.push(`[${musicIndex}:a]${joinFilters(music.length > 0 ? music : ["anull"])}[amusic]`);

    if (keepOriginal) {
      // The original must be amix input #1 because `duration=first` reads the
      // first input, and the original is the stream already bounded by -ss/-t.
      chains.push(`[0:a]volume=1[aorig]`);
      chains.push(
        `[aorig][amusic]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`
      );
      audioMapLabel = "[amix]";
      // normalize=0 matters: amix's default divides every input by the input
      // count, so the original would come back at half volume.
      notes.push("mixed original audio with the music track (amix, normalize=0)");
    } else {
      audioMapLabel = "[amusic]";
      notes.push("music track only; original audio not mapped");
    }
  } else {
    if (fadeIn > 0 || fadeOut > 0) {
      audioMapLabel = "[0:a]";
    } else {
      audioDirectMap = "0:a";
      notes.push("original audio mapped directly");
    }
  }

  if (audioMapLabel !== null && (fadeIn > 0 || fadeOut > 0)) {
    const fades: string[] = [];
    if (fadeIn > 0) fades.push(`afade=t=in:st=0:d=${fmt(fadeIn)}`);
    if (fadeOut > 0) {
      // Fades are measured against the FINAL output duration, not the source.
      fades.push(`afade=t=out:st=${fmt(Math.max(0, outDuration - fadeOut))}:d=${fmt(fadeOut)}`);
    }
    chains.push(`${audioMapLabel}${joinFilters(fades)}[aout]`);
    audioMapLabel = "[aout]";
    notes.push(`audio fades computed against the ${fmt(outDuration)}s output duration`);
  }

  const hasAudioOutput = audioMapLabel !== null || audioDirectMap !== null;

  // ── Graph ──
  const filterGraph = chains.filter((c) => c.trim() !== "").join(";");
  const problems = validateFilterGraph(filterGraph);
  if (problems.length > 0) {
    throw new Error(`buildRenderPlan produced a malformed filter graph: ${problems.join("; ")}`);
  }

  // ── Argv ──
  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-stats"];

  // VERIFIED, and the single most dangerous default in this pipeline:
  //   * ffmpeg autorotates by DEFAULT, so our explicit transpose would rotate
  //     a phone video twice. -noautorotate turns that off.
  //   * `-metadata:s:v:0 rotate=0` alone does NOT strip the display matrix --
  //     it measurably survived into the output, which would make a player
  //     re-rotate our already-correct frame. `-display_rotation 0` as an INPUT
  //     option is what actually clears it.
  args.push("-display_rotation", "0", "-noautorotate");

  if (trim.start > 0) {
    // Input-side -ss with -accurate_seek decodes from the preceding keyframe and
    // discards, so the cut lands on the exact frame instead of snapping.
    args.push("-accurate_seek", "-ss", fmt(trim.start));
  }
  args.push("-i", input.inputVideoPath);

  if (overlayPath !== null) args.push("-i", overlayPath);

  if (musicPath !== null) {
    // -stream_loop is cheaper and sample-exact compared with sizing an aloop,
    // and `atrim` above is what stops the infinite stream.
    if (loopMusic) args.push("-stream_loop", "-1");
    else if (hasMusic && audio.loop && !trim.bounded) {
      notes.push("music looping disabled: an unbounded loop with no -t would never finish");
    }
    args.push("-i", musicPath);
  }

  args.push("-filter_complex", filterGraph);
  args.push("-map", "[vout]");
  if (audioMapLabel !== null) args.push("-map", audioMapLabel);
  else if (audioDirectMap !== null) args.push("-map", audioDirectMap);
  else args.push("-an");

  if (trim.bounded) args.push("-t", fmt(outDuration));

  // -fps_mode cfr, not the deprecated -vsync cfr. Variable-frame-rate phone
  // video otherwise drifts out of sync with the overlay and the audio.
  args.push("-fps_mode", "cfr");

  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p");
  args.push("-metadata:s:v:0", "rotate=0");
  args.push("-movflags", "+faststart");
  if (hasAudioOutput) args.push("-c:a", "aac", "-b:a", "128k");
  args.push(input.outputPath);

  return {
    args,
    filterGraph,
    expectedDurationSeconds: outDuration,
    notes,
  };
}

// ── Progress ─────────────────────────────────────────────────────────────────
/**
 * Read a percentage out of one ffmpeg stderr line.
 *
 * Matches the `-stats` line (`frame= 90 fps=30 ... time=00:00:03.00 ...`) and,
 * because `out_time=` contains `time=`, also `-progress pipe:2` output.
 * VERIFIED: `-loglevel error -stats` really does emit `time=00:00:01.93`.
 */
export function parseProgress(stderrLine: string, totalSeconds: number): number | null {
  if (typeof stderrLine !== "string" || stderrLine === "") return null;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;

  const clock = /time=\s*(-?)(\d+):(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)/.exec(stderrLine);
  if (clock) {
    const sign = clock[1] === "-" ? -1 : 1;
    const seconds =
      sign *
      (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4].replace(",", ".")));
    if (!Number.isFinite(seconds)) return null;
    return clamp((seconds / totalSeconds) * 100, 0, 100);
  }

  // `-progress` writes out_time_us and out_time_ms with the SAME microsecond
  // value; the `_ms` name is a long-standing upstream misnomer.
  const micros = /out_time_(?:us|ms)=\s*(-?\d+)/.exec(stderrLine);
  if (micros) {
    const seconds = Number(micros[1]) / 1_000_000;
    if (!Number.isFinite(seconds)) return null;
    return clamp((seconds / totalSeconds) * 100, 0, 100);
  }

  return null;
}
