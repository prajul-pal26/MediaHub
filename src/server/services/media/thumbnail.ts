import sharp from "sharp";

/**
 * Thumbnail generation and caching, shared by the two byte proxies
 * (`/api/media/[assetId]` and `/api/editor/asset/[id]`).
 *
 * Why this exists at all, with the numbers that motivated it:
 *  - A grid tile pointed at the original cost **1.94 MB / 1.53 s** per image,
 *    because every tile round-trips Browser -> Next -> Google Drive.
 *  - A video tile had no poster at all, so it streamed the real file just to
 *    paint one frame — the slowest thing on a mostly-video library.
 *  - A Drive API call costs ~1.3 s from this container regardless of size, so
 *    the only real fix is to not call Drive again. Hence two cache layers.
 *
 * Both proxies must behave identically here, so the logic lives in one place
 * rather than being copied into each route.
 */

export const THUMB_SIZES: Record<string, number> = { thumb: 400, preview: 1080 };

/** A thumbnail for a Drive file id never changes, so cache it hard. */
export const THUMB_CACHE_CONTROL = "private, max-age=604800, immutable";

export type ThumbSource = "memory" | "disk" | "generated";

// ── Layer 1: in-process, bounded by BYTES so one odd large entry cannot blow
// the budget. Survives requests, not restarts.
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const memoryCache = new Map<string, Buffer>();
let memoryBytes = 0;

function remember(key: string, body: Buffer): void {
  if (body.length > MAX_MEMORY_BYTES) return;
  // Map iterates in insertion order, so the first key is the oldest.
  while (memoryBytes + body.length > MAX_MEMORY_BYTES && memoryCache.size > 0) {
    const oldest = memoryCache.keys().next().value as string;
    memoryBytes -= memoryCache.get(oldest)?.length ?? 0;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, body);
  memoryBytes += body.length;
}

// ── Layer 2: a Docker volume. This is the one that matters — a restart
// otherwise re-pays a Drive round-trip for every tile at once.
const CACHE_DIR = process.env.MEDIA_CACHE_DIR || "";

function diskPathFor(driveFileId: string, size: number): string | null {
  if (!CACHE_DIR) return null;
  // Drive ids are [A-Za-z0-9_-], but this becomes a filename — sanitise anyway.
  const safe = driveFileId.replace(/[^A-Za-z0-9_-]/g, "");
  return safe ? `${CACHE_DIR}/${safe}-${size}.webp` : null;
}

async function readDisk(driveFileId: string, size: number): Promise<Buffer | null> {
  const path = diskPathFor(driveFileId, size);
  if (!path) return null;
  try {
    const { readFile } = await import("fs/promises");
    return await readFile(path);
  } catch {
    return null;
  }
}

async function writeDisk(driveFileId: string, size: number, body: Buffer): Promise<void> {
  const path = diskPathFor(driveFileId, size);
  if (!path) return;
  try {
    const { writeFile, mkdir, rename } = await import("fs/promises");
    await mkdir(CACHE_DIR, { recursive: true });
    // Write-then-rename: two concurrent requests for the same tile must never
    // let a reader observe a half-written file.
    const tmp = `${path}.${process.pid}.${body.length}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  } catch (e: unknown) {
    console.warn(`[thumbnail] cache write failed: ${(e as Error)?.message}`);
  }
}

/** A cached thumbnail, or null. Never touches Drive. */
export async function cachedThumbnail(
  driveFileId: string,
  size: number
): Promise<{ body: Buffer; source: ThumbSource } | null> {
  const key = `${driveFileId}:${size}`;

  const inMemory = memoryCache.get(key);
  if (inMemory) return { body: inMemory, source: "memory" };

  const onDisk = await readDisk(driveFileId, size);
  if (onDisk) {
    remember(key, onDisk);
    return { body: onDisk, source: "disk" };
  }

  return null;
}

/**
 * First-frame poster for a video, via ffmpeg.
 *
 * The WHOLE file is passed in rather than a ranged head: an MP4 without
 * `faststart` keeps its moov atom at the END, so a partial download decodes
 * nothing. It is a one-time cost — the result is cached on disk forever.
 */
async function videoPoster(input: Buffer, size: number): Promise<Buffer | null> {
  const { spawn } = await import("child_process");
  const { mkdtemp, writeFile, readFile, rm } = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");

  const dir = await mkdtemp(path.join(os.tmpdir(), "poster-"));
  try {
    const inPath = path.join(dir, "in");
    const outPath = path.join(dir, "out.webp");
    await writeFile(inPath, input);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", inPath,
          "-frames:v", "1",
          // `thumbnail` scores a window of frames and keeps the most
          // representative one, rather than taking whatever sits at a fixed
          // timestamp. A fixed `-ss 0.5` produced solid black posters for real
          // reels here, because they fade in from black — one came back as a
          // 6KB all-black image. Analysing 100 frames costs little and is what
          // makes the poster actually show the content.
          "-vf", `thumbnail=100,scale=${size}:${size}:force_original_aspect_ratio=decrease`,
          outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      // A corrupt or very short clip must never hang a page request.
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(err.slice(-200) || `ffmpeg exited ${code}`));
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    return await readFile(outPath);
  } catch (e: unknown) {
    console.warn(`[thumbnail] poster failed: ${(e as Error)?.message}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build a thumbnail from the original bytes and cache it.
 *
 * Returns null when a video frame could not be decoded, so the caller can let
 * the card fall back to its own icon rather than render a broken image.
 */
export async function buildThumbnail(
  driveFileId: string,
  size: number,
  original: Buffer,
  isVideo: boolean
): Promise<Buffer | null> {
  const body = isVideo
    ? await videoPoster(original, size)
    : await sharp(original, { failOn: "none" })
        // sharp does NOT apply EXIF orientation implicitly; browsers do. Without
        // this, a phone photo's thumbnail is rotated against its own preview.
        .rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();

  if (!body) return null;

  remember(`${driveFileId}:${size}`, body);
  await writeDisk(driveFileId, size, body);
  return body;
}

/** Is this media type thumbnailable at all? */
export function thumbnailKindOf(mime: string | null | undefined): "image" | "video" | null {
  const m = mime || "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}
