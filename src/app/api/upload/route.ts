import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/supabase/db";
import { uploadFile } from "@/server/services/drive/client";
import sharp from "sharp";

function calculateAspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

async function getImageMetadata(buffer: Buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
      aspectRatio:
        metadata.width && metadata.height
          ? calculateAspectRatio(metadata.width, metadata.height)
          : null,
    };
  } catch {
    return { width: 0, height: 0, aspectRatio: null };
  }
}

async function getVideoMetadata(
  buffer: Buffer
): Promise<{ width: number; height: number; aspectRatio: string | null; duration: number }> {
  // Try ffprobe if available, otherwise return defaults
  try {
    const ffmpeg = require("fluent-ffmpeg");
    const { Readable } = require("stream");
    const tmp = require("os").tmpdir();
    const fs = require("fs");
    const path = require("path");

    const tmpPath = path.join(tmp, `mediahub_${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, buffer);

    return new Promise((resolve) => {
      ffmpeg.ffprobe(tmpPath, (err: any, data: any) => {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}

        if (err || !data?.streams) {
          resolve({ width: 0, height: 0, aspectRatio: null, duration: 0 });
          return;
        }

        const video = data.streams.find((s: any) => s.codec_type === "video");
        const w = video?.width || 0;
        const h = video?.height || 0;
        const dur = Math.round(parseFloat(data.format?.duration || "0"));

        resolve({
          width: w,
          height: h,
          aspectRatio: w && h ? calculateAspectRatio(w, h) : null,
          duration: dur,
        });
      });
    });
  } catch {
    return { width: 0, height: 0, aspectRatio: null, duration: 0 };
  }
}

export async function POST(request: NextRequest) {
  // Auth check
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const { data: profile } = await db
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 401 });
  }

  const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
    "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo",
  ]);
  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const brandId = formData.get("brandId") as string;
    const groupId = formData.get("groupId") as string;
    const taggedPlatform = formData.get("taggedPlatform") as string | null;
    const taggedAccountId = formData.get("taggedAccountId") as string | null;
    const taggedAction = formData.get("taggedAction") as string | null;
    const thumbnail = formData.get("thumbnail") as string | null;
    const sortOrder = parseInt((formData.get("sortOrder") as string) || "0", 10);

    if (!file || !brandId || !groupId) {
      return NextResponse.json(
        { error: "Missing required fields: file, brandId, groupId" },
        { status: 400 }
      );
    }

    // Brand access check
    const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);
    const isAssignedEditor = profile.role === "agency_editor" && (profile.assigned_brands || []).includes(brandId);
    const isBrandMatch = profile.brand_id === brandId;
    if (!isAdmin && !isAssignedEditor && !isBrandMatch) {
      return NextResponse.json({ error: "You don't have access to this brand" }, { status: 403 });
    }

    // File type whitelist
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type '${file.type}' is not allowed. Accepted: images (JPEG, PNG, GIF, WebP, HEIC) and videos (MP4, MOV, WebM, AVI).` },
        { status: 400 }
      );
    }

    // File size limit
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds the 500MB limit.` },
        { status: 400 }
      );
    }

    // Read file into buffer
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name;
    const fileType = file.type;
    const fileSize = buffer.length;

    // Detect metadata
    let width = 0;
    let height = 0;
    let aspectRatio: string | null = null;
    let durationSeconds: number | null = null;

    if (fileType.startsWith("image/")) {
      const meta = await getImageMetadata(buffer);
      width = meta.width;
      height = meta.height;
      aspectRatio = meta.aspectRatio;
    } else if (fileType.startsWith("video/")) {
      const meta = await getVideoMetadata(buffer);
      width = meta.width;
      height = meta.height;
      aspectRatio = meta.aspectRatio;
      durationSeconds = meta.duration || null;
    }

    // Upload to Google Drive
    const driveFileId = await uploadFile(
      brandId,
      profile.org_id,
      buffer,
      fileName,
      fileType,
      "originals"
    );

    // Create media_assets row
    const { data: asset, error: assetError } = await db
      .from("media_assets")
      .insert({
        group_id: groupId,
        drive_file_id: driveFileId,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        width: width || null,
        height: height || null,
        aspect_ratio: aspectRatio,
        duration_seconds: durationSeconds,
        tagged_platform: taggedPlatform || null,
        tagged_account_id: taggedAccountId || null,
        tagged_action: taggedAction || null,
        sort_order: sortOrder,
        metadata: thumbnail ? { thumbnail } : {},
      })
      .select()
      .single();

    if (assetError) {
      return NextResponse.json({ error: assetError.message }, { status: 500 });
    }

    // Update variant count
    const { count } = await db
      .from("media_assets")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId);

    await db
      .from("media_groups")
      .update({ variant_count: count || 1 })
      .eq("id", groupId);

    return NextResponse.json({
      asset,
      driveFileId,
      metadata: { width, height, aspectRatio, durationSeconds },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
