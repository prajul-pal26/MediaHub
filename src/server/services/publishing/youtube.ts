import { google } from "googleapis";
import { decrypt } from "@/lib/encryption";
import { getDb } from "@/lib/supabase/db";
import { downloadFile } from "@/server/services/drive/client";
import { Readable } from "stream";

interface PublishToYouTubeParams {
  assetId: string;
  socialAccountId: string;
  action: string; // "yt_video" or "yt_short"
  brandId: string;
  orgId: string;
  title: string;
  description: string;
  tags: string[];
}

export async function publishToYouTube(params: PublishToYouTubeParams): Promise<string> {
  const db = getDb();

  // Get asset info
  const { data: asset } = await db
    .from("media_assets")
    .select("drive_file_id, processed_drive_file_id, file_name, file_type")
    .eq("id", params.assetId)
    .single();

  if (!asset) throw new Error("Asset not found");

  // Get social account tokens
  const { data: account } = await db
    .from("social_accounts")
    .select("access_token_encrypted, refresh_token_encrypted, platform_metadata")
    .eq("id", params.socialAccountId)
    .single();

  if (!account) throw new Error("YouTube account not found");

  const accessToken = decrypt(account.access_token_encrypted);
  const refreshToken = account.refresh_token_encrypted
    ? decrypt(account.refresh_token_encrypted)
    : null;

  // Get Google credentials for OAuth client (needed for token refresh)
  const { data: creds } = await db
    .from("platform_credentials")
    .select("client_id_encrypted, client_secret_encrypted")
    .eq("org_id", params.orgId)
    .eq("platform", "youtube")
    .single();

  if (!creds) throw new Error("YouTube platform credentials not found");

  const clientId = decrypt(creds.client_id_encrypted);
  const clientSecret = decrypt(creds.client_secret_encrypted);

  // Create OAuth2 client
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  // Auto-refresh if needed
  oauth2.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      const { encrypt: enc } = require("@/lib/encryption");
      await db
        .from("social_accounts")
        .update({
          access_token_encrypted: enc(tokens.access_token),
          token_expires_at: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
        })
        .eq("id", params.socialAccountId);
    }
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // Download the file from Drive
  const driveFileId = asset.processed_drive_file_id || asset.drive_file_id;
  console.log(`[youtube] Downloading ${asset.file_name} from Drive...`);
  const fileBuffer = await downloadFile(driveFileId, params.brandId, params.orgId);
  console.log(`[youtube] Downloaded ${fileBuffer.length} bytes`);

  // Determine privacy status
  // Shorts are auto-detected by YouTube when video is < 60s and vertical
  const isShort = params.action === "yt_short";

  // Upload to YouTube
  console.log(`[youtube] Uploading to YouTube as ${isShort ? "Short" : "Video"}...`);
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: (params.title || "Untitled").slice(0, 100),
        description: params.description || "",
        tags: params.tags || [],
        categoryId: "22", // People & Blogs (default)
      },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: Readable.from(fileBuffer),
      mimeType: asset.file_type || "video/mp4",
    },
  });

  const videoId = response.data.id;
  if (!videoId) {
    throw new Error("YouTube upload succeeded but no video ID returned");
  }

  console.log(`[youtube] Published! Video ID: ${videoId}`);
  console.log(`[youtube] URL: https://youtube.com/watch?v=${videoId}`);

  return videoId;
}
