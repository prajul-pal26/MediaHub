/**
 * Shared data shapes and browser-side helpers for the editor asset library.
 *
 * Everything here is deliberately defensive about the shape of a row.
 *
 *  - `trpc.editor.*` hands back rows straight out of Supabase, so the keys that
 *    arrive are the SQL ones (`drive_file_id`, `duration_ms`, `is_default`).
 *    The published contract for these panels is camelCase, so each normaliser
 *    accepts either spelling and the panels only ever read the normalised type.
 *  - PostgREST serialises `numeric` columns as JSON **strings**
 *    (`stickers.aspect` is `numeric(10,6)`), so numbers go through `toNumber`
 *    rather than being trusted as numbers.
 *  - `ctx.db` is typed loosely on the server, which makes the procedure outputs
 *    `any`. Normalising at the boundary is what keeps the panels themselves
 *    honestly typed.
 */

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface EditorSticker {
  id: string;
  packId: string | null;
  name: string;
  driveFileId: string;
  /** Intrinsic pixel size. Null when the row predates client-side measuring. */
  width: number | null;
  height: number | null;
  /**
   * Intrinsic height / width — the same convention as `Layer.aspect`, where
   * `resolveLayerRect` derives height as `width * aspect`. A wrong value here is
   * exactly what makes a pasted logo look stretched, so it is derived from the
   * real dimensions whenever the stored value is missing.
   */
  aspect: number;
  thumb: string | null;
}

export interface EditorStickerPack {
  id: string;
  name: string;
  stickers: EditorSticker[];
}

/**
 * `importing` and `failed` exist because a track can also be extracted from an
 * Instagram reel, which happens in the worker (ffmpeg is not in the `app`
 * image) and therefore cannot be finished inside the request that started it.
 * An uploaded track is `ready` the moment its row exists.
 */
export type AudioImportStatus = "ready" | "importing" | "failed";

export interface EditorAudioTrack {
  id: string;
  name: string;
  /** Empty while an import is still in flight — the row has no Drive file yet. */
  driveFileId: string;
  /** Milliseconds, or null when the duration could not be decoded. */
  durationMs: number | null;
  isDefault: boolean;
  importStatus: AudioImportStatus;
  /** Why the import failed, shown verbatim. Null unless `importStatus` is `failed`. */
  importError: string | null;
  /** The reel/post the audio came from; null for an uploaded file. */
  sourceUrl: string | null;
}

/** True when the track has bytes behind it and can be previewed or selected. */
export function isTrackPlayable(track: EditorAudioTrack): boolean {
  return track.importStatus === "ready" && Boolean(track.driveFileId);
}

export interface EditorTemplate {
  id: string;
  name: string;
  kind: string;
  thumb: string | null;
  createdAt: string | null;
}

/** What `StickerLibrary` hands the shell when a sticker is clicked. */
export interface PickedSticker {
  id: string;
  driveFileId: string;
  name: string;
  width: number;
  height: number;
  aspect: number;
}

// ── Coercion ─────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positive(value: number | null): number | null {
  return value != null && value > 0 ? value : null;
}

// ── Normalisers ──────────────────────────────────────────────────────────────

export function normalizeSticker(row: unknown): EditorSticker | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = toText(r.id);
  if (!id) return null;

  const width = positive(toNumber(r.width));
  const height = positive(toNumber(r.height));
  const storedAspect = positive(toNumber(r.aspect));

  return {
    id,
    packId: toText(r.packId ?? r.pack_id),
    name: toText(r.name) ?? "Sticker",
    driveFileId: toText(r.driveFileId ?? r.drive_file_id) ?? "",
    width,
    height,
    // Prefer the stored aspect, then the measured dimensions, then square.
    aspect: storedAspect ?? (width && height ? height / width : 1),
    thumb: toText(r.thumb),
  };
}

export function normalizeStickerPack(row: unknown): EditorStickerPack | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = toText(r.id);
  if (!id) return null;

  const rawStickers = Array.isArray(r.stickers) ? r.stickers : [];
  return {
    id,
    name: toText(r.name) ?? "Untitled pack",
    stickers: rawStickers
      .map(normalizeSticker)
      .filter((sticker): sticker is EditorSticker => sticker !== null),
  };
}

export function normalizeAudioTrack(row: unknown): EditorAudioTrack | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = toText(r.id);
  if (!id) return null;

  // Anything unrecognised reads as `ready`, which is also the column's default:
  // a row from before migration 00043 is an uploaded track whose bytes are
  // already there, and must not render as though it were stuck importing.
  const rawStatus = toText(r.importStatus ?? r.import_status);
  const importStatus: AudioImportStatus =
    rawStatus === "importing" || rawStatus === "failed" ? rawStatus : "ready";

  return {
    id,
    name: toText(r.name) ?? "Untitled track",
    driveFileId: toText(r.driveFileId ?? r.drive_file_id) ?? "",
    durationMs: positive(toNumber(r.durationMs ?? r.duration_ms)),
    isDefault: Boolean(r.isDefault ?? r.is_default),
    importStatus,
    importError: toText(r.importError ?? r.import_error),
    sourceUrl: toText(r.sourceUrl ?? r.source_url),
  };
}

export function normalizeTemplate(row: unknown): EditorTemplate | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = toText(r.id);
  if (!id) return null;

  return {
    id,
    name: toText(r.name) ?? "Untitled template",
    kind: toText(r.kind) ?? "any",
    thumb: toText(r.thumb),
    createdAt: toText(r.createdAt ?? r.created_at),
  };
}

/** Normalise a whole list, dropping anything unusable instead of throwing. */
export function normalizeList<T>(
  rows: unknown,
  normalise: (row: unknown) => T | null
): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalise).filter((row): row is T => row !== null);
}

// ── URLs and formatting ──────────────────────────────────────────────────────

/** Authenticated byte proxy for a sticker or audio file. */
export function editorAssetUrl(id: string): string {
  return `/api/editor/asset/${encodeURIComponent(id)}`;
}

/** `m:ss` (or `h:mm:ss`). Display only — the document keeps milliseconds. */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "--:--";
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds with one decimal, for the audio offset/fade readouts. */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export function fileLabel(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").slice(0, 120) || fileName;
}

// ── Accepted uploads ─────────────────────────────────────────────────────────

/** Only formats with reliable alpha — a JPEG sticker is an opaque rectangle. */
export const STICKER_MIME_TYPES = ["image/png", "image/webp"] as const;
export const STICKER_ACCEPT = "image/png,image/webp";

export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/aacp",
  "audio/x-m4a",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
] as const;
export const AUDIO_ACCEPT = "audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav";

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];

export function isStickerFile(file: File): boolean {
  return (STICKER_MIME_TYPES as readonly string[]).includes(file.type);
}

export function isAudioFile(file: File): boolean {
  // Browsers disagree about m4a/aac MIME types (Safari reports an empty string
  // for some), so the extension is a legitimate second opinion here.
  if ((AUDIO_MIME_TYPES as readonly string[]).includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Client-side measurement ──────────────────────────────────────────────────

/** Never let a wedged decode hang an upload. */
const MEASURE_TIMEOUT_MS = 10_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read a sticker's intrinsic size before upload.
 *
 * The editor needs `aspect` to place the layer, and deriving it here means the
 * first paint after a pick is already correct instead of waiting for the server
 * to report dimensions back.
 */
export function measureImage(file: File): Promise<ImageDimensions | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    let settled = false;

    const finish = (value: ImageDimensions | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);

    image.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = image;
      finish(width > 0 && height > 0 ? { width, height } : null);
    };
    image.onerror = () => finish(null);
    image.src = url;
  });
}

/**
 * Read a track's duration in **milliseconds** before upload.
 *
 * Milliseconds, not seconds: `media_assets.duration_seconds` is an INTEGER that
 * was already rounded at upload time, so a trim or fade point can never be
 * recovered from it. `audio_tracks.duration_ms` exists for exactly this reason.
 * An undecodable duration stays null rather than becoming a wrong number.
 */
export function measureAudioDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("audio");
    element.preload = "metadata";
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);

    element.onloadedmetadata = () => {
      // Some VBR MP3s report Infinity until the whole file is buffered.
      const seconds = element.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    };
    element.onerror = () => finish(null);
    element.src = url;
  });
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadedEditorAsset {
  id: string;
  driveFileId: string;
  width?: number;
  height?: number;
  aspect?: number;
  durationMs?: number;
}

export interface UploadEditorAssetParams {
  file: File;
  brandId: string;
  kind: "sticker" | "audio";
  name: string;
  /** Stickers only. */
  packId?: string;
  width?: number;
  height?: number;
  aspect?: number;
  durationMs?: number;
}

/**
 * `POST /api/editor/asset` — multipart, same shape as `/api/upload`.
 *
 * The Content-Type header is deliberately not set: the browser has to add the
 * multipart boundary itself.
 */
export async function uploadEditorAsset(
  params: UploadEditorAssetParams
): Promise<UploadedEditorAsset> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("brandId", params.brandId);
  form.append("kind", params.kind);
  form.append("name", params.name);
  if (params.packId) form.append("packId", params.packId);
  if (params.width != null) form.append("width", String(params.width));
  if (params.height != null) form.append("height", String(params.height));
  if (params.aspect != null) form.append("aspect", String(params.aspect));
  if (params.durationMs != null) form.append("durationMs", String(params.durationMs));

  // The kind also rides in the query string so the server can reject an
  // oversized body BEFORE buffering it — it cannot read the form field without
  // first reading the whole upload. The form field above stays authoritative.
  const response = await fetch(`/api/editor/asset?kind=${encodeURIComponent(params.kind)}`, {
    method: "POST",
    body: form,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    let message = `Upload failed for ${params.file.name}`;
    if (payload && typeof payload === "object") {
      const detail = toText((payload as Record<string, unknown>).error);
      if (detail) message = detail;
    }
    throw new Error(message);
  }

  return (payload ?? {}) as UploadedEditorAsset;
}
