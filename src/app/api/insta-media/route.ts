import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * Proxy for Instagram CDN media (images + videos) and local preview fallbacks.
 * Streams back media with hotlink bypass and HTTP 206 Partial Content range support
 * for smooth HTML5 video playback and seeking on Chrome and Safari.
 */
const ALLOWED_HOST = /(\.|^)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

function respondWithBuffer(
  req: NextRequest,
  buffer: Buffer,
  contentType: string,
  downloadName?: string | null
): NextResponse {
  const total = buffer.length;
  const rangeHeader = req.headers.get("range");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
  };

  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
  }

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
    }
  }

  headers["Content-Length"] = String(total);
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
}

function serveFallbackMedia(req: NextRequest, isImage = false): NextResponse {
  if (isImage) {
    return new NextResponse("Image not found", { status: 404 });
  }

  try {
    const fileName = "default-reel.mp4";
    const filePath = path.join(process.cwd(), "public", "videos", fileName);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const contentType = "video/mp4";
      const dl = req.nextUrl.searchParams.get("dl");
      let downloadName: string | null = null;
      if (dl) {
        const safe = dl.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "reel";
        downloadName = `${safe}.mp4`;
      }
      return respondWithBuffer(req, buffer, contentType, downloadName);
    }
  } catch {}

  return new NextResponse("Media unavailable", { status: 404 });
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  const isImageRequest = /\.(jpg|jpeg|png|webp)/i.test(raw) || req.nextUrl.searchParams.get("type") === "image";

  // 1. Handle local public files (e.g., /videos/sample-reel-1.mp4)
  if (raw.startsWith("/videos/") || raw.startsWith("videos/")) {
    const cleanPath = raw.startsWith("/") ? raw.slice(1) : raw;
    const safeName = path.basename(cleanPath);
    const filePath = path.join(process.cwd(), "public", "videos", safeName);

    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const isVideo = safeName.endsWith(".mp4");
      const contentType = isVideo ? "video/mp4" : "image/jpeg";
      const dl = req.nextUrl.searchParams.get("dl");
      let downloadName: string | null = null;
      if (dl) {
        const ext = isVideo ? "mp4" : "jpg";
        const safe = dl.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "reel";
        downloadName = `${safe}.${ext}`;
      }

      return respondWithBuffer(req, buffer, contentType, downloadName);
    }
  }

  // 2. Handle remote Instagram CDN URLs
  let target: URL | null = null;
  try {
    target = new URL(raw);
  } catch {
    return serveFallbackMedia(req, isImageRequest);
  }

  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return serveFallbackMedia(req, isImageRequest);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    // Facebook video CDN prefers a facebook.com referer; Instagram media keeps
    // its own. Callers downloading FB media pass ref=fb.
    const referer = req.nextUrl.searchParams.get("ref") === "fb"
      ? "https://www.facebook.com/"
      : "https://www.instagram.com/";
    const upstreamHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: referer,
      Accept: "*/*",
    };
    const rangeHeader = req.headers.get("range");
    if (rangeHeader) {
      upstreamHeaders["Range"] = rangeHeader;
    }

    const upstream = await fetch(target.toString(), {
      headers: upstreamHeaders,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!upstream.ok || !upstream.body) {
      return serveFallbackMedia(req, isImageRequest);
    }

    const contentType = upstream.headers.get("content-type") ?? (isImageRequest ? "image/jpeg" : "video/mp4");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
    };

    if (upstream.headers.get("content-range")) {
      headers["Content-Range"] = upstream.headers.get("content-range")!;
    }
    if (upstream.headers.get("content-length")) {
      headers["Content-Length"] = upstream.headers.get("content-length")!;
    }

    const dl = req.nextUrl.searchParams.get("dl");
    if (dl) {
      const ext = contentType.includes("video") ? "mp4" : contentType.includes("png") ? "png" : "jpg";
      const safe = dl.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "instagram";
      headers["Content-Disposition"] = `attachment; filename="${safe}.${ext}"`;
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch {
    return serveFallbackMedia(req, isImageRequest);
  } finally {
    clearTimeout(timeout);
  }
}
