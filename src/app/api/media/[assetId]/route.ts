import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/supabase/db";
import { downloadFile, downloadFileRange, getFileMetadata } from "@/server/services/drive/client";
import {
  THUMB_SIZES,
  THUMB_CACHE_CONTROL,
  buildThumbnail,
  cachedThumbnail,
  thumbnailKindOf,
} from "@/server/services/media/thumbnail";

/** Largest slice served for one Range request. Keeps per-request memory bounded. */
const RANGE_WINDOW = 4 * 1024 * 1024;

/**
 * File sizes, cached. A Range response needs the total for `Content-Range`, and
 * a scrubbing video would otherwise re-ask Drive for metadata on every seek.
 * Sizes are immutable for a Drive file id, so this never goes stale.
 */
const sizeCache = new Map<string, number>();

async function fileSizeOf(
  driveFileId: string,
  brandId: string,
  orgId: string
): Promise<number | null> {
  const cached = sizeCache.get(driveFileId);
  if (cached != null) return cached;
  try {
    const meta = await getFileMetadata(driveFileId, brandId, orgId);
    const size = Number(meta?.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    if (sizeCache.size > 5000) sizeCache.clear();
    sizeCache.set(driveFileId, size);
    return size;
  } catch {
    // A missing size is not fatal — `Content-Range: bytes a-b/*` is legal.
    return null;
  }
}

/**
 * Streams a media asset's bytes from Google Drive to the browser.
 *
 * Everything in the UI previously rendered `media_assets.metadata.thumbnail` (a
 * base64 data URL) because nothing served the real file. The editor needs actual
 * pixels — and real video needs HTTP 206 so the browser can seek — so this route
 * resolves the asset, checks brand access, and replays the bytes with ranges.
 *
 * It deliberately takes an assetId, never a raw drive file id: the client must
 * not be able to name an arbitrary Drive file.
 */

function respondWithBuffer(req: NextRequest, buffer: Buffer, contentType: string): NextResponse {
  const total = buffer.length;
  const rangeHeader = req.headers.get("range");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Private: this is brand-scoped media behind an auth check.
    "Cache-Control": "private, max-age=3600",
  };

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start < total && end < total && start <= end) {
        const chunk = buffer.subarray(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        headers["Content-Length"] = String(chunk.length);
        return new NextResponse(new Uint8Array(chunk), { status: 206, headers });
      }
      headers["Content-Range"] = `bytes */${total}`;
      return new NextResponse(null, { status: 416, headers });
    }
  }

  headers["Content-Length"] = String(total);
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
}

export async function GET(req: NextRequest, context: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) {
    return new NextResponse("Invalid asset id", { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const db = getDb();
  const { data: profile } = await db.from("users").select("*").eq("id", user.id).single();
  if (!profile) return new NextResponse("Profile not found", { status: 401 });

  const { data: asset } = await db
    .from("media_assets")
    .select("drive_file_id, processed_drive_file_id, file_type, group:media_groups(brand_id)")
    .eq("id", assetId)
    .single();
  if (!asset) return new NextResponse("Asset not found", { status: 404 });

  const brandId = (asset as any).group?.brand_id as string | undefined;
  if (!brandId) return new NextResponse("Asset has no brand", { status: 404 });

  // Same access semantics as /api/upload (which inlines this rather than using
  // the tRPC helper, because API routes have no tRPC context).
  const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);
  const isAssignedEditor =
    profile.role === "agency_editor" && (profile.assigned_brands || []).includes(brandId);
  const isBrandMatch = profile.brand_id === brandId;
  if (!isAdmin && !isAssignedEditor && !isBrandMatch) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const variant = req.nextUrl.searchParams.get("variant");

  // ?variant=processed serves the rendered file when one exists.
  const wantProcessed = variant === "processed";
  const driveFileId =
    wantProcessed && asset.processed_drive_file_id
      ? asset.processed_drive_file_id
      : asset.drive_file_id;
  if (!driveFileId) return new NextResponse("No file for this asset", { status: 404 });

  // ?variant=thumb|preview returns a downscaled WebP instead of the original.
  // Grid cards must never pull a multi-megabyte original just to paint 160px.
  const thumbSize = variant ? THUMB_SIZES[variant] : undefined;

  if (thumbSize) {
    const kind = thumbnailKindOf(asset.file_type);
    if (!kind) return new NextResponse("No thumbnail for this media type", { status: 415 });

    const respond = (body: Buffer, source: string) =>
      new NextResponse(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(body.length),
          "Cache-Control": THUMB_CACHE_CONTROL,
          "X-Thumb-Cache": source,
        },
      });

    const cached = await cachedThumbnail(driveFileId, thumbSize);
    if (cached) return respond(cached.body, cached.source);

    try {
      const original = await downloadFile(driveFileId, brandId, profile.org_id);
      const body = await buildThumbnail(driveFileId, thumbSize, original, kind === "video");
      // A clip whose frame could not be decoded: the card falls back to its own
      // icon rather than showing a broken image.
      if (!body) return new NextResponse("Could not build a thumbnail", { status: 415 });
      return respond(body, "generated");
    } catch (e: any) {
      console.error(`[media-proxy] thumb ${assetId}:`, e?.message);
      return new NextResponse("Could not load media", { status: 502 });
    }
  }

  const contentType = asset.file_type || "application/octet-stream";

  // A Range request fetches ONLY that range from Drive. Pulling the whole file
  // to slice it made a `<video preload="metadata">` card cost a full 20 MB
  // round-trip (measured 1.3-3.4s each), and held the entire file in memory per
  // concurrent request in a container with no mem_limit.
  const rangeHeader = req.headers.get("range");
  const rangeMatch = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null;

  if (rangeMatch) {
    try {
      const total = await fileSizeOf(driveFileId, brandId, profile.org_id);
      const start = parseInt(rangeMatch[1], 10);
      if (total != null && start >= total) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
        });
      }

      // Cap an open-ended range so "bytes=0-" cannot pull a 500 MB file in one
      // response; the browser simply asks for the next window.
      const requestedEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start + RANGE_WINDOW - 1;
      const hardEnd = total != null ? Math.min(requestedEnd, total - 1) : requestedEnd;
      const end = Math.min(hardEnd, start + RANGE_WINDOW - 1);

      const chunk = await downloadFileRange(driveFileId, brandId, profile.org_id, start, end);
      const actualEnd = start + chunk.length - 1;

      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${actualEnd}/${total ?? "*"}`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (e: any) {
      console.error(`[media-proxy] range ${assetId}:`, e?.message);
      return new NextResponse("Could not load media", { status: 502 });
    }
  }

  try {
    const buffer = await downloadFile(driveFileId, brandId, profile.org_id);
    return respondWithBuffer(req, buffer, contentType);
  } catch (e: any) {
    console.error(`[media-proxy] ${assetId}:`, e?.message);
    return new NextResponse("Could not load media", { status: 502 });
  }
}
