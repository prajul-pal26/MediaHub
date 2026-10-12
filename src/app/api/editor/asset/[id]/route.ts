import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/supabase/db";
import { downloadFile, downloadFileRange, getFileMetadata } from "@/server/services/drive/client";
import { safeContentType, type EditorAssetKind } from "@/lib/editor/asset-kinds";
import {
  THUMB_SIZES,
  THUMB_CACHE_CONTROL,
  buildThumbnail,
  cachedThumbnail,
  thumbnailKindOf,
} from "@/server/services/media/thumbnail";

/**
 * GET /api/editor/asset/[id] — stream a sticker, an audio track, or a draft's
 * own source photo/video to the browser.
 *
 * The companion to POST /api/editor/asset. Editor assets live in the brand's own
 * Google Drive under `drive.file` scope, so there is no URL the browser can
 * fetch directly: every read is replayed through here behind an auth check,
 * exactly like `/api/media/[assetId]`.
 *
 * `id` is a `stickers.id`, an `audio_tracks.id`, or — with `?kind=source` — a
 * `media_edits.id`. Never a Drive file id, and there is deliberately no
 * `?overlay=<driveFileId>` form. The overlay PNG is read by the worker straight
 * from Drive and never by the browser, and accepting a raw Drive id here would
 * let a client name any file the brand's token can reach. The brand is resolved
 * from the row, so the caller cannot assert which brand they are reading from
 * either.
 *
 * Range support is not optional: an `<audio>` element seeks by issuing
 * `Range: bytes=N-`, and a server that answers 200-with-everything makes the
 * scrubber dead. The editor's `<video>` preview of a source does the same, which
 * is why ranges matter for `?kind=source` too.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Profile {
  role: string;
  brand_id: string | null;
  org_id: string;
  assigned_brands?: string[] | null;
}

interface EditorAssetRow {
  kind: EditorAssetKind;
  brandId: string;
  driveFileId: string;
  mimeType: string | null;
}

/** Read access. Same semantics as `/api/media/[assetId]`; reading is enough. */
function hasBrandAccess(profile: Profile, brandId: string): boolean {
  if (["super_admin", "agency_admin"].includes(profile.role)) return true;
  if (profile.role === "agency_editor") return (profile.assigned_brands || []).includes(brandId);
  return profile.brand_id === brandId;
}

/**
 * Serve `buffer`, honouring a single byte range.
 *
 * Shaped after `/api/media/[assetId]`, with one deliberate difference: an end
 * past the last byte is clamped instead of answered with 416. Players routinely
 * ask for `bytes=0-<something large>` and RFC 7233 says a range whose start is
 * satisfiable is satisfiable; rejecting it strands the audio scrubber.
 */
function respondWithBuffer(
  req: NextRequest,
  buffer: Buffer,
  contentType: string
): NextResponse {
  const total = buffer.length;
  const rangeHeader = req.headers.get("range");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Brand-scoped and behind an auth check: never a shared cache.
    "Cache-Control": "private, max-age=3600",
    // These bytes are user-uploaded and replayed from our own origin. Never let
    // a browser second-guess the declared type.
    "X-Content-Type-Options": "nosniff",
  };

  if (rangeHeader && total > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const [, rawStart, rawEnd] = match;
      let start: number;
      let end: number;
      if (rawStart === "") {
        // Suffix range: the last N bytes.
        const suffix = rawEnd === "" ? NaN : parseInt(rawEnd!, 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          headers["Content-Range"] = `bytes */${total}`;
          return new NextResponse(null, { status: 416, headers });
        }
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = parseInt(rawStart!, 10);
        end = rawEnd === "" ? total - 1 : Math.min(parseInt(rawEnd!, 10), total - 1);
      }

      if (Number.isFinite(start) && Number.isFinite(end) && start < total && start <= end) {
        const chunk = buffer.subarray(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        headers["Content-Length"] = String(chunk.length);
        return new NextResponse(new Uint8Array(chunk), { status: 206, headers });
      }
      headers["Content-Range"] = `bytes */${total}`;
      return new NextResponse(null, { status: 416, headers });
    }
    // An unparseable or multi-range header: ignore it and send the whole file,
    // which is what RFC 7233 permits.
  }

  headers["Content-Length"] = String(total);
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
}

/**
 * Resolve a draft's own uploaded source: `id` is a `media_edits.id`.
 *
 * `brand_id` is read off the row, never from the query string, so a caller can
 * name a draft but not the brand it is authorized against.
 *
 * Only `source_drive_file_id` is ever served. The same row also carries
 * `rendered_drive_file_id` and `overlay_drive_file_id`, and neither belongs on a
 * route the browser points an `<img>` at — the render has its own path and the
 * overlay is the worker's.
 */
async function findSourceAsset(id: string): Promise<EditorAssetRow | null> {
  const db = getDb();
  const { data } = await db
    .from("media_edits")
    .select("brand_id, source_drive_file_id, source_file_type")
    .eq("id", id)
    .maybeSingle();

  // A missing draft and a draft created against a library asset — where
  // `source_drive_file_id` is null and `source_asset_id` holds the old pre-00042
  // shape — are the same 404 here: there is no own-source file to serve, and
  // which of the two it was is not the browser's business.
  if (!data?.brand_id || !data?.source_drive_file_id) return null;

  return {
    kind: "source",
    brandId: data.brand_id as string,
    driveFileId: data.source_drive_file_id as string,
    mimeType: (data.source_file_type as string | null) ?? null,
  };
}

/**
 * Find the row in `stickers`, `audio_tracks` or `media_edits`.
 *
 * `?kind=source` is an exact selector, not a hint: it names a different table
 * whose rows hold several Drive file ids, and falling through to it would make
 * which file you get depend on which table happened to answer first.
 *
 * Between `sticker` and `audio` the hint still only chooses which to try first —
 * ids are distinct across the two tables, so a wrong or hostile hint costs one
 * extra query and changes nothing about what is returned.
 */
async function findEditorAsset(id: string, hint: string | null): Promise<EditorAssetRow | null> {
  if (hint === "source") return findSourceAsset(id);

  const db = getDb();
  const order: EditorAssetKind[] = hint === "audio" ? ["audio", "sticker"] : ["sticker", "audio"];

  for (const kind of order) {
    const table = kind === "audio" ? "audio_tracks" : "stickers";
    const { data } = await db
      .from(table)
      .select("brand_id, drive_file_id, mime_type")
      .eq("id", id)
      .maybeSingle();
    if (data?.brand_id && data?.drive_file_id) {
      return {
        kind,
        brandId: data.brand_id as string,
        driveFileId: data.drive_file_id as string,
        mimeType: (data.mime_type as string | null) ?? null,
      };
    }
  }
  return null;
}

/** Largest slice served for one Range request — bounds per-request memory. */
const EDITOR_RANGE_WINDOW = 4 * 1024 * 1024;

/** Drive file sizes, cached. Immutable per file id, so this never goes stale. */
const editorSizeCache = new Map<string, number>();

async function editorFileSize(
  driveFileId: string,
  brandId: string,
  orgId: string
): Promise<number | null> {
  const cached = editorSizeCache.get(driveFileId);
  if (cached != null) return cached;
  try {
    const meta = await getFileMetadata(driveFileId, brandId, orgId);
    const size = Number(meta?.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    if (editorSizeCache.size > 5000) editorSizeCache.clear();
    editorSizeCache.set(driveFileId, size);
    return size;
  } catch {
    // `Content-Range: bytes a-b/*` is legal when the total is unknown.
    return null;
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return new NextResponse("Invalid asset id", { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const db = getDb();
  const { data: profileRow } = await db.from("users").select("*").eq("id", user.id).single();
  if (!profileRow) return new NextResponse("Profile not found", { status: 401 });
  const profile = profileRow as Profile;

  const asset = await findEditorAsset(id, req.nextUrl.searchParams.get("kind"));
  if (!asset) return new NextResponse("Asset not found", { status: 404 });

  if (!hasBrandAccess(profile, asset.brandId)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // The service role client bypasses RLS, so organization scoping is explicit:
  // without it an admin of one organization would pass the role check above for
  // another organization's sticker.
  const { data: brand } = await db
    .from("brands")
    .select("org_id")
    .eq("id", asset.brandId)
    .maybeSingle();
  if (!brand || brand.org_id !== profile.org_id) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // ?variant=thumb|preview — a tiny WebP poster instead of the original. The
  // drafts gallery paints a ~200px tile; without this each one streamed the
  // whole uploaded source out of Drive (measured 1.2-1.6s per card).
  const variant = req.nextUrl.searchParams.get("variant");
  const thumbSize = variant ? THUMB_SIZES[variant] : undefined;
  if (thumbSize) {
    const kind = thumbnailKindOf(asset.mimeType);
    if (!kind) return new NextResponse("No thumbnail for this media type", { status: 415 });

    const respond = (body: Buffer, source: string) =>
      new NextResponse(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(body.length),
          "Cache-Control": THUMB_CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
          "X-Thumb-Cache": source,
        },
      });

    const cached = await cachedThumbnail(asset.driveFileId, thumbSize);
    if (cached) return respond(cached.body, cached.source);

    try {
      const original = await downloadFile(asset.driveFileId, asset.brandId, profile.org_id);
      const body = await buildThumbnail(asset.driveFileId, thumbSize, original, kind === "video");
      if (!body) return new NextResponse("Could not build a thumbnail", { status: 415 });
      return respond(body, "generated");
    } catch (e: unknown) {
      console.error(`[editor-asset-proxy] thumb ${id}:`, (e as Error)?.message?.slice(0, 500));
      return new NextResponse("Could not load this editor asset", { status: 502 });
    }
  }

  const responseType = safeContentType(asset.kind, asset.mimeType);

  // A Range request now fetches ONLY that range from Drive. Previously this
  // buffered the entire file and sliced it, so a draft card's
  // `<video preload="metadata">` pulled a whole 20MB source just to show its
  // first frame — measured at 1.2-1.6s per card on the editor gallery, and a
  // scrubbing video repeated it on every seek.
  const rangeHeader = req.headers.get("range");
  const rangeMatch = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null;

  if (rangeMatch) {
    try {
      const total = await editorFileSize(asset.driveFileId, asset.brandId, profile.org_id);
      const start = parseInt(rangeMatch[1], 10);
      if (total != null && start >= total) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
        });
      }

      const requestedEnd = rangeMatch[2]
        ? parseInt(rangeMatch[2], 10)
        : start + EDITOR_RANGE_WINDOW - 1;
      const hardEnd = total != null ? Math.min(requestedEnd, total - 1) : requestedEnd;
      const end = Math.min(hardEnd, start + EDITOR_RANGE_WINDOW - 1);

      const chunk = await downloadFileRange(
        asset.driveFileId,
        asset.brandId,
        profile.org_id,
        start,
        end
      );

      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          "Content-Type": responseType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${total ?? "*"}`,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e: unknown) {
      console.error(`[editor-asset-proxy] range ${id}:`, (e as Error)?.message?.slice(0, 500));
      return new NextResponse("Could not load this editor asset", { status: 502 });
    }
  }

  try {
    const buffer = await downloadFile(asset.driveFileId, asset.brandId, profile.org_id);
    // The stored mime_type is data, not a promise: re-check it against the
    // allow-list for its kind before putting it in a response header.
    return respondWithBuffer(req, buffer, safeContentType(asset.kind, asset.mimeType));
  } catch (e: unknown) {
    // Drive errors carry the outgoing request config — bearer token included —
    // on the error object. Log the message only.
    console.error(`[editor-asset-proxy] ${id}:`, (e as Error)?.message?.slice(0, 500));
    return new NextResponse("Could not load this editor asset", { status: 502 });
  }
}
