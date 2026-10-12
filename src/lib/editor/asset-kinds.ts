/**
 * The one table that decides what the editor will accept as an uploaded asset.
 *
 * Four kinds of file reach the editor that are NOT library media and must never
 * appear in the Media Library:
 *
 *   sticker  — a logo / badge / cut-out the user pastes onto a canvas
 *   audio    — a reusable track for the brand's audio library
 *   overlay  — the transparent PNG `rasterizeOverlays` produces in the browser
 *              on every render, composited server-side by sharp / ffmpeg
 *   source   — the photo or video the user drops or pastes INTO the editor: the
 *              thing being edited. Library media is already processed or
 *              published, so a draft brings its own fresh original rather than
 *              borrowing one. It is the only kind with no `media_assets` row
 *              AND no row of its own — the Drive file id is carried by
 *              `media_edits.source_drive_file_id` — so the Library, which lists
 *              `media_assets`, never shows it until a render is transferred.
 *
 * This module is deliberately pure: no `node:*` imports, no `sharp`, no Buffer
 * construction at module scope. The upload route imports it to validate, and a
 * client component imports the same constants to build its `<input accept>` and
 * to reject an oversized file before spending the user's bandwidth. One table,
 * so the two can never disagree about what is allowed.
 *
 * Why magic bytes and not `file.type`: the browser derives the declared MIME
 * from the file extension, and a multipart part's `Content-Type` is whatever the
 * caller wrote. These files are handed straight back to a browser by
 * `/api/editor/asset/[id]`, so a `.png` that is really HTML would be a stored
 * XSS if anything downstream ever sniffed it. We check the declared type against
 * the kind AND the bytes against the declared type.
 *
 * Why SVG is rejected, for stickers and sources alike: SVG is a document
 * format. It can carry <script>, <foreignObject> and external references, and it
 * is served back from the same origin as the app. There is no safe way to replay
 * user SVG to the browser without a sanitiser we do not have, so raster only.
 */

// ── Kinds ────────────────────────────────────────────────────────────────────

export const EDITOR_ASSET_KIND_LIST = ["sticker", "audio", "overlay", "source"] as const;
export type EditorAssetKind = (typeof EDITOR_ASSET_KIND_LIST)[number];

export function isEditorAssetKind(value: unknown): value is EditorAssetKind {
  return typeof value === "string" && (EDITOR_ASSET_KIND_LIST as readonly string[]).includes(value);
}

// ── Magic bytes ──────────────────────────────────────────────────────────────

/**
 * One contiguous run of expected bytes at a fixed offset.
 *
 * `bytes` entries may be `null` to match any byte. `mask` supplies a per-byte
 * AND mask (default 0xff) so a partially-significant header — an MPEG frame
 * sync, whose low bits encode layer/bitrate/sample rate — can be expressed
 * without enumerating every variant.
 */
export interface MagicWindow {
  readonly offset: number;
  readonly bytes: readonly (number | null)[];
  readonly mask?: readonly number[];
}

/** A container fingerprint. Every window must match for the signature to match. */
export interface MagicSignature {
  readonly label: string;
  readonly windows: readonly MagicWindow[];
}

const PNG: MagicSignature = {
  label: "PNG",
  windows: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
};

// JPEG start-of-image, plus the 0xff that opens the marker after it. Covers
// JFIF, Exif and the bare SOI phone cameras emit.
const JPEG: MagicSignature = {
  label: "JPEG",
  windows: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
};

// RIFF container: "RIFF" ....(size).... "WEBP" / "WAVE".
const WEBP: MagicSignature = {
  label: "WebP",
  windows: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};

// "GIF8" — covers both GIF87a and GIF89a.
const GIF: MagicSignature = {
  label: "GIF",
  windows: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
};

const WAVE: MagicSignature = {
  label: "WAV",
  windows: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] },
  ],
};

// RIFF a third time: "RIFF" ....(size).... "AVI " — note the trailing space,
// the fourcc is four bytes.
const AVI: MagicSignature = {
  label: "AVI",
  windows: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x41, 0x56, 0x49, 0x20] },
  ],
};

// Matroska's EBML header element id, which WebM inherits.
const EBML: MagicSignature = {
  label: "WebM / Matroska",
  windows: [{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
};

const OGG: MagicSignature = {
  label: "Ogg",
  windows: [{ offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] }],
};

/**
 * ISO base media file format: a 4-byte box size, then "ftyp". Covers M4A, MP4
 * audio and the AAC-in-MP4 files Safari and iOS produce — and, for the `source`
 * kind, MP4 video, modern QuickTime and HEIC/HEIF, which are all the same
 * container with a different brand in the bytes that follow.
 *
 * So this one signature cannot tell an MP4 from a HEIC: a video's bytes declared
 * as `image/heic` match it. That is as far as magic bytes can go for this family,
 * and it is not the last gate — the POST route hands every `source` image to
 * sharp and refuses the upload when sharp cannot read its dimensions, which an
 * MP4 mislabelled as HEIC fails. One `ftyp` brand window per MIME was the
 * alternative and it would reject the long tail of legitimate brands instead.
 */
const ISO_BMFF: MagicSignature = {
  label: "MP4 / M4A",
  windows: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
};

// An ID3v2 tag ("ID3") in front of the MPEG stream — how almost every real .mp3
// starts, because the tag is written before the first frame.
const ID3: MagicSignature = {
  label: "MP3 (ID3)",
  windows: [{ offset: 0, bytes: [0x49, 0x44, 0x33] }],
};

/**
 * A bare MPEG audio frame sync: eleven set bits. 0xff followed by a byte whose
 * top three bits are set — FF FB / FF F3 / FF FA (MP3) and FF F1 / FF F9
 * (AAC in ADTS) all land here.
 */
const MPEG_SYNC: MagicSignature = {
  label: "MPEG audio frame",
  windows: [{ offset: 0, bytes: [0xff, 0xe0], mask: [0xff, 0xe0] }],
};

// Raw AAC in the (rare) ADIF container.
const ADIF: MagicSignature = {
  label: "AAC (ADIF)",
  windows: [{ offset: 0, bytes: [0x41, 0x44, 0x49, 0x46] }],
};

// ── The table ────────────────────────────────────────────────────────────────

export interface EditorAssetMimeSpec {
  /** Shown to the user when the bytes do not match what the name claimed. */
  readonly label: string;
  /** Any one of these matching is enough. */
  readonly signatures: readonly MagicSignature[];
  /** Canonical extension, used to name the file in Drive. */
  readonly extension: string;
}

export interface EditorAssetKindSpec {
  readonly label: string;
  readonly maxBytes: number;
  /** Declared MIME → what its bytes must look like. Key order drives `accept`. */
  readonly mimeTypes: Readonly<Record<string, EditorAssetMimeSpec>>;
  /** True when a server-side pixel measurement is meaningful for this kind. */
  readonly measurable: boolean;
}

const MB = 1024 * 1024;

export const EDITOR_ASSET_KINDS: Readonly<Record<EditorAssetKind, EditorAssetKindSpec>> = {
  sticker: {
    label: "Sticker",
    maxBytes: 10 * MB,
    measurable: true,
    mimeTypes: {
      "image/png": { label: "PNG", signatures: [PNG], extension: "png" },
      "image/webp": { label: "WebP", signatures: [WEBP], extension: "webp" },
      "image/gif": { label: "GIF", signatures: [GIF], extension: "gif" },
    },
  },
  audio: {
    label: "Audio track",
    maxBytes: 50 * MB,
    measurable: false,
    mimeTypes: {
      "audio/mpeg": { label: "MP3", signatures: [ID3, MPEG_SYNC], extension: "mp3" },
      "audio/mp4": { label: "MP4 audio", signatures: [ISO_BMFF], extension: "m4a" },
      "audio/aac": { label: "AAC", signatures: [ISO_BMFF, MPEG_SYNC, ADIF, ID3], extension: "aac" },
      "audio/wav": { label: "WAV", signatures: [WAVE], extension: "wav" },
      "audio/x-m4a": { label: "M4A", signatures: [ISO_BMFF], extension: "m4a" },
      "audio/ogg": { label: "Ogg", signatures: [OGG], extension: "ogg" },
    },
  },
  overlay: {
    // Produced by the app itself, never chosen by the user — `canvas.toBlob`
    // only emits PNG here, so anything else means the caller is not our client.
    label: "Overlay",
    maxBytes: 25 * MB,
    measurable: true,
    mimeTypes: {
      "image/png": { label: "PNG", signatures: [PNG], extension: "png" },
    },
  },
  source: {
    label: "Source",
    // 500MB, the same cap `/api/upload/route.ts` applies to library media
    // (`MAX_FILE_SIZE = 500 * 1024 * 1024`). A source is the same kind of file
    // arriving by a different door, so a file the Library would take and the
    // editor would not — or the reverse — is only ever a surprise.
    maxBytes: 500 * MB,
    // Mixed on purpose, and the only kind where a per-kind boolean cannot answer
    // the question: sharp reads an image's header but cannot open an MP4 at all,
    // and ffprobe — which could measure the video — is absent from the `app`
    // image. So this stays false and the POST route decides per MIME via
    // `mediaKindFor`, measuring images and taking a video's dimensions from the
    // client. False rather than true so that a caller reaching for the kind-level
    // flag alone never feeds a video to sharp.
    measurable: false,
    // Exactly the image and video types `/api/upload/route.ts` whitelists, in
    // its order. Audio is not here: a soundtrack is the `audio` kind, and the
    // thing being edited is a photo or a video.
    mimeTypes: {
      "image/jpeg": { label: "JPEG", signatures: [JPEG], extension: "jpg" },
      "image/png": { label: "PNG", signatures: [PNG], extension: "png" },
      "image/gif": { label: "GIF", signatures: [GIF], extension: "gif" },
      "image/webp": { label: "WebP", signatures: [WEBP], extension: "webp" },
      "image/heic": { label: "HEIC", signatures: [ISO_BMFF], extension: "heic" },
      "image/heif": { label: "HEIF", signatures: [ISO_BMFF], extension: "heif" },
      "video/mp4": { label: "MP4", signatures: [ISO_BMFF], extension: "mp4" },
      // Every QuickTime file this decade opens with `ftyp` ("ftypqt  "), so the
      // ISO-BMFF window covers it. A pre-`ftyp` .mov, whose first box is `moov`
      // or `mdat`, is refused as a content mismatch rather than widened for.
      "video/quicktime": { label: "QuickTime", signatures: [ISO_BMFF], extension: "mov" },
      "video/webm": { label: "WebM", signatures: [EBML], extension: "webm" },
      "video/x-msvideo": { label: "AVI", signatures: [AVI], extension: "avi" },
    },
  },
};

// ── Queries ──────────────────────────────────────────────────────────────────

export function maxBytesFor(kind: EditorAssetKind): number {
  return EDITOR_ASSET_KINDS[kind].maxBytes;
}

/**
 * Look a MIME up in a kind's table — own properties only.
 *
 * The MIME comes off a multipart part's `Content-Type`, so it is attacker
 * chosen, and the table is a plain object literal. A plain `table[mime]` would
 * resolve `__proto__` to `Object.prototype` and `constructor` to the `Object`
 * function, both truthy: that turns a hostile content type into a "supported"
 * one whose `.signatures` is undefined. `normaliseMime` lower-cases, which
 * happens to defuse `toString` and `valueOf`, but `__proto__` and `constructor`
 * are already lower case. Own-property lookup is the actual fix.
 */
function mimeSpecFor(kind: EditorAssetKind, mime: string): EditorAssetMimeSpec | undefined {
  const table = EDITOR_ASSET_KINDS[kind]?.mimeTypes;
  if (!table) return undefined;
  const key = normaliseMime(mime);
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function allowedMimeTypesFor(kind: EditorAssetKind): string[] {
  return Object.keys(EDITOR_ASSET_KINDS[kind].mimeTypes);
}

/** For a file input's `accept` attribute. */
export function acceptAttributeFor(kind: EditorAssetKind): string {
  return allowedMimeTypesFor(kind).join(",");
}

export function isAllowedMime(kind: EditorAssetKind, mime: string): boolean {
  return mimeSpecFor(kind, mime) !== undefined;
}

/** Canonical file extension for a validated kind/MIME pair, without the dot. */
export function extensionFor(kind: EditorAssetKind, mime: string): string {
  return mimeSpecFor(kind, mime)?.extension ?? "bin";
}

/**
 * The MIME to put in a `Content-Type` when replaying a stored row's bytes.
 *
 * A stored `mime_type` is data, not a guarantee: it is echoed into a response
 * header for a user-uploaded file, so it is re-checked against this table and
 * falls back to an inert type rather than being trusted.
 */
export function safeContentType(kind: EditorAssetKind, storedMime: string | null | undefined): string {
  const mime = normaliseMime(storedMime ?? "");
  return mime && isAllowedMime(kind, mime) ? mime : "application/octet-stream";
}

/**
 * Which of the two media kinds a MIME is — `media_edits.kind`'s domain, not an
 * `EditorAssetKind`.
 *
 * Only meaningful for `source`, where one kind carries both. Two decisions hang
 * off the same answer — whether sharp is handed the buffer, and what `kind` the
 * POST response reports — and they must not be able to disagree, so they ask
 * here rather than each testing a prefix. Null for anything that is neither,
 * which `assertAllowed` has already ruled out for a `source` by the time this is
 * called.
 */
export function mediaKindFor(mime: string): "image" | "video" | null {
  const normalised = normaliseMime(mime);
  if (normalised.startsWith("image/")) return "image";
  if (normalised.startsWith("video/")) return "video";
  return null;
}

/**
 * "image/png; charset=binary" and "IMAGE/PNG" both mean image/png.
 *
 * Exported because a `source`'s type is persisted and then branched on with
 * `.startsWith("image/")`, which a raw `File.type` carrying a charset parameter
 * would silently fail. Every other reader in this module normalises already.
 */
export function normaliseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

// ── Validation ───────────────────────────────────────────────────────────────

export type EditorAssetRejection =
  | "unknown-kind"
  | "unsupported-type"
  | "too-large"
  | "empty"
  | "content-mismatch";

/** Carries the HTTP status the route should use, so the route holds no policy. */
export class EditorAssetError extends Error {
  readonly reason: EditorAssetRejection;
  readonly status: number;

  constructor(reason: EditorAssetRejection, message: string, status: number) {
    super(message);
    this.name = "EditorAssetError";
    this.reason = reason;
    this.status = status;
  }
}

function matchesWindow(bytes: Uint8Array, window: MagicWindow): boolean {
  if (bytes.length < window.offset + window.bytes.length) return false;
  for (let i = 0; i < window.bytes.length; i++) {
    const expected = window.bytes[i];
    if (expected === null || expected === undefined) continue;
    const mask = window.mask?.[i] ?? 0xff;
    if ((bytes[window.offset + i]! & mask) !== expected) return false;
  }
  return true;
}

export function matchesSignature(bytes: Uint8Array, signature: MagicSignature): boolean {
  return signature.windows.every((window) => matchesWindow(bytes, window));
}

/** Does `bytes` look like the container `mime` promises for this kind? */
export function contentMatchesMime(kind: EditorAssetKind, mime: string, bytes: Uint8Array): boolean {
  const spec = mimeSpecFor(kind, mime);
  if (!spec) return false;
  return spec.signatures.some((signature) => matchesSignature(bytes, signature));
}

/**
 * The single gate. Throws `EditorAssetError` — which carries its own status —
 * when the kind, the declared type, the size or the actual bytes are wrong.
 *
 * `bytes` is optional so a client can run the cheap checks (kind, declared
 * type, size) before reading the file; the server always passes the buffer.
 * `Buffer` is a `Uint8Array`, so a server caller needs no conversion.
 */
export function assertAllowed(
  kind: string,
  mime: string,
  bytes?: Uint8Array,
  declaredSize?: number
): asserts kind is EditorAssetKind {
  if (!isEditorAssetKind(kind)) {
    throw new EditorAssetError(
      "unknown-kind",
      `Unknown editor asset kind '${String(kind)}'. Expected one of: ${EDITOR_ASSET_KIND_LIST.join(", ")}.`,
      400
    );
  }

  const spec = EDITOR_ASSET_KINDS[kind];
  const normalised = normaliseMime(mime);
  const allowed = mimeSpecFor(kind, normalised);
  if (!allowed) {
    throw new EditorAssetError(
      "unsupported-type",
      `${spec.label} files must be one of ${Object.values(spec.mimeTypes)
        .map((m) => m.label)
        .join(", ")}. Received '${normalised || "no content type"}'.` +
        (normalised === "image/svg+xml"
          ? " SVG is not accepted: it can carry script and these files are served back to the browser."
          : ""),
      415
    );
  }

  const size = bytes?.length ?? declaredSize;
  if (size !== undefined) {
    if (size <= 0) {
      throw new EditorAssetError("empty", `The ${spec.label.toLowerCase()} file is empty.`, 400);
    }
    if (size > spec.maxBytes) {
      throw new EditorAssetError(
        "too-large",
        `${spec.label} files are limited to ${formatBytes(spec.maxBytes)}; this file is ${formatBytes(size)}.`,
        413
      );
    }
  }

  if (bytes && !contentMatchesMime(kind, normalised, bytes)) {
    throw new EditorAssetError(
      "content-mismatch",
      `The file's contents are not a valid ${allowed.label}. It was sent as '${normalised}' but does not start with that format's header.`,
      415
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
