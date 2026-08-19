import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for Instagram CDN media (images + videos).
 * Instagram's fbcdn/cdninstagram URLs block cross-origin <img>/<video> loading
 * (hotlink protection), so we fetch them server-side and stream them back from
 * our own origin. Only Instagram/Facebook CDN hosts are allowed (SSRF guard).
 */
const ALLOWED_HOST = /(\.|^)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return new NextResponse("Host not allowed", { status: 403 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Accept: "*/*",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("Upstream error", { status: 502 });
    }
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    };
    // ?dl=<name> forces a download with a friendly filename + extension.
    const dl = req.nextUrl.searchParams.get("dl");
    if (dl) {
      const ext = contentType.includes("video") ? "mp4" : contentType.includes("png") ? "png" : "jpg";
      const safe = dl.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "instagram";
      headers["Content-Disposition"] = `attachment; filename="${safe}.${ext}"`;
    }
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err: any) {
    return new NextResponse(
      err?.name === "AbortError" ? "Timeout" : "Fetch failed",
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
