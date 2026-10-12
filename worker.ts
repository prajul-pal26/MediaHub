import { config } from "dotenv";
config({ path: ".env.local" });

import { Worker, Queue } from "bullmq";
import Redis from "ioredis";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Readable } from "stream";

// ─── Setup ───

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set");
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) throw new Error("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is not set");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function db() {
  return { from: (table: string) => (supabase as any).from(table) };
}

// ─── Encryption (same as src/lib/encryption.ts) ───

function getKey(): Buffer {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  return Buffer.from(key, "hex");
}

function decrypt(encryptedText: string): string {
  const key = getKey();
  const [ivHex, tagHex, encrypted] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

// ─── Timeout Helper ───

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 60000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ─── Instagram publish pacing ───
// Instagram enforces app-level rate limiting shared across every account under
// the app. An image container is created almost instantly, so fanning one photo
// out to many accounts at worker concurrency blasts requests far faster than the
// limit allows and trips "Application request limit reached" — even though the
// accounts are fine (reels to the same accounts succeed, because video
// processing naturally spaces them out). Pace every IG container creation to a
// safe minimum gap so bursts stay under the limit. An isolated post waits ~0ms
// (its slot is already in the past); only concurrent/burst posts are spaced out.
const IG_PUBLISH_MIN_GAP_MS = parseInt(process.env.IG_PUBLISH_MIN_GAP_MS || "30000", 10);
let igNextSlotAt = 0;
async function paceInstagram(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, igNextSlotAt);
  igNextSlotAt = slot + IG_PUBLISH_MIN_GAP_MS;
  const waitMs = slot - now;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

// ─── Drive Helpers ───

async function getDriveClient(orgId: string, brandId: string) {
  const { data: driveCreds } = await db().from("platform_credentials")
    .select("client_id_encrypted, client_secret_encrypted")
    .eq("org_id", orgId)
    .in("platform", ["google_drive", "youtube"])
    .limit(1)
    .single();
  if (!driveCreds) throw new Error("Google Drive credentials not found");

  const { data: driveConn } = await db().from("drive_connections")
    .select("access_token_encrypted, refresh_token_encrypted")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .single();
  if (!driveConn) throw new Error("Drive not connected for this brand");

  const driveOAuth = new google.auth.OAuth2(
    decrypt(driveCreds.client_id_encrypted),
    decrypt(driveCreds.client_secret_encrypted)
  );
  driveOAuth.setCredentials({
    access_token: decrypt(driveConn.access_token_encrypted),
    refresh_token: driveConn.refresh_token_encrypted ? decrypt(driveConn.refresh_token_encrypted) : undefined,
  });

  return driveOAuth;
}

async function downloadFromDrive(asset: any, orgId: string, brandId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const driveOAuth = await getDriveClient(orgId, brandId);
  const drive = google.drive({ version: "v3", auth: driveOAuth });
  const driveFileId = asset.processed_drive_file_id || asset.drive_file_id;

  console.log(`[drive] Downloading ${asset.file_name} from Drive (${driveFileId})...`);
  const driveRes = await drive.files.get({ fileId: driveFileId, alt: "media" }, { responseType: "arraybuffer", timeout: 60000 });
  const buffer = Buffer.from(driveRes.data as ArrayBuffer);
  console.log(`[drive] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  return { buffer, mimeType: asset.file_type || "application/octet-stream" };
}

// ─── Instagram Helpers ───

// When the same media file is published to many accounts at once (publish worker
// concurrency > 1), every job would otherwise add and then revoke the Drive
// "anyone" permission on the SAME file. One job's cleanup() could revoke public
// access while another job's media is still being fetched by Instagram/Facebook,
// which surfaces as "The image format is not supported". We reference-count the
// temporary permission per file id: it is created once for the first concurrent
// user (all users await that same creation) and revoked only after the last one
// finishes.
const tempPublicDriveRefs = new Map<string, { count: number; ready: Promise<void> }>();

async function createTempPublicUrl(
  driveFileId: string,
  oauth2: any,
  options: { forVideo?: boolean } = {}
): Promise<{ webContentLink: string; cleanup: () => Promise<void> }> {
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // Make the file publicly readable, but only once across concurrent users.
  let entry = tempPublicDriveRefs.get(driveFileId);
  if (!entry) {
    const ready = drive.permissions
      .create({
        fileId: driveFileId,
        requestBody: { role: "reader", type: "anyone" },
      })
      .then(async () => {
        // Wait for Drive to propagate the new public permission before the URL
        // is fetched. Instagram's image container creation fetches the URL
        // synchronously; if it races ahead of propagation it gets a non-image
        // response, surfaced as "The image format is not supported" (and, after
        // retries, the misleading "Application request limit reached").
        await new Promise((r) => setTimeout(r, 3000));
      })
      .catch((err: any) => {
        // An already-public file is fine (no propagation wait needed); any other
        // failure means the file could not be shared — drop the entry so a later
        // job/retry redoes it.
        const status = err?.code ?? err?.response?.status;
        if (status === 400 || status === 409) return undefined;
        tempPublicDriveRefs.delete(driveFileId);
        throw err;
      });
    entry = { count: 0, ready };
    tempPublicDriveRefs.set(driveFileId, entry);
  }
  entry.count++;

  // Only hand out the URL once the file is actually public.
  await entry.ready;

  // Use drive.usercontent.google.com/download for both images and videos: it
  // checks Drive permissions in real time (no CDN propagation lag) and returns
  // the raw file bytes. lh3.googleusercontent.com (the old image URL) is a cached
  // image CDN that lags behind fresh public-permission changes and intermittently
  // fails Instagram's synchronous image fetch — the root cause of the photo
  // publish failures. Reels already used this URL, which is why they never failed.
  const encodedId = encodeURIComponent(driveFileId);
  const directUrl = `https://drive.usercontent.google.com/download?id=${encodedId}&export=download`;

  return {
    webContentLink: directUrl,
    cleanup: async () => {
      const current = tempPublicDriveRefs.get(driveFileId);
      if (current) {
        current.count--;
        if (current.count > 0) return; // other concurrent jobs still need it
        tempPublicDriveRefs.delete(driveFileId);
      }

      // Last concurrent user — revoke public access.
      const perms = await drive.permissions.list({ fileId: driveFileId });
      const anyonePerm = perms.data.permissions?.find((p: any) => p.type === "anyone");
      if (anyonePerm?.id) {
        await drive.permissions.delete({ fileId: driveFileId, permissionId: anyonePerm.id }).catch((err: any) => {
          const status = err?.code ?? err?.response?.status;
          if (status !== 404) throw err;
        });
      }
    },
  };
}

async function waitForIgContainer(containerId: string, accessToken: string, maxWaitMs = 120000, apiBase = "https://graph.facebook.com/v19.0"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetchWithTimeout(
      `${apiBase}/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    const data = await res.json();
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") throw new Error(`Instagram media processing failed: ${JSON.stringify(data)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Instagram media processing timed out");
}

// Build an Error that preserves Instagram's structured error so the worker can
// tell a genuine transient rate limit (retryable) from a hard integrity/"Action
// Block" (code 4, is_transient:false) that must NOT be retried — retrying an
// action block only extends and deepens it.
function igApiError(prefix: string, err: any): Error {
  const e = new Error(`${prefix}: ${err?.message || JSON.stringify(err)}`);
  (e as any).igError = err;
  return e;
}

// ─── Platform Publishers ───

async function publishToYouTube(asset: any, account: any, action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const refreshToken = account.refresh_token_encrypted ? decrypt(account.refresh_token_encrypted) : null;

  // Get Google credentials
  const { data: creds } = await db().from("platform_credentials").select("client_id_encrypted, client_secret_encrypted").eq("org_id", orgId).eq("platform", "youtube").single();
  if (!creds) throw new Error("YouTube platform credentials not found in DB");

  const clientId = decrypt(creds.client_id_encrypted);
  const clientSecret = decrypt(creds.client_secret_encrypted);

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

  // Auto-refresh tokens
  oauth2.on("tokens", async (tokens: any) => {
    if (tokens.access_token) {
      await db().from("social_accounts").update({
        access_token_encrypted: encrypt(tokens.access_token),
        token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      }).eq("id", account.id);
      console.log("[youtube] Token refreshed");
    }
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // Download file from Drive
  const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);

  // Upload to YouTube
  const title = platformMeta?.title || asset.file_name || "Untitled";
  const description = platformMeta?.description || "";
  const tags = platformMeta?.tags ? String(platformMeta.tags).split(",").filter(Boolean) : [];

  console.log(`[youtube] Uploading "${title}" to YouTube...`);

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: String(title).slice(0, 100),
        description: String(description),
        tags,
        categoryId: "22",
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
  if (!videoId) throw new Error("YouTube upload succeeded but no video ID returned");

  console.log(`[youtube] Published! https://youtube.com/watch?v=${videoId}`);
  return videoId;
}

// ─── Instagram Publisher ───

async function publishToInstagram(asset: any, account: any, action: string, orgId: string, brandId: string, groupId: string, platformMeta: any): Promise<string> {
  const igUserId = account.platform_user_id;
  // Support both Instagram Login (direct token) and legacy Facebook Login (page token)
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  const pageAccessToken = encryptedPageToken
    ? decrypt(encryptedPageToken)
    : decrypt(account.access_token_encrypted);
  const igApiBase = encryptedPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";
  const caption = platformMeta?.caption || "";

  const driveOAuth = await getDriveClient(orgId, brandId);
  const driveFileId = asset.processed_drive_file_id || asset.drive_file_id;
  const isVideo = (asset.file_type || "").startsWith("video/");

  // Create temporary public URL on Google Drive for Instagram to fetch
  const { webContentLink, cleanup } = await createTempPublicUrl(driveFileId, driveOAuth, { forVideo: isVideo });

  try {
    if (action === "ig_carousel") {
      // Carousel: need multiple assets from the group
      const { data: allAssets } = await db().from("media_assets")
        .select("*")
        .eq("group_id", groupId)
        .order("sort_order");

      // Create containers for each carousel item
      const childContainerIds: string[] = [];
      for (const carouselAsset of (allAssets || [])) {
        const carouselDriveFileId = carouselAsset.processed_drive_file_id || carouselAsset.drive_file_id;
        const isItemVideo = (carouselAsset.file_type || "").startsWith("video/");
        const { webContentLink: itemUrl, cleanup: itemCleanup } = await createTempPublicUrl(
          carouselDriveFileId,
          driveOAuth,
          { forVideo: isItemVideo }
        );

        await paceInstagram();
        const containerRes = await fetchWithTimeout(
          `${igApiBase}/${igUserId}/media`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(isItemVideo
                ? { video_url: itemUrl, media_type: "VIDEO" }
                : { image_url: itemUrl }),
              is_carousel_item: true,
              access_token: pageAccessToken,
            }),
          }
        );
        const containerData = await containerRes.json();
        if (containerData.error) throw igApiError("Instagram carousel item error", containerData.error);
        childContainerIds.push(containerData.id);

        // For videos, wait until ready
        if (isItemVideo) {
          await waitForIgContainer(containerData.id, pageAccessToken, 120000, igApiBase);
        }
        await itemCleanup();
      }

      // Create carousel container
      const carouselRes = await fetchWithTimeout(
        `${igApiBase}/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: "CAROUSEL",
            children: childContainerIds,
            caption,
            access_token: pageAccessToken,
          }),
        }
      );
      const carouselData = await carouselRes.json();
      if (carouselData.error) throw igApiError("Instagram carousel error", carouselData.error);

      // Publish carousel
      const publishRes = await fetchWithTimeout(
        `${igApiBase}/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creation_id: carouselData.id,
            access_token: pageAccessToken,
          }),
        }
      );
      const publishData = await publishRes.json();
      if (publishData.error) throw igApiError("Instagram publish error", publishData.error);

      console.log(`[instagram] Carousel published! ID: ${publishData.id}`);
      return publishData.id;

    } else {
      // Single post, reel, or story
      const mediaPayload: Record<string, string> = {
        access_token: pageAccessToken,
        caption: action === "ig_story" ? "" : caption, // Stories don't support captions
      };

      if (isVideo) {
        mediaPayload.video_url = webContentLink;
        if (action === "ig_reel") mediaPayload.media_type = "REELS";
        else if (action === "ig_story") mediaPayload.media_type = "STORIES";
        // For ig_post video, don't set media_type — Instagram defaults to feed video
      } else {
        mediaPayload.image_url = webContentLink;
        if (action === "ig_story") mediaPayload.media_type = "STORIES";
        // For ig_post image, don't set media_type — Instagram defaults to image post
      }

      // Create container (paced to stay under Instagram's app-level rate limit)
      await paceInstagram();
      const containerRes = await fetchWithTimeout(
        `${igApiBase}/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mediaPayload),
        }
      );
      const containerData = await containerRes.json();
      if (containerData.error) throw igApiError("Instagram container error", containerData.error);

      // Wait for container to be ready (videos AND images)
      // Instagram needs processing time even for images — skipping this causes
      // "media id not present" errors and duplicate posts on retry
      await waitForIgContainer(containerData.id, pageAccessToken, isVideo ? 120000 : 30000, igApiBase);

      // Publish
      const publishRes = await fetchWithTimeout(
        `${igApiBase}/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creation_id: containerData.id,
            access_token: pageAccessToken,
          }),
        }
      );
      const publishData = await publishRes.json();
      if (publishData.error) throw igApiError("Instagram publish error", publishData.error);

      console.log(`[instagram] ${action} published! ID: ${publishData.id}`);
      return publishData.id;
    }
  } finally {
    await cleanup(); // Always revoke public access
  }
}

// ─── LinkedIn Publisher ───

async function publishToLinkedIn(asset: any, account: any, action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const personUrn = account.platform_metadata?.person_urn;

  if (!personUrn) throw new Error("LinkedIn person URN not found — reconnect the account");

  // Download file from Drive
  const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);

  const isImage = asset.file_type?.startsWith("image/");
  const isVideo = asset.file_type?.startsWith("video/");
  const caption = platformMeta?.caption || "";
  const title = platformMeta?.title || asset.file_name || "";
  const description = platformMeta?.description || "";

  // ─── li_article (text post with article link — no media upload needed) ───
  if (action === "li_article") {
    console.log(`[linkedin] Creating article post...`);
    const postRes = await fetchWithTimeout("https://api.linkedin.com/v2/posts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        author: personUrn,
        commentary: `${title}\n\n${description}`,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
      }),
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`LinkedIn article post failed: ${err}`);
    }

    const postId = postRes.headers.get("x-restli-id") || `li_article_${Date.now()}`;
    console.log(`[linkedin] Article published! ID: ${postId}`);
    return postId;
  }

  // ─── li_post (image or video upload) ───
  // Step 1: Register upload
  console.log(`[linkedin] Registering ${isVideo ? "video" : "image"} upload...`);

  let uploadUrl: string;
  let mediaAssetUrn: string;

  if (isVideo) {
    // Video: use videos API
    const initRes = await fetchWithTimeout("https://api.linkedin.com/v2/videos?action=initializeUpload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: personUrn,
          fileSizeBytes: fileBuffer.length,
        },
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`LinkedIn video init failed: ${err}`);
    }

    const initData = await initRes.json();
    uploadUrl = initData.value?.uploadInstructions?.[0]?.uploadUrl;
    mediaAssetUrn = initData.value?.video;

    if (!uploadUrl) throw new Error("LinkedIn didn't return an upload URL for video");

    // Step 2: Upload video binary
    console.log(`[linkedin] Uploading video...`);
    const uploadRes = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": asset.file_type || "video/mp4",
      },
      body: new Uint8Array(fileBuffer),
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`LinkedIn video upload failed: ${err}`);
    }

    // Step 3: Create post with video
    console.log(`[linkedin] Creating video post...`);
    const postRes = await fetchWithTimeout("https://api.linkedin.com/v2/posts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        author: personUrn,
        commentary: caption,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
        content: {
          media: {
            id: mediaAssetUrn,
          },
        },
      }),
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`LinkedIn video post failed: ${err}`);
    }

    const postId = postRes.headers.get("x-restli-id") || `li_video_${Date.now()}`;
    console.log(`[linkedin] Video post published! ID: ${postId}`);
    return postId;

  } else {
    // Image: use images API
    const initRes = await fetchWithTimeout("https://api.linkedin.com/v2/images?action=initializeUpload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: personUrn,
        },
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`LinkedIn image init failed: ${err}`);
    }

    const initData = await initRes.json();
    uploadUrl = initData.value?.uploadUrl;
    mediaAssetUrn = initData.value?.image;

    if (!uploadUrl) throw new Error("LinkedIn didn't return an upload URL for image");

    // Step 2: Upload image binary
    console.log(`[linkedin] Uploading image...`);
    const uploadRes = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": asset.file_type || "image/jpeg",
      },
      body: new Uint8Array(fileBuffer),
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`LinkedIn image upload failed: ${err}`);
    }

    // Step 3: Create post with image
    console.log(`[linkedin] Creating image post...`);
    const postRes = await fetchWithTimeout("https://api.linkedin.com/v2/posts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        author: personUrn,
        commentary: caption,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
        content: {
          media: {
            id: mediaAssetUrn,
          },
        },
      }),
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`LinkedIn image post failed: ${err}`);
    }

    const postId = postRes.headers.get("x-restli-id") || `li_image_${Date.now()}`;
    console.log(`[linkedin] Image post published! ID: ${postId}`);
    return postId;
  }
}

// ─── Facebook Publisher ───

async function publishToFacebook(asset: any, account: any, action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  if (!encryptedPageToken) throw new Error("Facebook account missing page access token — reconnect the account");
  const pageAccessToken = decrypt(encryptedPageToken);
  const pageId = account.platform_user_id;
  const caption = platformMeta?.caption || "";

  const driveOAuth = await getDriveClient(orgId, brandId);
  const driveFileId = asset.processed_drive_file_id || asset.drive_file_id;
  const isVideo = (asset.file_type || "").startsWith("video/");

  const { webContentLink, cleanup } = await createTempPublicUrl(driveFileId, driveOAuth, { forVideo: isVideo });

  try {
    if (action === "fb_reel") {
      // Facebook Reel — video only
      console.log(`[facebook] Creating reel on page ${pageId}...`);
      const res = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${pageId}/video_reels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload_phase: "start",
            access_token: pageAccessToken,
          }),
        }
      );
      const initData = await res.json();
      if (initData.error) throw new Error(`Facebook reel init error: ${initData.error.message}`);

      const videoId = initData.video_id;

      // Download and upload the video
      const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);
      const uploadRes = await fetchWithTimeout(
        `https://rupload.facebook.com/video-upload/v19.0/${videoId}`,
        {
          method: "POST",
          headers: {
            "Authorization": `OAuth ${pageAccessToken}`,
            "offset": "0",
            "file_size": String(fileBuffer.length),
            "Content-Type": asset.file_type || "video/mp4",
          },
          body: new Uint8Array(fileBuffer),
        }
      );
      const uploadData = await uploadRes.json();
      if (!uploadData.success) throw new Error(`Facebook reel upload failed: ${JSON.stringify(uploadData)}`);

      // Finish the reel
      const finishRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${pageId}/video_reels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload_phase: "finish",
            video_id: videoId,
            description: caption,
            access_token: pageAccessToken,
          }),
        }
      );
      const finishData = await finishRes.json();
      if (finishData.error) throw new Error(`Facebook reel finish error: ${finishData.error.message}`);

      console.log(`[facebook] Reel published! ID: ${finishData.id || videoId}`);
      return finishData.id || videoId;

    } else if (action === "fb_story") {
      // Facebook Story
      console.log(`[facebook] Creating story on page ${pageId}...`);
      if (isVideo) {
        const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);
        // Upload video for story
        const formData = new FormData();
        formData.append("source", new Blob([new Uint8Array(fileBuffer)], { type: asset.file_type || "video/mp4" }));
        formData.append("access_token", pageAccessToken);

        const res = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${pageId}/video_stories`,
          { method: "POST", body: formData }
        );
        const data = await res.json();
        if (data.error) throw new Error(`Facebook video story error: ${data.error.message}`);
        console.log(`[facebook] Video story published! ID: ${data.id}`);
        return data.id;
      } else {
        // Image story — must upload photo to Facebook first (unpublished), then use its ID
        console.log(`[facebook] Uploading photo for story...`);
        const uploadRes = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${pageId}/photos`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: webContentLink,
              published: false,
              access_token: pageAccessToken,
            }),
          }
        );
        const uploadData = await uploadRes.json();
        if (uploadData.error) throw new Error(`Facebook photo upload error: ${uploadData.error.message}`);
        const fbPhotoId = uploadData.id;
        console.log(`[facebook] Photo uploaded (unpublished) ID: ${fbPhotoId}`);

        // Create story with the Facebook photo ID
        const res = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${pageId}/photo_stories`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              photo_id: fbPhotoId,
              access_token: pageAccessToken,
            }),
          }
        );
        const data = await res.json();
        if (data.error) throw new Error(`Facebook image story error: ${data.error.message}`);
        console.log(`[facebook] Image story published! ID: ${data.id}`);
        return data.id;
      }

    } else {
      // fb_post — standard feed post
      console.log(`[facebook] Creating post on page ${pageId}...`);
      if (isVideo) {
        // Video post
        const res = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${pageId}/videos`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_url: webContentLink,
              description: caption,
              access_token: pageAccessToken,
            }),
          }
        );
        const data = await res.json();
        if (data.error) throw new Error(`Facebook video post error: ${data.error.message}`);
        console.log(`[facebook] Video post published! ID: ${data.id}`);
        return data.id;
      } else {
        // Photo post
        const res = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${pageId}/photos`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: webContentLink,
              message: caption,
              access_token: pageAccessToken,
            }),
          }
        );
        const data = await res.json();
        if (data.error) throw new Error(`Facebook photo post error: ${data.error.message}`);
        console.log(`[facebook] Photo post published! ID: ${data.id}`);
        return data.id;
      }
    }
  } finally {
    await cleanup();
  }
}

// ─── TikTok Publisher ───

async function publishToTikTok(asset: any, account: any, _action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const openId = account.platform_metadata?.open_id || account.platform_user_id;
  const caption = platformMeta?.caption || "";

  // Step 1: Initialize video upload
  console.log(`[tiktok] Initializing video upload for ${openId}...`);
  const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);

  const initRes = await fetchWithTimeout(
    "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 150),
          privacy_level: "PUBLIC_TO_EVERYONE",
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileBuffer.length,
          chunk_size: fileBuffer.length,
          total_chunk_count: 1,
        },
      }),
    }
  );
  const initData = await initRes.json();
  if (initData.error?.code) throw new Error(`TikTok init error: ${initData.error.message || JSON.stringify(initData.error)}`);

  const uploadUrl = initData.data?.upload_url;
  const publishId = initData.data?.publish_id;
  if (!uploadUrl) throw new Error("TikTok didn't return an upload URL");

  // Step 2: Upload the video
  console.log(`[tiktok] Uploading video (${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB)...`);
  const uploadRes = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        "Content-Type": asset.file_type || "video/mp4",
        "Content-Range": `bytes 0-${fileBuffer.length - 1}/${fileBuffer.length}`,
      },
      body: new Uint8Array(fileBuffer),
    },
    120000 // 2 minute timeout for upload
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`TikTok video upload failed: ${err}`);
  }

  // Step 3: Check publish status (poll)
  console.log(`[tiktok] Video uploaded, checking publish status...`);
  const maxWait = 120000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const statusRes = await fetchWithTimeout(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: publishId }),
      }
    );
    const statusData = await statusRes.json();
    const status = statusData.data?.status;

    if (status === "PUBLISH_COMPLETE") {
      const videoId = statusData.data?.publicaly_available_post_id?.[0] || publishId;
      console.log(`[tiktok] Video published! ID: ${videoId}`);
      return videoId;
    }
    if (status === "FAILED") {
      throw new Error(`TikTok publish failed: ${statusData.data?.fail_reason || "Unknown"}`);
    }
    // Still processing, wait
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("TikTok publish timed out");
}

// ─── Twitter/X Publisher ───

async function publishToTwitter(asset: any, account: any, _action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const caption = platformMeta?.caption || "";
  const isImage = (asset.file_type || "").startsWith("image/");
  const isVideo = (asset.file_type || "").startsWith("video/");

  let mediaId: string | null = null;

  if (isImage || isVideo) {
    // Download file from Drive
    const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);

    if (isImage) {
      // Simple media upload for images
      console.log(`[twitter] Uploading image...`);
      const formData = new FormData();
      formData.append("media_data", Buffer.from(fileBuffer).toString("base64"));
      formData.append("media_category", "tweet_image");

      const uploadRes = await fetchWithTimeout(
        "https://upload.twitter.com/1.1/media/upload.json",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}` },
          body: formData,
        }
      );
      const uploadData = await uploadRes.json();
      if (uploadData.errors) throw new Error(`Twitter image upload error: ${JSON.stringify(uploadData.errors)}`);
      mediaId = uploadData.media_id_string;
    } else {
      // Chunked upload for video
      console.log(`[twitter] Starting chunked video upload...`);

      // INIT
      const initRes = await fetchWithTimeout(
        "https://upload.twitter.com/1.1/media/upload.json",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            command: "INIT",
            total_bytes: String(fileBuffer.length),
            media_type: asset.file_type || "video/mp4",
            media_category: "tweet_video",
          }),
        }
      );
      const initData = await initRes.json();
      if (initData.errors) throw new Error(`Twitter video init error: ${JSON.stringify(initData.errors)}`);
      mediaId = initData.media_id_string;

      // APPEND — upload in 5MB chunks
      const chunkSize = 5 * 1024 * 1024;
      for (let i = 0; i * chunkSize < fileBuffer.length; i++) {
        const chunk = fileBuffer.subarray(i * chunkSize, (i + 1) * chunkSize);
        const appendForm = new FormData();
        appendForm.append("command", "APPEND");
        appendForm.append("media_id", mediaId!);
        appendForm.append("segment_index", String(i));
        appendForm.append("media_data", Buffer.from(chunk).toString("base64"));

        await fetchWithTimeout(
          "https://upload.twitter.com/1.1/media/upload.json",
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}` },
            body: appendForm,
          }
        );
      }

      // FINALIZE
      const finalizeRes = await fetchWithTimeout(
        "https://upload.twitter.com/1.1/media/upload.json",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            command: "FINALIZE",
            media_id: mediaId!,
          }),
        }
      );
      const finalizeData = await finalizeRes.json();

      // Wait for processing if needed
      if (finalizeData.processing_info) {
        let checkAfter = finalizeData.processing_info.check_after_secs || 5;
        const maxWait = Date.now() + 120000;
        while (Date.now() < maxWait) {
          await new Promise((r) => setTimeout(r, checkAfter * 1000));
          const statusRes = await fetchWithTimeout(
            `https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=${mediaId}`,
            { headers: { "Authorization": `Bearer ${accessToken}` } }
          );
          const statusData = await statusRes.json();
          if (statusData.processing_info?.state === "succeeded") break;
          if (statusData.processing_info?.state === "failed") {
            throw new Error(`Twitter video processing failed: ${JSON.stringify(statusData.processing_info.error)}`);
          }
          checkAfter = statusData.processing_info?.check_after_secs || 5;
        }
      }

      console.log(`[twitter] Video uploaded: ${mediaId}`);
    }
  }

  // Create tweet
  console.log(`[twitter] Creating tweet...`);
  const tweetPayload: Record<string, unknown> = { text: caption };
  if (mediaId) {
    tweetPayload.media = { media_ids: [mediaId] };
  }

  const tweetRes = await fetchWithTimeout(
    "https://api.twitter.com/2/tweets",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tweetPayload),
    }
  );
  const tweetData = await tweetRes.json();
  if (tweetData.errors) throw new Error(`Twitter tweet error: ${JSON.stringify(tweetData.errors)}`);

  const tweetId = tweetData.data?.id;
  if (!tweetId) throw new Error("Twitter: tweet created but no ID returned");

  console.log(`[twitter] Tweet published! ID: ${tweetId}`);
  return tweetId;
}

// ─── Snapchat Publisher ───

async function publishToSnapchat(asset: any, account: any, _action: string, orgId: string, brandId: string, platformMeta: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const caption = platformMeta?.caption || "";

  // Download file from Drive
  const { buffer: fileBuffer } = await downloadFromDrive(asset, orgId, brandId);
  const isVideo = (asset.file_type || "").startsWith("video/");

  console.log(`[snapchat] Uploading creative...`);

  // Step 1: Create creative
  const creativeRes = await fetchWithTimeout(
    "https://adsapi.snapchat.com/v1/adaccounts/me/creatives",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        creatives: [{
          name: caption.slice(0, 100) || "MediaHub Story",
          type: isVideo ? "SNAP_AD" : "SNAP_AD",
          headline: caption.slice(0, 34),
          top_snap_media_id: "",
        }],
      }),
    }
  );
  const creativeData = await creativeRes.json();

  // Step 2: Upload media
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([new Uint8Array(fileBuffer)], { type: asset.file_type || "application/octet-stream" }));

  const uploadRes = await fetchWithTimeout(
    "https://adsapi.snapchat.com/v1/media",
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}` },
      body: uploadForm,
    }
  );
  const uploadData = await uploadRes.json();
  if (uploadData.request_status === "ERROR") {
    throw new Error(`Snapchat upload error: ${uploadData.debug_message || JSON.stringify(uploadData)}`);
  }

  const mediaId = uploadData.media?.[0]?.media?.id || creativeData.creatives?.[0]?.creative?.id || `sc_${Date.now()}`;
  console.log(`[snapchat] Story published! ID: ${mediaId}`);
  return mediaId;
}

// ─── Publish Worker ───

const publishQueue = new Queue("publish", { connection: redis });

const publishWorker = new Worker(
  "publish",
  async (job) => {
    const { publishJobId, assetId, socialAccountId, action, resizeOption, groupId, platformMeta } = job.data;

    console.log(`[publish] Processing job ${publishJobId}: ${action}`);

    // Idempotency check: if this job was already completed (e.g., published but marked failed
    // due to a timeout), don't re-publish — prevents duplicate posts on retry
    const { data: existingJob } = await db().from("publish_jobs")
      .select("status, platform_post_id")
      .eq("id", publishJobId)
      .single();
    if (existingJob?.platform_post_id && existingJob.status === "completed") {
      console.log(`[publish] Job ${publishJobId} already completed with post ${existingJob.platform_post_id} — skipping`);
      return;
    }

    await db().from("publish_jobs").update({ status: "processing" }).eq("id", publishJobId);

    try {
      const { data: asset, error: assetErr } = await db().from("media_assets").select("*").eq("id", assetId).single();
      if (assetErr || !asset) throw new Error("Asset not found: " + (assetErr?.message || assetId));

      const { data: account, error: accountErr } = await db().from("social_accounts").select("*").eq("id", socialAccountId).single();
      if (accountErr || !account) throw new Error("Social account not found: " + (accountErr?.message || socialAccountId));

      // Get brand and org info
      const { data: group, error: groupErr } = await db().from("media_groups").select("brand_id").eq("id", groupId).single();
      if (groupErr || !group) throw new Error("Media group not found: " + (groupErr?.message || groupId));
      const brandId = group.brand_id;

      const { data: brand, error: brandErr } = await db().from("brands").select("org_id").eq("id", brandId).single();
      if (brandErr || !brand) throw new Error("Brand not found: " + (brandErr?.message || brandId));
      const orgId = brand.org_id;

      let platformPostId: string;

      // ─── Route to correct platform publisher ───
      if (action === "yt_video" || action === "yt_short") {
        platformPostId = await publishToYouTube(asset, account, action, orgId, brandId, platformMeta);
      }
      else if (action.startsWith("ig_")) {
        platformPostId = await publishToInstagram(asset, account, action, orgId, brandId, groupId, platformMeta);
      }
      else if (action.startsWith("li_")) {
        platformPostId = await publishToLinkedIn(asset, account, action, orgId, brandId, platformMeta);
      }
      else if (action.startsWith("fb_")) {
        platformPostId = await publishToFacebook(asset, account, action, orgId, brandId, platformMeta);
      }
      else if (action.startsWith("tt_")) {
        platformPostId = await publishToTikTok(asset, account, action, orgId, brandId, platformMeta);
      }
      else if (action.startsWith("tw_")) {
        platformPostId = await publishToTwitter(asset, account, action, orgId, brandId, platformMeta);
      }
      else if (action.startsWith("sc_")) {
        platformPostId = await publishToSnapchat(asset, account, action, orgId, brandId, platformMeta);
      }
      else {
        throw new Error(`Unknown action: ${action}`);
      }

      // Mark as completed
      await db().from("publish_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        platform_post_id: platformPostId,
      }).eq("id", publishJobId);

      // Create initial post_analytics entry per publish_job (zero metrics — populated by analytics-fetch cron/refresh)
      // Skip stories — they expire after 24h and have no lasting analytics
      const isStory = action.endsWith("_story");
      const { data: postJob } = await db().from("publish_jobs").select("id, post_id").eq("id", publishJobId).single();
      if (postJob && !isStory) {
        try {
          // Check if analytics entry already exists for this specific publish_job
          const { data: existingAnalytics } = await db().from("post_analytics")
            .select("id")
            .eq("publish_job_id", publishJobId)
            .maybeSingle();

          if (!existingAnalytics) {
            await db().from("post_analytics").insert({
              post_id: postJob.post_id,
              social_account_id: socialAccountId,
              publish_job_id: publishJobId,
              views: 0,
              likes: 0,
              comments: 0,
              shares: 0,
              saves: 0,
              clicks: 0,
              reach: 0,
              impressions: 0,
              engagement_rate: 0,
              retention_rate: 0,
              watch_time_seconds: 0,
              platform_specific: {},
              fetched_at: null, // null = not yet fetched from platform
            });
            console.log(`[publish] Created initial analytics entry for job ${publishJobId}`);
          }
        } catch (e: any) {
          // Analytics entry creation should never break the publish flow
          console.error(`[publish] Failed to create analytics entry:`, e.message);
        }
      }

      // Check if all sibling jobs for this post are done
      if (postJob) {
        const { data: allJobs } = await db().from("publish_jobs").select("status").eq("post_id", postJob.post_id);
        const statuses = (allJobs || []).map((j: any) => j.status);
        const allCompleted = statuses.every((s: string) => s === "completed");
        const hasActiveJobs = statuses.some((s: string) => s === "processing" || s === "queued");
        const hasFailures = statuses.some((s: string) => s === "failed" || s === "dead");

        if (allCompleted) {
          await db().from("content_posts").update({ status: "published", published_at: new Date().toISOString() }).eq("id", postJob.post_id);
          await db().from("media_groups").update({ status: "published" }).eq("id", groupId);
        } else if (hasFailures && !hasActiveJobs) {
          // Some jobs failed/dead but none are still running — partial publish
          await db().from("content_posts").update({ status: "partial_published" }).eq("id", postJob.post_id);
        }
        // Otherwise, jobs are still in flight — leave post status as "publishing"
      }

      console.log(`[publish] Job ${publishJobId} completed: ${platformPostId}`);
    } catch (error: any) {
      const msg = error?.message || String(error);
      const ig = (error as any)?.igError;

      // Instagram integrity / "Action Block" (code 4, is_transient:false, e.g.
      // error_subcode 2207051). This is NOT a rate limit: it is a deliberate spam
      // block that retrying only deepens and prolongs. It is typically triggered
      // by posting the same media to many accounts in automated bursts. Fail the
      // job clearly and DO NOT retry.
      if (ig && ig.is_transient === false) {
        const detail = ig.error_user_title || ig.message || msg;
        console.error(`[publish] Job ${publishJobId} Instagram ACTION BLOCK (not retried): subcode=${ig.error_subcode} — ${detail}`);
        await db().from("publish_jobs").update({
          status: "failed",
          error_message: `Instagram action block (spam protection, subcode ${ig.error_subcode ?? "?"}) — not retried. Posting the same media to many accounts in bursts triggers this; space posts far apart and vary the content.`,
          attempt_count: (job.attemptsMade ?? 0) + 1,
        }).eq("id", publishJobId);
        return; // stop — do not hammer the block
      }

      // Genuinely transient platform rate limiting. Requeue this one job with a
      // long, JITTERED delay so a fan-out drains gradually as the window recovers,
      // rather than all jobs re-bursting at the same instant.
      const isRateLimited = (ig ? ig.is_transient === true : false) ||
        /rate limit|temporarily blocked|please wait a few minutes/i.test(msg);
      const rlAttempt = (job.data?.rateLimitAttempts ?? 0) + 1;
      const RL_MAX_REQUEUES = 8;
      if (isRateLimited && rlAttempt <= RL_MAX_REQUEUES) {
        const delayMs = 15 * 60 * 1000 + Math.floor(Math.random() * 20 * 60 * 1000); // 15–35 min
        console.warn(`[publish] Job ${publishJobId} rate-limited; requeueing in ~${Math.round(delayMs / 60000)}min (rate-limit attempt ${rlAttempt}/${RL_MAX_REQUEUES})`);
        await db().from("publish_jobs").update({
          status: "queued",
          error_message: `Rate-limited by platform; auto-retrying (attempt ${rlAttempt}/${RL_MAX_REQUEUES})`,
        }).eq("id", publishJobId);
        await publishQueue.add(
          job.name,
          { ...job.data, rateLimitAttempts: rlAttempt },
          { delay: delayMs, attempts: 1, removeOnComplete: true, removeOnFail: true }
        );
        return; // swallow — this job's work is carried by the delayed requeue
      }

      console.error(`[publish] Job ${publishJobId} failed:`, msg);

      await db().from("publish_jobs").update({
        status: job.attemptsMade + 1 >= 3 ? "dead" : "failed",
        error_message: msg,
        attempt_count: job.attemptsMade + 1,
      }).eq("id", publishJobId);

      throw error;
    }
  },
  {
    connection: redis,
    // Throughput is max(IG_PUBLISH_MIN_GAP_MS, W/concurrency), where W is the
    // real work time of one publish — measured at ~42s (container creation +
    // Instagram-side video processing + publish). The two knobs are balanced
    // when gap == W/concurrency; whichever is larger is the one that binds, and
    // raising only the other buys nothing.
    //   42000/21 = 2000ms, matching IG_PUBLISH_MIN_GAP_MS=2000  -> ~2.0s/job
    // Keep them in step: if you change one, recompute the other from 42000/C.
    // Measured progression: 32.8s (c3/g30s) -> 13.3s (c6/g10s) -> 3.5s (c12/g3s).
    // BACKED OFF from 21 after a live run at concurrency 21 / gap 2000 produced
    // 19 "Instagram media processing timed out" failures and, more seriously,
    // one account checkpoint ("You cannot access the app till you log in").
    // Instagram's own video processing — not our rate limit — is the ceiling:
    // x-app-usage stayed at 0% throughout. 6/10000 is the setting that ran a
    // full 76-account fan-out with 76/76 and zero errors.
    // Throughput is max(IG_PUBLISH_MIN_GAP_MS, W/concurrency) where W is the
    // real work time of one publish, measured at ~42s. At 12 slots that term is
    // 42/12 = 3.5s, which sits BELOW the 5000ms gap — so the gap is what binds
    // and the extra slots give headroom rather than speed. Lower the gap to go
    // faster; raise concurrency only once the gap drops under ~3.5s.
    // MAX practical setting. Throughput is max(gap, W/concurrency) with W (real
    // work per publish) measured at ~42s, so 42/20 = 2.1s/job against a 1000ms
    // gap -> concurrency is what binds, which is correct: the gap has no further
    // effect below ~2.1s.
    //
    // Deliberately 20 and not higher: a live run at concurrency 21 produced 19
    // "Instagram media processing timed out" failures, because many simultaneous
    // video jobs slow INSTAGRAM's own processing, not ours. Past ~20 you lose
    // more to timeouts than you gain in throughput.
    concurrency: 20,
    settings: {
      backoffStrategy: (attemptsMade: number) => {
        return Math.min(1000 * Math.pow(2, attemptsMade), 30000); // 1s, 2s, 4s, 8s... max 30s
      },
    },
  }
);

publishWorker.on("failed", async (job, err) => {
  if (job && job.attemptsMade >= 3) {
    console.log(`[publish] Job ${job.id} moved to dead letter queue`);
    const { publishJobId, postId, groupId } = job.data;
    await db().from("publish_jobs").update({ status: "dead" }).eq("id", publishJobId);

    // Check sibling jobs to determine post status
    const { data: allJobs } = await db().from("publish_jobs").select("status").eq("post_id", postId);
    const statuses = (allJobs || []).map((j: any) => j.status);
    const hasActiveJobs = statuses.some((s: string) => s === "processing" || s === "queued");
    const hasCompleted = statuses.some((s: string) => s === "completed");

    if (!hasActiveJobs) {
      if (hasCompleted) {
        await db().from("content_posts").update({ status: "partial_published" }).eq("id", postId);
      } else {
        await db().from("content_posts").update({ status: "failed" }).eq("id", postId);
      }
    }
  }
});

// ─── Platform Analytics Helpers ───

async function fetchYouTubeAnalytics(account: any, platformPostId: string, orgId: string) {
  const { data: creds } = await db().from("platform_credentials")
    .select("*").eq("org_id", orgId).eq("platform", "youtube").single();
  if (!creds) return null;

  const oauth2 = new google.auth.OAuth2(
    decrypt(creds.client_id_encrypted),
    decrypt(creds.client_secret_encrypted)
  );
  oauth2.setCredentials({
    access_token: decrypt(account.access_token_encrypted),
    refresh_token: account.refresh_token_encrypted ? decrypt(account.refresh_token_encrypted) : null,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });
  const response = await youtube.videos.list({
    id: [platformPostId],
    part: ["statistics", "contentDetails"],
  });

  const item = response.data.items?.[0];
  const stats = item?.statistics;
  if (!stats) return null;

  // Parse duration for retention calculation (e.g., "PT3M45S" → 225 seconds)
  const duration = item?.contentDetails?.duration || "";
  let totalSeconds = 0;
  const hourMatch = duration.match(/(\d+)H/);
  const minMatch = duration.match(/(\d+)M/);
  const secMatch = duration.match(/(\d+)S/);
  if (hourMatch) totalSeconds += parseInt(hourMatch[1]) * 3600;
  if (minMatch) totalSeconds += parseInt(minMatch[1]) * 60;
  if (secMatch) totalSeconds += parseInt(secMatch[1]);

  const views = parseInt(stats.viewCount || "0");

  // Fetch real retention data from YouTube Analytics API
  let avgViewDuration = 0;
  let watchTimeMinutes = 0;
  let shares = 0;
  try {
    const youtubeAnalytics = google.youtubeAnalytics({ version: "v2", auth: oauth2 });
    const analyticsRes = await youtubeAnalytics.reports.query({
      ids: "channel==MINE",
      startDate: "2020-01-01",
      endDate: new Date().toISOString().split("T")[0],
      metrics: "estimatedMinutesWatched,averageViewDuration,shares",
      filters: `video==${platformPostId}`,
    });
    const row = analyticsRes.data.rows?.[0];
    if (row) {
      watchTimeMinutes = row[0] as number || 0;
      avgViewDuration = row[1] as number || 0;
      shares = row[2] as number || 0;
    }
  } catch (e: any) {
    console.warn(`[analytics] YouTube Analytics API failed for ${platformPostId}: ${e.message}`);
    // Fallback: estimate from duration if API fails
    avgViewDuration = totalSeconds > 0 ? totalSeconds * 0.4 : 0;
    watchTimeMinutes = views * avgViewDuration / 60;
  }

  const retentionRate = totalSeconds > 0 && avgViewDuration > 0
    ? Math.round((avgViewDuration / totalSeconds) * 10000) / 100
    : 0;

  const likes = parseInt(stats.likeCount || "0");
  const commentsCount = parseInt(stats.commentCount || "0");
  const engagementRate = views > 0
    ? Math.round((likes + commentsCount + shares) / views * 10000) / 100
    : 0;

  return {
    views,
    likes,
    comments: commentsCount,
    shares,
    impressions: views,
    watch_time_seconds: Math.round(watchTimeMinutes * 60),
    avg_view_duration_seconds: Math.round(avgViewDuration),
    retention_rate: retentionRate,
    engagement_rate: engagementRate,
    platform_specific: { permalink: `https://www.youtube.com/watch?v=${platformPostId}` },
  };
}

async function fetchInstagramAnalytics(account: any, platformPostId: string) {
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  const pageToken = encryptedPageToken
    ? decrypt(encryptedPageToken)
    : decrypt(account.access_token_encrypted);
  if (!pageToken) return null;
  const apiBase = encryptedPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";

  // Get basic metrics + media type + permalink (this almost always works)
  const mediaRes = await fetchWithTimeout(
    `${apiBase}/${platformPostId}?fields=like_count,comments_count,timestamp,media_type,permalink&access_token=${pageToken}`
  );
  const mediaData = await mediaRes.json();
  if (mediaData.error) {
    console.error(`[analytics] IG media fetch error for ${platformPostId}:`, mediaData.error.message);
    return null;
  }

  const likes = mediaData.like_count || 0;
  const commentsCount = mediaData.comments_count || 0;
  const isVideo = mediaData.media_type === "VIDEO" || mediaData.media_type === "REELS";

  // Try Insights API — metrics differ by content type
  let views = 0;
  let impressions = 0;
  let reach = 0;
  let saved = 0;
  let shares = 0;
  let engagementMetric = 0;
  let avgWatchTimeMs = 0;

  try {
    // Common metrics for all content types
    const commonMetrics = "views,reach,saved,total_interactions,shares,likes,comments";
    const insightsRes = await fetchWithTimeout(
      `${apiBase}/${platformPostId}/insights?metric=${commonMetrics}&access_token=${pageToken}`
    );
    const insightsData = await insightsRes.json();

    if (!insightsData.error) {
      const insightsList = insightsData.data || [];
      const getMetric = (name: string) => insightsList.find((i: any) => i.name === name)?.values?.[0]?.value || 0;

      views = getMetric("views");
      reach = getMetric("reach");
      saved = getMetric("saved");
      engagementMetric = getMetric("total_interactions");
      shares = getMetric("shares");
    } else {
      console.warn(`[analytics] IG insights unavailable for ${platformPostId}: ${insightsData.error.message}`);
    }

    // For FEED posts (images/carousels): "impressions" is a separate metric (total times shown, incl. repeats)
    // For reels: impressions metric is deprecated and will never be available — leave as 0
    if (!isVideo) {
      try {
        const impRes = await fetchWithTimeout(
          `${apiBase}/${platformPostId}/insights?metric=impressions&access_token=${pageToken}`
        );
        const impData = await impRes.json();
        if (!impData.error) {
          impressions = impData.data?.[0]?.values?.[0]?.value || 0;
        }
      } catch { /* impressions may not be available for newer posts */ }
    }

    // For reels: fetch average watch time
    if (isVideo) {
      try {
        const watchRes = await fetchWithTimeout(
          `${apiBase}/${platformPostId}/insights?metric=ig_reels_avg_watch_time&access_token=${pageToken}`
        );
        const watchData = await watchRes.json();
        if (!watchData.error) {
          avgWatchTimeMs = watchData.data?.[0]?.values?.[0]?.value || 0;
        }
      } catch { /* avg watch time may not be available */ }
    }
  } catch (e: any) {
    console.warn(`[analytics] IG insights fetch failed for ${platformPostId}:`, e.message);
  }

  // Engagement: total_interactions / reach (industry standard for Instagram)
  const engageDenominator = reach || views || 0;
  const engagementRate = engageDenominator > 0
    ? Math.round((engagementMetric || (likes + commentsCount + shares + saved)) / engageDenominator * 10000) / 100
    : 0;

  // For the combined Views/Impressions column:
  // Reels: views = plays. Images: views metric works on some accounts, impressions on business accounts.
  // Use whichever is available: impressions > views > 0
  const viewsValue = isVideo ? views : (impressions || views || 0);

  return {
    views: viewsValue,
    likes,
    comments: commentsCount,
    shares,
    saves: saved,
    reach,
    impressions: isVideo ? 0 : (impressions || views || 0), // Reels: — (deprecated). Images: best available
    retention_rate: 0, // Instagram doesn't provide retention (YouTube only)
    engagement_rate: engagementRate,
    watch_time_seconds: avgWatchTimeMs > 0 ? Math.round(avgWatchTimeMs / 1000) : 0,
    platform_specific: { permalink: mediaData.permalink || null, media_type: mediaData.media_type },
  };
}

async function fetchLinkedInAnalytics(account: any, platformPostId: string) {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(platformPostId)}/statisticsCount`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "LinkedIn-Version": "202401",
      },
    }
  );

  if (!res.ok) return null;
  const data = await res.json();

  // Construct LinkedIn permalink from share URN
  const permalink = platformPostId.startsWith("urn:li:")
    ? `https://www.linkedin.com/feed/update/${platformPostId}`
    : null;

  return {
    views: data.impressionCount || 0,
    likes: data.likeCount || 0,
    comments: data.commentCount || 0,
    shares: data.shareCount || 0,
    impressions: data.impressionCount || 0,
    clicks: data.clickCount || 0,
    engagement_rate: (data.impressionCount || 0) > 0
      ? Math.round(((data.likeCount || 0) + (data.commentCount || 0) + (data.shareCount || 0) + (data.clickCount || 0)) / data.impressionCount * 10000) / 100
      : 0,
    platform_specific: { permalink },
  };
}

async function fetchFacebookAnalytics(account: any, platformPostId: string) {
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  if (!encryptedPageToken) return null;
  const pageToken = decrypt(encryptedPageToken);

  // Facebook requires pageId_postId format for the Graph API
  const pageId = account.platform_user_id || account.platform_metadata?.page_id;
  const fullPostId = platformPostId.includes("_") ? platformPostId : `${pageId}_${platformPostId}`;

  // Step 1: Get basic metrics + video attachment ID + permalink
  const postRes = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${fullPostId}?fields=reactions.summary(true).limit(0),comments.summary(true).limit(0),shares,permalink_url,attachments{target{id},type}&access_token=${pageToken}`
  );
  const postData = await postRes.json();
  if (postData.error) {
    console.error(`[analytics] FB post fetch error for ${fullPostId}:`, postData.error.message);
    return null;
  }

  const shares = postData.shares?.count || 0;
  const reactions = postData.reactions?.summary?.total_count || 0;
  const comments = postData.comments?.summary?.total_count || 0;

  // Step 2: Try video_insights if post has a video attachment (reels/videos)
  let views = 0;
  let reach = 0;
  let avgWatchTimeMs = 0;
  let totalWatchTimeMs = 0;

  const videoId = postData.attachments?.data?.[0]?.target?.id;
  if (videoId) {
    try {
      // Reels metrics (work for FB reels)
      const reelsRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${videoId}/video_insights?metric=fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched,post_video_view_time&period=lifetime&access_token=${pageToken}`
      );
      const reelsData = await reelsRes.json();
      if (!reelsData.error && reelsData.data && reelsData.data.length > 0) {
        const getMetric = (name: string) => (reelsData.data || []).find((i: any) => i.name === name)?.values?.[0]?.value || 0;
        views = getMetric("fb_reels_total_plays");
        reach = getMetric("post_impressions_unique");
        avgWatchTimeMs = getMetric("post_video_avg_time_watched");
        totalWatchTimeMs = getMetric("post_video_view_time");
      }

      // If reels metrics didn't return views, try standard video metrics
      if (views === 0) {
        const stdRes = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${videoId}/video_insights?metric=total_video_views,total_video_impressions_unique,total_video_avg_time_watched&period=lifetime&access_token=${pageToken}`
        );
        const stdData = await stdRes.json();
        if (!stdData.error && stdData.data && stdData.data.length > 0) {
          const getMetric = (name: string) => (stdData.data || []).find((i: any) => i.name === name)?.values?.[0]?.value || 0;
          views = views || getMetric("total_video_views");
          reach = reach || getMetric("total_video_impressions_unique");
          avgWatchTimeMs = avgWatchTimeMs || getMetric("total_video_avg_time_watched");
        }
      }
    } catch (e: any) {
      console.warn(`[analytics] FB video_insights failed for ${videoId}:`, e.message);
    }
  }

  const engageDenominator = reach || views || 0;

  return {
    views,
    likes: reactions,
    comments,
    shares,
    reach,
    impressions: 0, // Facebook deprecated post_impressions — show —
    watch_time_seconds: avgWatchTimeMs > 0 ? Math.round(avgWatchTimeMs / 1000) : 0,
    engagement_rate: engageDenominator > 0
      ? Math.round((reactions + comments + shares) / engageDenominator * 10000) / 100
      : 0,
    platform_specific: { permalink: postData.permalink_url || null, video_id: videoId || null },
  };
}

async function fetchTikTokAnalytics(account: any, platformPostId: string) {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    "https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filters: { video_ids: [platformPostId] },
      }),
    }
  );
  const data = await res.json();
  const video = data.data?.videos?.[0];
  if (!video) return null;

  const views = video.view_count || 0;
  const likes = video.like_count || 0;
  const comments = video.comment_count || 0;
  const shares = video.share_count || 0;

  return {
    views,
    likes,
    comments,
    shares,
    impressions: views,
    engagement_rate: views > 0
      ? Math.round((likes + comments + shares) / views * 10000) / 100
      : 0,
    platform_specific: { permalink: video.share_url || `https://www.tiktok.com/@/video/${platformPostId}` },
  };
}

async function fetchTwitterAnalytics(account: any, platformPostId: string) {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    `https://api.twitter.com/2/tweets/${platformPostId}?tweet.fields=public_metrics`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (data.errors) return null;

  const metrics = data.data?.public_metrics;
  if (!metrics) return null;

  const impressions = metrics.impression_count || 0;
  const likes = metrics.like_count || 0;
  const replies = metrics.reply_count || 0;
  const retweets = metrics.retweet_count || 0;
  const quotes = metrics.quote_count || 0;

  return {
    views: impressions,
    likes,
    comments: replies,
    shares: retweets + quotes,
    impressions,
    engagement_rate: impressions > 0
      ? Math.round((likes + replies + retweets + quotes) / impressions * 10000) / 100
      : 0,
    platform_specific: { permalink: `https://x.com/i/status/${platformPostId}` },
  };
}

async function fetchSnapchatAnalytics(_account: any, _platformPostId: string) {
  // Snapchat Marketing API has limited analytics support
  // Basic metrics may not be available for all content types
  console.log("[analytics] Snapchat analytics: limited API support, skipping");
  return null;
}

// ─── Analytics Fetch Worker ───

const analyticsWorker = new Worker(
  "analytics-fetch",
  async (job) => {
    // Support both cron (all posts) and manual trigger (specific brand + optional platform)
    const brandId = job.data?.brandId as string | undefined;
    const platformFilter = job.data?.platform as string | undefined;
    const platformActionPrefix: Record<string, string> = {
      instagram: "ig_", youtube: "yt_", linkedin: "li_", facebook: "fb_",
      tiktok: "tt_", twitter: "tw_", snapchat: "sc_",
    };
    const actionPrefix = platformFilter ? platformActionPrefix[platformFilter] : null;

    console.log(`[analytics] Fetching analytics${brandId ? ` for brand ${brandId}` : " for all published posts"}${platformFilter ? ` (${platformFilter} only)` : ""}...`);

    let query = db().from("content_posts")
      .select("id, brand_id, publish_jobs(id, social_account_id, platform_post_id, action, status)")
      .in("status", ["published", "partial_published"]);

    if (brandId) {
      query = query.eq("brand_id", brandId);
    }

    const { data: posts } = await query;

    let fetched = 0;
    let errors = 0;

    for (const post of posts || []) {
      for (const pj of post.publish_jobs || []) {
        // If platform filter is set, skip non-matching actions
        if (actionPrefix && !pj.action.startsWith(actionPrefix)) continue;
        if (pj.status !== "completed" || !pj.platform_post_id) continue;
        // Skip stories — ephemeral content, no lasting analytics
        if (pj.action.endsWith("_story")) continue;

        try {
          // Get the social account
          const { data: account } = await db().from("social_accounts")
            .select("*").eq("id", pj.social_account_id).single();
          if (!account) continue;

          // Get brand's org_id
          const { data: brand } = await db().from("brands")
            .select("org_id").eq("id", post.brand_id).single();
          if (!brand) continue;

          let analytics: Record<string, any> | null = null;

          if (pj.action.startsWith("yt_")) {
            analytics = await fetchYouTubeAnalytics(account, pj.platform_post_id, brand.org_id);
          } else if (pj.action.startsWith("ig_")) {
            analytics = await fetchInstagramAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("li_")) {
            analytics = await fetchLinkedInAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("fb_")) {
            analytics = await fetchFacebookAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("tt_")) {
            analytics = await fetchTikTokAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("tw_")) {
            analytics = await fetchTwitterAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("sc_")) {
            analytics = await fetchSnapchatAnalytics(account, pj.platform_post_id);
          }

          // If fetch failed but we can construct a permalink, store at least that
          if (!analytics && pj.action.startsWith("li_") && pj.platform_post_id?.startsWith("urn:li:")) {
            analytics = {
              views: 0, likes: 0, comments: 0, shares: 0, impressions: 0,
              platform_specific: { permalink: `https://www.linkedin.com/feed/update/${pj.platform_post_id}` },
            };
          }

          if (analytics) {
            // Upsert latest snapshot in post_analytics (per publish_job)
            const { data: existing } = await db().from("post_analytics")
              .select("id")
              .eq("publish_job_id", pj.id)
              .maybeSingle();

            if (existing) {
              await db().from("post_analytics").update({
                ...analytics,
                fetched_at: new Date().toISOString(),
              }).eq("id", existing.id);
            } else {
              // Fallback: check by post_id + social_account_id (legacy rows without publish_job_id)
              const { data: legacyRow } = await db().from("post_analytics")
                .select("id")
                .eq("post_id", post.id)
                .eq("social_account_id", pj.social_account_id)
                .is("publish_job_id", null)
                .maybeSingle();

              if (legacyRow) {
                // Upgrade legacy row: set publish_job_id and update analytics
                await db().from("post_analytics").update({
                  publish_job_id: pj.id,
                  ...analytics,
                  fetched_at: new Date().toISOString(),
                }).eq("id", legacyRow.id);
              } else {
                await db().from("post_analytics").insert({
                  post_id: post.id,
                  social_account_id: pj.social_account_id,
                  publish_job_id: pj.id,
                  ...analytics,
                  fetched_at: new Date().toISOString(),
                });
              }
            }

            // Append history snapshot for progress tracking
            await appendAnalyticsHistory(post.id, pj.social_account_id, analytics, pj.id);

            fetched++;
          }
        } catch (e: any) {
          console.error(`[analytics] Error fetching for job ${pj.id}:`, e.message);
          errors++;
        }
      }
    }

    console.log(`[analytics] Done: ${fetched} fetched, ${errors} errors`);
    await updatePredictionAccuracy();
  },
  { connection: redis }
);

// ─── Analytics History Helper ───

async function appendAnalyticsHistory(postId: string, socialAccountId: string, analytics: any, publishJobId?: string) {
  try {
    await db().from("post_analytics_history").insert({
      post_id: postId,
      social_account_id: socialAccountId,
      publish_job_id: publishJobId || null,
      views: analytics.views || 0,
      likes: analytics.likes || 0,
      comments: analytics.comments || 0,
      shares: analytics.shares || 0,
      saves: analytics.saves || 0,
      clicks: analytics.clicks || 0,
      reach: analytics.reach || 0,
      impressions: analytics.impressions || 0,
      engagement_rate: analytics.engagement_rate || 0,
      retention_rate: analytics.retention_rate || 0,
      watch_time_seconds: analytics.watch_time_seconds || 0,
      snapshot_at: new Date().toISOString(),
    });
  } catch {
    // History append should never break the main flow
  }
}

// ─── Historical Import Helpers ───

async function importInstagramHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const igUserId = account.platform_user_id;
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  const pageToken = encryptedPageToken
    ? decrypt(encryptedPageToken)
    : decrypt(account.access_token_encrypted);
  if (!pageToken) throw new Error("No access token for Instagram");
  const apiBase = encryptedPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";

  console.log(`[historical] Importing Instagram history for @${account.platform_username}...`);

  let url: string | null = `${apiBase}/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink&limit=50&access_token=${pageToken}`;
  let totalImported = 0;

  while (url && true) {
    const res = await fetchWithTimeout(url, {}, 30000);
    const data = await res.json();

    if (data.error) {
      console.error("[historical] Instagram API error:", data.error.message);
      break;
    }

    for (const post of data.data || []) {
      try {
        // Create content post (analytics-only, no media_group needed)
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: post.timestamp,
          source: "api",
          caption_overrides: {
            caption: post.caption || "",
            permalink: post.permalink || "",
            thumbnail_url: post.thumbnail_url || post.media_url || "",
          },
        }).select().single();

        if (!contentPost) continue;

        // Create publish job record (no media_asset needed)
        const isVideo = post.media_type === "VIDEO" || post.media_type === "REELS";
        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: isVideo ? "ig_reel" : (post.media_type === "CAROUSEL_ALBUM" ? "ig_carousel" : "ig_post"),
          status: "completed",
          platform_post_id: post.id,
          completed_at: post.timestamp,
        }).select("id").single();

        // Fetch insights for this post (use same apiBase as media endpoint)
        let insights: Record<string, number> = {};
        try {
          // Common metrics for all content types
          const insightsRes = await fetchWithTimeout(
            `${apiBase}/${post.id}/insights?metric=views,reach,saved,total_interactions,shares,likes,comments&access_token=${pageToken}`,
            {}, 10000
          );
          const insightsData = await insightsRes.json();
          if (!insightsData.error) {
            const metricsList = insightsData.data || [];
            const getMetric = (name: string) => metricsList.find((i: any) => i.name === name)?.values?.[0]?.value || 0;
            insights = {
              views: getMetric("views"),
              reach: getMetric("reach"),
              saves: getMetric("saved"),
              total_interactions: getMetric("total_interactions"),
              shares: getMetric("shares"),
              ig_likes: getMetric("likes"),
              ig_comments: getMetric("comments"),
            };
          }

          // For images/carousels: fetch impressions separately (different metric from views)
          // For reels: impressions is deprecated — leave as 0
          if (!isVideo) {
            try {
              const impRes = await fetchWithTimeout(
                `${apiBase}/${post.id}/insights?metric=impressions&access_token=${pageToken}`,
                {}, 10000
              );
              const impData = await impRes.json();
              if (!impData.error) {
                insights.impressions = impData.data?.[0]?.values?.[0]?.value || 0;
              }
            } catch { /* impressions may not be available */ }
          }
        } catch {
          // Insights may not be available for old posts or without permissions
        }

        const likes = post.like_count || 0;
        const commentsCount = post.comments_count || 0;

        // Save analytics — use real insights data
        // For images: impressions (business accounts) or views (creator accounts) — use best available
        const imageViewsValue = isVideo ? (insights.views || 0) : (insights.impressions || insights.views || 0);
        const igAnalytics = {
          views: imageViewsValue,
          likes: insights.ig_likes || likes,
          comments: insights.ig_comments || commentsCount,
          shares: insights.shares || 0,
          saves: insights.saves || 0,
          reach: insights.reach || 0,
          impressions: isVideo ? 0 : (insights.impressions || insights.views || 0),
          engagement_rate: insights.total_interactions && insights.reach
            ? Math.round(insights.total_interactions / insights.reach * 10000) / 100
            : 0,
        };

        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...igAnalytics,
          platform_specific: { permalink: post.permalink, media_type: post.media_type },
          fetched_at: new Date().toISOString(),
        });

        await appendAnalyticsHistory(contentPost.id, account.id, igAnalytics, publishJob?.id);

        totalImported++;

        // Rate limiting — Instagram API has ~200 calls/hour per user
        if (totalImported % 10 === 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e: any) {
        console.error(`[historical] Error importing IG post ${post.id}:`, e.message);
      }
    }

    // Pagination
    url = data.paging?.next || null;
  }

  console.log(`[historical] Instagram import complete: ${totalImported} posts`);
  return totalImported;
}

async function importYouTubeHistory(account: any, brandId: string, orgId: string): Promise<number> {
  const { data: creds } = await db().from("platform_credentials")
    .select("*").eq("org_id", orgId).eq("platform", "youtube").single();
  if (!creds) throw new Error("YouTube credentials not found");

  const oauth2 = new google.auth.OAuth2(
    decrypt(creds.client_id_encrypted),
    decrypt(creds.client_secret_encrypted)
  );
  oauth2.setCredentials({
    access_token: decrypt(account.access_token_encrypted),
    refresh_token: account.refresh_token_encrypted ? decrypt(account.refresh_token_encrypted) : null,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // Step 1: Get the channel's "uploads" playlist ID
  // This is much more reliable than search.list, which often returns only ~25 results
  // and costs 100 quota units per call vs 1 for playlistItems.list
  const channelRes = await youtube.channels.list({
    id: [account.platform_user_id],
    part: ["contentDetails"],
  });

  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.error("[historical] YouTube: Could not find uploads playlist for channel", account.platform_user_id);
    return 0;
  }

  console.log(`[historical] YouTube: Using uploads playlist ${uploadsPlaylistId}`);

  let pageToken: string | undefined;
  let totalImported = 0;

  do {
    // Step 2: List videos from the uploads playlist (1 quota unit per call)
    const playlistRes = await youtube.playlistItems.list({
      playlistId: uploadsPlaylistId,
      part: ["snippet", "contentDetails"],
      maxResults: 50,
      pageToken,
    });

    const videoIds = (playlistRes.data.items || [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));

    if (videoIds.length === 0) break;

    // Step 3: Batch-fetch statistics and duration for these videos
    const statsRes = await youtube.videos.list({
      id: videoIds,
      part: ["statistics", "snippet", "contentDetails"],
    });

    for (const video of statsRes.data.items || []) {
      try {
        const stats = video.statistics || {};
        const snippet = video.snippet || {};

        // Create content post (analytics-only, no media_group needed)
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: snippet.publishedAt,
          source: "api",
          caption_overrides: {
            caption: snippet.title || snippet.description || "",
            permalink: `https://www.youtube.com/watch?v=${video.id}`,
          },
        }).select().single();

        if (!contentPost) continue;

        // Determine if short
        const duration = video.contentDetails?.duration || "";
        const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        const totalSeconds = durationMatch
          ? (parseInt(durationMatch[1] || "0") * 3600) + (parseInt(durationMatch[2] || "0") * 60) + parseInt(durationMatch[3] || "0")
          : 999;
        const isShort = totalSeconds <= 60 && !duration.includes("H");

        // Create publish job (no media_asset needed)
        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: isShort ? "yt_short" : "yt_video",
          status: "completed",
          platform_post_id: video.id,
          completed_at: snippet.publishedAt,
        }).select("id").single();

        // Save analytics
        const ytAnalytics = {
          views: parseInt(stats.viewCount || "0"),
          likes: parseInt(stats.likeCount || "0"),
          comments: parseInt(stats.commentCount || "0"),
          shares: 0,
        };

        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...ytAnalytics,
          platform_specific: { video_id: video.id, duration: video.contentDetails?.duration, permalink: `https://www.youtube.com/watch?v=${video.id}` },
          fetched_at: new Date().toISOString(),
        });

        await appendAnalyticsHistory(contentPost.id, account.id, ytAnalytics, publishJob?.id);

        totalImported++;
      } catch (e: any) {
        console.error(`[historical] Error importing YT video ${video.id}:`, e.message);
      }
    }

    pageToken = playlistRes.data.nextPageToken || undefined;

    // Rate limiting
    if (totalImported % 50 === 0 && totalImported > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } while (pageToken && true);

  console.log(`[historical] YouTube import complete: ${totalImported} videos`);
  return totalImported;
}

async function importFacebookHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const pageId = account.platform_user_id;
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  if (!encryptedPageToken) throw new Error("No page access token");
  const pageToken = decrypt(encryptedPageToken);

  console.log(`[historical] Importing Facebook history for page ${account.platform_username}...`);

  let url: string | null = `https://graph.facebook.com/v19.0/${pageId}/feed?fields=id,message,created_time,permalink_url,attachments{target{id},type,media_type}&limit=50&access_token=${pageToken}`;
  let totalImported = 0;

  while (url) {
    const res = await fetchWithTimeout(url, {}, 30000);
    const data = await res.json();

    if (data.error) {
      console.error("[historical] Facebook API error:", data.error.message);
      break;
    }

    for (const post of data.data || []) {
      try {
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: post.created_time,
          source: "api",
          caption_overrides: {
            caption: post.message || "",
            permalink: post.permalink_url || "",
          },
        }).select().single();

        if (!contentPost) continue;

        const attachmentType = post.attachments?.data?.[0]?.media_type || post.attachments?.data?.[0]?.type || "";
        const action = attachmentType.toLowerCase().includes("video") ? "fb_reel" : "fb_post";
        const pageId = account.platform_user_id || account.platform_metadata?.page_id;
        const fullPostId = post.id.includes("_") ? post.id : `${pageId}_${post.id}`;

        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action,
          status: "completed",
          platform_post_id: post.id,
          completed_at: post.created_time,
        }).select("id").single();

        // Fetch basic metrics using pageId_postId format
        let likes = 0, comments = 0, shares = 0;
        try {
          const metricsRes = await fetchWithTimeout(
            `https://graph.facebook.com/v19.0/${fullPostId}?fields=reactions.summary(true).limit(0),comments.summary(true).limit(0),shares&access_token=${pageToken}`,
            {}, 10000
          );
          const metricsData = await metricsRes.json();
          if (!metricsData.error) {
            likes = metricsData.reactions?.summary?.total_count || 0;
            comments = metricsData.comments?.summary?.total_count || 0;
            shares = metricsData.shares?.count || 0;
          }
        } catch { /* metrics may not be available */ }

        // Fetch video_insights if post has a video attachment
        let views = 0, reach = 0, avgWatchTimeMs = 0;
        const videoId = post.attachments?.data?.[0]?.target?.id;
        if (videoId) {
          try {
            const vidRes = await fetchWithTimeout(
              `https://graph.facebook.com/v19.0/${videoId}/video_insights?metric=fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched&period=lifetime&access_token=${pageToken}`,
              {}, 10000
            );
            const vidData = await vidRes.json();
            if (!vidData.error && vidData.data && vidData.data.length > 0) {
              const getMetric = (name: string) => (vidData.data || []).find((i: any) => i.name === name)?.values?.[0]?.value || 0;
              views = getMetric("fb_reels_total_plays");
              reach = getMetric("post_impressions_unique");
              avgWatchTimeMs = getMetric("post_video_avg_time_watched");
            }
            // Fallback to standard video metrics
            if (views === 0) {
              const stdRes = await fetchWithTimeout(
                `https://graph.facebook.com/v19.0/${videoId}/video_insights?metric=total_video_views,total_video_impressions_unique&period=lifetime&access_token=${pageToken}`,
                {}, 10000
              );
              const stdData = await stdRes.json();
              if (!stdData.error && stdData.data && stdData.data.length > 0) {
                const getM = (name: string) => (stdData.data || []).find((i: any) => i.name === name)?.values?.[0]?.value || 0;
                views = views || getM("total_video_views");
                reach = reach || getM("total_video_impressions_unique");
              }
            }
          } catch { /* video insights may not be available */ }
        }

        const engageDenominator = reach || views || 0;
        const fbAnalytics = {
          views,
          likes,
          comments,
          shares,
          reach,
          impressions: 0,
          watch_time_seconds: avgWatchTimeMs > 0 ? Math.round(avgWatchTimeMs / 1000) : 0,
          engagement_rate: engageDenominator > 0
            ? Math.round((likes + comments + shares) / engageDenominator * 10000) / 100
            : 0,
        };
        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...fbAnalytics,
          platform_specific: { permalink: post.permalink_url, type: attachmentType, video_id: videoId },
          fetched_at: new Date().toISOString(),
        });
        await appendAnalyticsHistory(contentPost.id, account.id, fbAnalytics, publishJob?.id);

        totalImported++;

        if (totalImported % 10 === 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e: any) {
        console.error(`[historical] Error importing FB post ${post.id}:`, e.message);
      }
    }

    url = data.paging?.next || null;
  }

  console.log(`[historical] Facebook import complete: ${totalImported} posts`);
  return totalImported;
}

async function importLinkedInHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const accessToken = decrypt(account.access_token_encrypted);
  const personUrn = account.platform_metadata?.person_urn;
  if (!personUrn) throw new Error("No LinkedIn person URN found");

  const authorUrn = encodeURIComponent(personUrn);

  console.log(`[historical] Importing LinkedIn history for ${account.platform_username}...`);

  let start = 0;
  const count = 50;
  let totalImported = 0;
  let hasMore = true;

  while (hasMore && true) {
    // LinkedIn Posts API — fetch user's own posts
    const res = await fetchWithTimeout(
      `https://api.linkedin.com/rest/posts?author=${authorUrn}&q=author&count=${count}&start=${start}&sortBy=LAST_MODIFIED`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "LinkedIn-Version": "202401",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
      30000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[historical] LinkedIn API error (${res.status}):`, errText);
      // If 403, the scope r_member_social may not be granted — user needs to reconnect
      if (res.status === 403) {
        console.error("[historical] LinkedIn: r_member_social scope likely not granted. User must reconnect.");
      }
      break;
    }

    const data = await res.json();
    const posts = data.elements || [];

    if (posts.length === 0) break;

    for (const post of posts) {
      try {
        const postId = post.id;
        const publishedAt = post.createdAt
          ? new Date(post.createdAt).toISOString()
          : post.lastModifiedAt
            ? new Date(post.lastModifiedAt).toISOString()
            : new Date().toISOString();

        // Determine action based on content type
        const hasArticle = post.content?.article;
        const action = hasArticle ? "li_article" : "li_post";

        // Create content post
        const liPermalink = postId.startsWith("urn:li:") ? `https://www.linkedin.com/feed/update/${postId}` : "";
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: publishedAt,
          source: "api",
          caption_overrides: {
            caption: post.commentary || post.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "",
            permalink: liPermalink,
          },
        }).select().single();

        if (!contentPost) continue;

        // Create publish job
        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action,
          status: "completed",
          platform_post_id: postId,
          completed_at: publishedAt,
        }).select("id").single();

        // Fetch social actions (likes, comments, shares) for this post
        let metrics: Record<string, number> = {};
        try {
          const statsRes = await fetchWithTimeout(
            `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(postId)}?fields=likes,comments,shares`,
            {
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "LinkedIn-Version": "202401",
                "X-Restli-Protocol-Version": "2.0.0",
              },
            },
            10000
          );
          if (statsRes.ok) {
            const statsData = await statsRes.json();
            metrics = {
              likes: statsData.likesSummary?.totalLikes || 0,
              comments: statsData.commentsSummary?.totalFirstLevelComments || 0,
              shares: statsData.sharesSummary?.totalShares || 0,
            };
          }
        } catch {
          // Metrics may not be available
        }

        const permalink = postId.startsWith("urn:li:") ? `https://www.linkedin.com/feed/update/${postId}` : null;
        const liAnalytics = {
          views: 0,
          likes: metrics.likes || 0,
          comments: metrics.comments || 0,
          shares: metrics.shares || 0,
        };

        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...liAnalytics,
          platform_specific: { post_urn: postId, content_type: action, permalink },
          fetched_at: new Date().toISOString(),
        });

        await appendAnalyticsHistory(contentPost.id, account.id, liAnalytics, publishJob?.id);

        totalImported++;

        // Rate limiting — LinkedIn is strict (~100 calls/day for some apps)
        if (totalImported % 10 === 0) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (e: any) {
        console.error(`[historical] Error importing LinkedIn post ${post.id}:`, e.message);
      }
    }

    start += posts.length;
    hasMore = posts.length === count;
  }

  console.log(`[historical] LinkedIn import complete: ${totalImported} posts`);
  return totalImported;
}

async function importTikTokHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const accessToken = decrypt(account.access_token_encrypted);

  console.log(`[historical] Importing TikTok history for @${account.platform_username}...`);

  let cursor = 0;
  let totalImported = 0;
  let hasMore = true;

  while (hasMore && true) {
    const res = await fetchWithTimeout(
      "https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,share_url,duration,like_count,comment_count,share_count,view_count",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cursor, max_count: 20 }),
      },
      30000
    );
    const data = await res.json();

    if (data.error?.code) {
      console.error("[historical] TikTok API error:", data.error.message);
      break;
    }

    for (const video of data.data?.videos || []) {
      try {
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: video.create_time ? new Date(video.create_time * 1000).toISOString() : new Date().toISOString(),
          source: "api",
          caption_overrides: {
            caption: video.title || "",
            permalink: video.share_url || "",
          },
        }).select().single();

        if (!contentPost) continue;

        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: "tt_video",
          status: "completed",
          platform_post_id: video.id,
          completed_at: video.create_time ? new Date(video.create_time * 1000).toISOString() : new Date().toISOString(),
        }).select("id").single();

        const ttAnalytics = { views: video.view_count || 0, likes: video.like_count || 0, comments: video.comment_count || 0, shares: video.share_count || 0 };
        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...ttAnalytics,
          platform_specific: { share_url: video.share_url, duration: video.duration },
          fetched_at: new Date().toISOString(),
        });
        await appendAnalyticsHistory(contentPost.id, account.id, ttAnalytics, publishJob?.id);

        totalImported++;
      } catch (e: any) {
        console.error(`[historical] Error importing TikTok video ${video.id}:`, e.message);
      }
    }

    hasMore = data.data?.has_more || false;
    cursor = data.data?.cursor || 0;

    if (totalImported % 20 === 0 && totalImported > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`[historical] TikTok import complete: ${totalImported} videos`);
  return totalImported;
}

async function importTwitterHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const accessToken = decrypt(account.access_token_encrypted);
  const userId = account.platform_user_id;

  console.log(`[historical] Importing Twitter history for @${account.platform_username}...`);

  let paginationToken: string | undefined;
  let totalImported = 0;

  do {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,public_metrics",
    });
    if (paginationToken) params.set("pagination_token", paginationToken);

    const res = await fetchWithTimeout(
      `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
      { headers: { "Authorization": `Bearer ${accessToken}` } },
      30000
    );
    const data = await res.json();

    if (data.errors) {
      console.error("[historical] Twitter API error:", data.errors);
      break;
    }

    for (const tweet of data.data || []) {
      try {
        const { data: contentPost } = await db().from("content_posts").insert({
          group_id: null,
          brand_id: brandId,
          status: "published",
          published_at: tweet.created_at,
          source: "api",
          caption_overrides: {
            caption: tweet.text || "",
            permalink: `https://x.com/i/status/${tweet.id}`,
          },
        }).select().single();

        if (!contentPost) continue;

        const { data: publishJob } = await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: "tw_post",
          status: "completed",
          platform_post_id: tweet.id,
          completed_at: tweet.created_at,
        }).select("id").single();

        const pm = tweet.public_metrics || {};
        const twAnalytics = { views: pm.impression_count || 0, likes: pm.like_count || 0, comments: pm.reply_count || 0, shares: (pm.retweet_count || 0) + (pm.quote_count || 0), impressions: pm.impression_count || 0 };
        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          publish_job_id: publishJob?.id || null,
          ...twAnalytics,
          platform_specific: { permalink: `https://x.com/i/status/${tweet.id}` },
          fetched_at: new Date().toISOString(),
        });
        await appendAnalyticsHistory(contentPost.id, account.id, twAnalytics, publishJob?.id);

        totalImported++;
      } catch (e: any) {
        console.error(`[historical] Error importing tweet ${tweet.id}:`, e.message);
      }
    }

    paginationToken = data.meta?.next_token;

    if (totalImported % 100 === 0 && totalImported > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } while (paginationToken && true);

  console.log(`[historical] Twitter import complete: ${totalImported} tweets`);
  return totalImported;
}

// ─── Historical Import Worker ───

const historicalWorker = new Worker(
  "historical-import",
  async (job) => {
    const { accountId, brandId, orgId, platform } = job.data as {
      accountId: string;
      brandId: string;
      orgId: string;
      platform: string;
    };
    console.log(`[historical] Starting ${platform} import for brand ${brandId}...`);

    const { data: account } = await db().from("social_accounts")
      .select("*").eq("id", accountId).single();
    if (!account) throw new Error("Account not found");

    let imported = 0;

    if (platform === "instagram") {
      imported = await importInstagramHistory(account, brandId, orgId);
    } else if (platform === "youtube") {
      imported = await importYouTubeHistory(account, brandId, orgId);
    } else if (platform === "linkedin") {
      imported = await importLinkedInHistory(account, brandId, orgId);
    } else if (platform === "facebook") {
      imported = await importFacebookHistory(account, brandId, orgId);
    } else if (platform === "tiktok") {
      imported = await importTikTokHistory(account, brandId, orgId);
    } else if (platform === "twitter") {
      imported = await importTwitterHistory(account, brandId, orgId);
    } else if (platform === "snapchat") {
      // Snapchat Marketing API has limited historical data support
      console.log("[historical] Snapchat historical import not available (API limitation)");
      imported = 0;
    }

    console.log(`[historical] Import complete: ${imported} posts imported for ${platform}`);

    // Trigger analytics fetch for newly imported posts so the 6-hour cron picks up fresh data
    if (imported > 0) {
      try {
        const analyticsQueue = new Queue("analytics-fetch", { connection: redis });
        await analyticsQueue.add("post-import-fetch", { brandId });
        console.log(`[historical] Queued analytics fetch for brand ${brandId}`);
      } catch (e: any) {
        console.error("[historical] Failed to queue analytics fetch:", e.message);
      }
    }
  },
  { connection: redis, concurrency: 1 }
);

// ─── Token Refresh Worker ───

const tokenWorker = new Worker(
  "token-refresh",
  async () => {
    console.log("[token-refresh] Checking for expiring tokens...");
    const threshold = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    // ─── Refresh Drive tokens (Google OAuth2) ───
    const { data: driveConns } = await db().from("drive_connections")
      .select("id, brand_id, access_token_encrypted, refresh_token_encrypted, google_account_email")
      .eq("is_active", true)
      .lt("token_expires_at", threshold);

    console.log(`[token-refresh] ${(driveConns || []).length} drive tokens to refresh`);

    for (const conn of driveConns || []) {
      try {
        if (!conn.refresh_token_encrypted) {
          console.warn(`[token-refresh] Drive connection ${conn.id} (${conn.google_account_email}) has no refresh token — skipping`);
          continue;
        }

        // Get brand's org to find credentials
        const { data: brand } = await db().from("brands").select("org_id").eq("id", conn.brand_id).single();
        if (!brand) continue;

        const { data: creds } = await db().from("platform_credentials")
          .select("client_id_encrypted, client_secret_encrypted")
          .eq("org_id", brand.org_id)
          .in("platform", ["google_drive", "youtube"])
          .limit(1)
          .single();
        if (!creds) continue;

        const oauth2 = new google.auth.OAuth2(
          decrypt(creds.client_id_encrypted),
          decrypt(creds.client_secret_encrypted)
        );
        oauth2.setCredentials({ refresh_token: decrypt(conn.refresh_token_encrypted) });

        const { credentials } = await oauth2.refreshAccessToken();
        if (credentials.access_token) {
          await db().from("drive_connections").update({
            access_token_encrypted: encrypt(credentials.access_token),
            token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
          }).eq("id", conn.id);
          console.log(`[token-refresh] Refreshed drive token for ${conn.google_account_email}`);
        }
      } catch (e: any) {
        console.error(`[token-refresh] Failed to refresh drive token ${conn.id}:`, e.message);
      }
    }

    // ─── Refresh Social Account tokens ───
    const { data: socialAccounts } = await db().from("social_accounts")
      .select("id, brand_id, platform, platform_username, access_token_encrypted, refresh_token_encrypted, platform_metadata, brands(org_id)")
      .eq("is_active", true)
      .lt("token_expires_at", threshold);

    console.log(`[token-refresh] ${(socialAccounts || []).length} social tokens to refresh`);

    for (const acct of socialAccounts || []) {
      try {
        if (acct.platform === "youtube") {
          // YouTube uses Google OAuth2 refresh tokens
          if (!acct.refresh_token_encrypted) {
            console.warn(`[token-refresh] YouTube account ${acct.platform_username} has no refresh token — skipping`);
            continue;
          }

          // Find org via social_accounts -> brands -> org
          const { data: brandLink } = await db().from("social_accounts").select("brand_id").eq("id", acct.id).single();
          if (!brandLink?.brand_id) continue;
          const { data: brand } = await db().from("brands").select("org_id").eq("id", brandLink.brand_id).single();
          if (!brand) continue;

          const { data: creds } = await db().from("platform_credentials")
            .select("client_id_encrypted, client_secret_encrypted")
            .eq("org_id", brand.org_id)
            .eq("platform", "youtube")
            .single();
          if (!creds) continue;

          const oauth2 = new google.auth.OAuth2(
            decrypt(creds.client_id_encrypted),
            decrypt(creds.client_secret_encrypted)
          );
          oauth2.setCredentials({ refresh_token: decrypt(acct.refresh_token_encrypted) });

          const { credentials } = await oauth2.refreshAccessToken();
          if (credentials.access_token) {
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(credentials.access_token),
              token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed YouTube token for ${acct.platform_username}`);
          }

        } else if (acct.platform === "instagram") {
          // Instagram: exchange long-lived token for a new long-lived token
          const currentToken = decrypt(acct.access_token_encrypted);
          const res = await fetchWithTimeout(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`
          );
          const data = await res.json();

          if (data.access_token) {
            const expiresAt = data.expires_in
              ? new Date(Date.now() + data.expires_in * 1000).toISOString()
              : null;
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              token_expires_at: expiresAt,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed Instagram token for ${acct.platform_username}`);
          } else {
            console.warn(`[token-refresh] Instagram token refresh failed for ${acct.platform_username}: ${JSON.stringify(data)}`);
          }

        } else if (acct.platform === "linkedin") {
          // LinkedIn tokens have 60-day expiry and cannot be programmatically refreshed
          console.warn(`[token-refresh] LinkedIn token for ${acct.platform_username} is expiring — user must re-authenticate manually`);

        } else if (acct.platform === "facebook") {
          // Exchange short-lived token for long-lived using app credentials
          const orgId = (acct as any).brands?.org_id;
          const { data: fbCreds } = await db().from("platform_credentials")
            .select("client_id_encrypted, client_secret_encrypted").eq("org_id", orgId).eq("platform", "facebook").single();
          if (!fbCreds) { console.warn(`[token-refresh] No Facebook credentials for org — skipping ${acct.platform_username}`); continue; }
          const currentToken = decrypt(acct.access_token_encrypted);
          const appId = decrypt(fbCreds.client_id_encrypted);
          const appSecret = decrypt(fbCreds.client_secret_encrypted);
          const res = await fetchWithTimeout(
            `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`
          );
          const data = await res.json();
          if (data.access_token) {
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              token_expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed Facebook token for ${acct.platform_username}`);
          }

        } else if (acct.platform === "tiktok") {
          if (!acct.refresh_token_encrypted) {
            console.warn(`[token-refresh] TikTok account ${acct.platform_username} has no refresh token — skipping`);
            continue;
          }
          // Find org credentials
          const { data: brandLink } = await db().from("social_accounts").select("brand_id").eq("id", acct.id).single();
          if (!brandLink?.brand_id) continue;
          const { data: brand } = await db().from("brands").select("org_id").eq("id", brandLink.brand_id).single();
          if (!brand) continue;
          const { data: creds } = await db().from("platform_credentials")
            .select("client_id_encrypted, client_secret_encrypted")
            .eq("org_id", brand.org_id).eq("platform", "tiktok").single();
          if (!creds) continue;

          const res = await fetchWithTimeout("https://open.tiktokapis.com/v2/oauth/token/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_key: decrypt(creds.client_id_encrypted),
              client_secret: decrypt(creds.client_secret_encrypted),
              grant_type: "refresh_token",
              refresh_token: decrypt(acct.refresh_token_encrypted),
            }),
          });
          const data = await res.json();
          if (data.access_token) {
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : acct.refresh_token_encrypted,
              token_expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed TikTok token for ${acct.platform_username}`);
          }

        } else if (acct.platform === "twitter") {
          if (!acct.refresh_token_encrypted) {
            console.warn(`[token-refresh] Twitter account ${acct.platform_username} has no refresh token — skipping`);
            continue;
          }
          // Find org credentials
          const { data: brandLink } = await db().from("social_accounts").select("brand_id").eq("id", acct.id).single();
          if (!brandLink?.brand_id) continue;
          const { data: brand } = await db().from("brands").select("org_id").eq("id", brandLink.brand_id).single();
          if (!brand) continue;
          const { data: creds } = await db().from("platform_credentials")
            .select("client_id_encrypted, client_secret_encrypted")
            .eq("org_id", brand.org_id).eq("platform", "twitter").single();
          if (!creds) continue;

          const clientId = decrypt(creds.client_id_encrypted);
          const clientSecret = decrypt(creds.client_secret_encrypted);
          const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

          const res = await fetchWithTimeout("https://api.twitter.com/2/oauth2/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Authorization": `Basic ${basicAuth}`,
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: decrypt(acct.refresh_token_encrypted),
            }),
          });
          const data = await res.json();
          if (data.access_token) {
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : acct.refresh_token_encrypted,
              token_expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed Twitter token for ${acct.platform_username}`);
          }

        } else if (acct.platform === "snapchat") {
          if (!acct.refresh_token_encrypted) {
            console.warn(`[token-refresh] Snapchat account ${acct.platform_username} has no refresh token — skipping`);
            continue;
          }
          // Find org credentials
          const { data: brandLink } = await db().from("social_accounts").select("brand_id").eq("id", acct.id).single();
          if (!brandLink?.brand_id) continue;
          const { data: brand } = await db().from("brands").select("org_id").eq("id", brandLink.brand_id).single();
          if (!brand) continue;
          const { data: creds } = await db().from("platform_credentials")
            .select("client_id_encrypted, client_secret_encrypted")
            .eq("org_id", brand.org_id).eq("platform", "snapchat").single();
          if (!creds) continue;

          const res = await fetchWithTimeout("https://accounts.snapchat.com/login/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: decrypt(acct.refresh_token_encrypted),
              client_id: decrypt(creds.client_id_encrypted),
              client_secret: decrypt(creds.client_secret_encrypted),
            }),
          });
          const data = await res.json();
          if (data.access_token) {
            await db().from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : acct.refresh_token_encrypted,
              token_expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            }).eq("id", acct.id);
            console.log(`[token-refresh] Refreshed Snapchat token for ${acct.platform_username}`);
          }

        } else {
          console.warn(`[token-refresh] Unknown platform ${acct.platform} for account ${acct.id} — skipping`);
        }
      } catch (e: any) {
        console.error(`[token-refresh] Failed to refresh ${acct.platform} token for ${acct.platform_username}:`, e.message);
      }
    }

    // ─── Zombie Job Detection ───
    console.log("[token-refresh] Checking for zombie jobs...");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: zombieJobs } = await db()
      .from("publish_jobs")
      .select("id, post_id")
      .eq("status", "processing")
      .lt("updated_at", tenMinutesAgo);

    for (const zombie of (zombieJobs || [])) {
      console.warn(`[token-refresh] Marking zombie job ${zombie.id} as failed`);
      await db().from("publish_jobs").update({
        status: "failed",
        error_message: "Job timed out (stuck in processing for over 10 minutes)",
      }).eq("id", zombie.id);

      // Check if post needs status update
      if (zombie.post_id) {
        const { data: allJobs } = await db().from("publish_jobs").select("status").eq("post_id", zombie.post_id);
        const statuses = (allJobs || []).map((j: any) => j.status);
        const hasActiveJobs = statuses.some((s: string) => s === "processing" || s === "queued");
        const hasCompleted = statuses.some((s: string) => s === "completed");

        if (!hasActiveJobs) {
          if (hasCompleted) {
            await db().from("content_posts").update({ status: "partial_published" }).eq("id", zombie.post_id);
          } else {
            await db().from("content_posts").update({ status: "failed" }).eq("id", zombie.post_id);
          }
        }
      }
    }

    if ((zombieJobs || []).length > 0) {
      console.log(`[token-refresh] Cleaned up ${zombieJobs!.length} zombie jobs`);
    }
  },
  { connection: redis }
);

// ─── Content Categorization Worker ───

const categorizeWorker = new Worker(
  "content-categorize",
  async (job) => {
    const { groupId, brandId, orgId } = job.data;
    console.log(`[categorize] Analyzing content for group ${groupId}...`);

    try {
      // Get group details
      const { data: group, error: groupErr } = await db().from("media_groups")
        .select("id, title, caption, description, tags")
        .eq("id", groupId)
        .single();

      if (groupErr || !group) {
        console.error(`[categorize] Group not found: ${groupId}`);
        return;
      }

      // Resolve LLM config for the org (worker has no user context, use org-level)
      const { data: orgConfig } = await db().from("llm_configurations")
        .select("*")
        .eq("org_id", orgId)
        .eq("scope", "org")
        .eq("is_active", true)
        .limit(1)
        .single();

      // Also check platform_credentials fallback
      let apiKey = "";
      let baseUrl = "https://openrouter.ai/api/v1";
      let model = "deepseek/deepseek-chat-v3"; // Use cheapest model for categorization
      let headers: Record<string, string> = {};

      if (orgConfig?.api_key_encrypted) {
        apiKey = decrypt(orgConfig.api_key_encrypted);
        const provider = orgConfig.provider || "openrouter";
        if (provider === "openrouter") {
          baseUrl = "https://openrouter.ai/api/v1";
          headers = { "Authorization": `Bearer ${apiKey}` };
        } else if (provider === "openai") {
          baseUrl = "https://api.openai.com/v1";
          model = "gpt-4o-mini";
          headers = { "Authorization": `Bearer ${apiKey}` };
        } else {
          baseUrl = orgConfig.base_url || baseUrl;
          headers = { "Authorization": `Bearer ${apiKey}` };
        }
      } else {
        // Fallback to platform_credentials
        const { data: cred } = await db().from("platform_credentials")
          .select("client_id_encrypted, metadata")
          .eq("org_id", orgId)
          .eq("platform", "llm_provider")
          .limit(1)
          .single();

        if (cred?.client_id_encrypted) {
          apiKey = decrypt(cred.client_id_encrypted);
          headers = { "Authorization": `Bearer ${apiKey}` };
        } else if (process.env.OPENROUTER_API_KEY) {
          apiKey = process.env.OPENROUTER_API_KEY;
          headers = { "Authorization": `Bearer ${apiKey}` };
        }
      }

      if (!apiKey) {
        console.warn(`[categorize] No LLM config for org ${orgId} — skipping`);
        return;
      }

      const systemPrompt = `You are a content categorization AI for social media. Analyze the given content and return a JSON object with:
- primary_category (string: one of "educational", "entertainment", "promotional", "behind_the_scenes", "user_generated", "news", "inspirational", "tutorial", "product_showcase", "lifestyle", "other")
- secondary_category (string or null, same options)
- tone (string: one of "professional", "casual", "humorous", "inspirational", "educational", "urgent", "emotional")
- topics (array of strings, 3-5 relevant topic keywords)
- sentiment_score (float -1 to 1, negative to positive)
- predicted_engagement_score (float 0-100, estimated engagement potential)

Respond ONLY with valid JSON, no markdown.`;

      const userMessage = `Title: "${group.title}"
Caption: "${group.caption || "N/A"}"
Description: "${group.description || "N/A"}"
Tags: ${(group.tags || []).join(", ") || "none"}`;

      const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`LLM error: ${(err as any).error?.message || response.statusText}`);
      }

      const llmResult = await response.json() as any;
      const content = llmResult.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      } catch {
        console.error(`[categorize] Failed to parse LLM response for group ${groupId}`);
        return;
      }

      // Insert into content_categories
      const { error: saveErr } = await db().from("content_categories").insert({
        group_id: groupId,
        brand_id: brandId,
        primary_category: parsed.primary_category || "other",
        secondary_category: parsed.secondary_category || null,
        tone: parsed.tone || null,
        topics: parsed.topics || [],
        sentiment_score: parsed.sentiment_score ?? null,
        predicted_engagement_score: parsed.predicted_engagement_score ?? null,
        analyzed_at: new Date().toISOString(),
      });

      if (saveErr) {
        console.error(`[categorize] Failed to save categories:`, saveErr.message);
      } else {
        console.log(`[categorize] Categorized group ${groupId}: ${parsed.primary_category}`);
      }
    } catch (e: any) {
      console.error(`[categorize] Error for group ${groupId}:`, e.message);
      throw e;
    }
  },
  { connection: redis, concurrency: 2 }
);

// ─── Comment Sentiment Worker (LLM-powered) ───

async function resolveLlmForOrg(orgId: string): Promise<{ apiKey: string; baseUrl: string; model: string; headers: Record<string, string>; isOpenRouter: boolean; poolKeys: string[] } | null> {
  let apiKey = "";
  let baseUrl = "https://openrouter.ai/api/v1";
  let model = "deepseek/deepseek-chat-v3";
  let headers: Record<string, string> = {};
  let isOpenRouter = false;
  let poolKeys: string[] = [];

  const { data: orgConfig } = await db().from("llm_configurations")
    .select("*").eq("org_id", orgId).eq("scope", "org").eq("is_active", true).limit(1).single();

  if (orgConfig?.api_key_encrypted) {
    apiKey = decrypt(orgConfig.api_key_encrypted);
    headers = { "Authorization": `Bearer ${apiKey}` };
    if (orgConfig.base_url) baseUrl = orgConfig.base_url;
    if (orgConfig.default_model) model = orgConfig.default_model;
    isOpenRouter = (orgConfig.provider === "openrouter" || baseUrl.includes("openrouter"));
  } else {
    // Check OpenRouter credentials with pool keys
    const { data: orCred } = await db().from("platform_credentials")
      .select("client_id_encrypted, metadata").eq("org_id", orgId).eq("platform", "llm_openrouter").limit(1).single();

    if (orCred?.client_id_encrypted) {
      apiKey = decrypt(orCred.client_id_encrypted);
      headers = { "Authorization": `Bearer ${apiKey}` };
      isOpenRouter = true;
      if (orCred.metadata?.default_model) model = orCred.metadata.default_model;
      // Load pool keys
      const poolEncrypted = (orCred.metadata as any)?.pool_keys_encrypted;
      if (Array.isArray(poolEncrypted)) {
        for (const enc of poolEncrypted) {
          try { poolKeys.push(decrypt(enc)); } catch {}
        }
      }
    } else {
      const { data: cred } = await db().from("platform_credentials")
        .select("client_id_encrypted").eq("org_id", orgId).eq("platform", "llm_provider").limit(1).single();

      if (cred?.client_id_encrypted) {
        apiKey = decrypt(cred.client_id_encrypted);
        headers = { "Authorization": `Bearer ${apiKey}` };
      } else if (process.env.OPENROUTER_API_KEY) {
        apiKey = process.env.OPENROUTER_API_KEY;
        headers = { "Authorization": `Bearer ${apiKey}` };
        isOpenRouter = true;
      }
    }
  }

  if (!apiKey) return null;
  return { apiKey, baseUrl, model, headers, isOpenRouter, poolKeys };
}

/**
 * Make an LLM call with automatic OpenRouter key rotation on 402/429 errors.
 */
async function workerLlmCall(
  llm: { apiKey: string; baseUrl: string; model: string; headers: Record<string, string>; isOpenRouter: boolean; poolKeys: string[] },
  messages: { role: string; content: string }[],
  maxTokens = 2048
): Promise<any> {
  const body = JSON.stringify({ model: llm.model, max_tokens: maxTokens, messages });

  if (!llm.isOpenRouter || llm.poolKeys.length === 0) {
    // No rotation — single call
    const response = await fetchWithTimeout(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...llm.headers },
      body,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`LLM error: ${(err as any).error?.message || response.statusText}`);
    }
    return response.json();
  }

  // Rotation: try primary key then pool keys, with 2 full rotations
  const allKeys = [llm.apiKey, ...llm.poolKeys.filter(k => k !== llm.apiKey)];
  const MAX_ROTATIONS = 2;

  for (let rotation = 0; rotation < MAX_ROTATIONS; rotation++) {
    if (rotation > 0) {
      console.warn(`[llm-rotation] Worker retry rotation ${rotation + 1}/${MAX_ROTATIONS}...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    for (const key of allKeys) {
      const response = await fetchWithTimeout(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "",
          "X-Title": "MediaHub Worker",
        },
        body,
      });

      if (response.ok) return response.json();

      const status = response.status;
      if (status === 402 || status === 429) {
        console.warn(`[llm-rotation] Worker key ${key.slice(0, 10)}... got ${status} — trying next`);
        continue;
      }

      const err = await response.json().catch(() => ({}));
      throw new Error(`LLM error: ${(err as any).error?.message || response.statusText}`);
    }
  }

  throw new Error("All API tokens are exhausted. Please add more API keys or upgrade your plan.");
}

const sentimentWorker = new Worker(
  "comment-sentiment",
  async () => {
    console.log("[comment-sentiment] Running sentiment analysis...");

    const { data: brands } = await db().from("brands").select("id, org_id, name");

    for (const brand of brands || []) {
      try {
        const llm = await resolveLlmForOrg(brand.org_id);
        if (!llm) {
          console.warn(`[comment-sentiment] No LLM config for org ${brand.org_id} — skipping brand ${brand.name}`);
          continue;
        }

        // Get published posts for this brand
        const { data: posts } = await db().from("content_posts")
          .select("id, group_id")
          .eq("brand_id", brand.id)
          .eq("status", "published");

        if (!posts || posts.length === 0) continue;

        // Check which posts need analysis (no sentiment record or older than 24h)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: existing } = await db().from("comment_sentiments")
          .select("post_id, analyzed_at")
          .eq("brand_id", brand.id)
          .in("post_id", posts.map((p: any) => p.id));

        // Build map of last analysis time per post
        const lastAnalyzedMap: Record<string, string> = {};
        for (const e of existing || []) {
          if (e.analyzed_at) lastAnalyzedMap[e.post_id] = e.analyzed_at;
        }

        // Filter: skip posts analyzed in last 24h with no new comments since
        const postsToAnalyze: any[] = [];
        for (const post of posts) {
          const lastAnalyzed = lastAnalyzedMap[post.id];
          if (lastAnalyzed && lastAnalyzed > oneDayAgo) {
            // Already analyzed recently — check if new comments exist
            const { count } = await db().from("platform_comments")
              .select("id", { count: "exact", head: true })
              .eq("post_id", post.id)
              .eq("brand_id", brand.id)
              .gt("created_at", lastAnalyzed);
            if (!count || count === 0) continue; // No new comments, skip
          }
          postsToAnalyze.push(post);
        }

        if (postsToAnalyze.length === 0) {
          console.log(`[comment-sentiment] ${brand.name}: no posts need re-analysis`);
          continue;
        }

        let analyzed = 0;
        for (const post of postsToAnalyze) {
          // Get comments for this post
          const { data: comments } = await db().from("platform_comments")
            .select("comment_text, like_count, author_username")
            .eq("post_id", post.id)
            .eq("brand_id", brand.id)
            .is("platform_parent_comment_id", null)
            .limit(50);

          if (!comments || comments.length === 0) continue;

          // Get post title for context
          let postTitle = "Untitled";
          if (post.group_id) {
            const { data: group } = await db().from("media_groups")
              .select("title, caption").eq("id", post.group_id).single();
            if (group) postTitle = group.title || group.caption?.slice(0, 60) || "Untitled";
          }

          const commentTexts = comments.map((c: any) =>
            `@${c.author_username}: "${c.comment_text}" (${c.like_count || 0} likes)`
          ).join("\n");

          const systemPrompt = `You are a social media sentiment analysis AI. Analyze the following comments on a social media post and return a JSON object with:
- overall_sentiment: "positive"|"negative"|"neutral"|"mixed"
- sentiment_score: float from -1 (very negative) to 1 (very positive)
- positive_count: number of positive comments
- negative_count: number of negative comments
- neutral_count: number of neutral comments
- top_positive_themes: array of up to 5 recurring positive theme strings
- top_negative_themes: array of up to 5 recurring negative theme strings
- purchase_intent_signals: count of comments showing purchase intent (e.g. "where to buy", "price", "want this")
- questions_count: count of comments that are questions needing response
- summary: 1-2 sentence summary of the overall sentiment

Respond ONLY with valid JSON, no markdown.`;

          const userMessage = `Post: "${postTitle}"\nTotal comments: ${comments.length}\n\nComments:\n${commentTexts}`;

          try {
            const llmResult = await workerLlmCall(llm, [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ], 1024);
            const content = llmResult.choices?.[0]?.message?.content || "{}";
            let parsed: any;
            try {
              parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
            } catch {
              console.error(`[comment-sentiment] Failed to parse LLM response for post ${post.id}`);
              continue;
            }

            await db().from("comment_sentiments").upsert({
              post_id: post.id,
              brand_id: brand.id,
              overall_sentiment: parsed.overall_sentiment || "neutral",
              sentiment_score: parsed.sentiment_score || 0,
              positive_count: parsed.positive_count || 0,
              negative_count: parsed.negative_count || 0,
              neutral_count: parsed.neutral_count || 0,
              top_positive_themes: parsed.top_positive_themes || [],
              top_negative_themes: parsed.top_negative_themes || [],
              purchase_intent_signals: parsed.purchase_intent_signals || 0,
              questions_count: parsed.questions_count || 0,
              summary: parsed.summary || null,
              analyzed_at: new Date().toISOString(),
            }, { onConflict: "post_id" });

            analyzed++;
          } catch (e: any) {
            console.error(`[comment-sentiment] Error analyzing post ${post.id}:`, e.message);
          }

          // Small delay between LLM calls
          await new Promise(r => setTimeout(r, 500));
        }

        if (analyzed > 0) console.log(`[comment-sentiment] ${brand.name}: analyzed ${analyzed} posts`);
      } catch (e: any) {
        console.error(`[comment-sentiment] Error for brand ${brand.name}:`, e.message);
      }
    }

    console.log("[comment-sentiment] Sentiment analysis complete");
  },
  { connection: redis }
);

// ─── Competitor Fetch Worker ───

const competitorFetchWorker = new Worker(
  "competitor-fetch",
  async () => {
    console.log("[competitor-fetch] Fetching competitor data...");

    const { data: allCompetitors } = await db().from("competitor_metrics").select("*");
    if (!allCompetitors || allCompetitors.length === 0) {
      console.log("[competitor-fetch] No competitors tracked");
      return;
    }

    // Group by brand to resolve API credentials once per brand
    const byBrand: Record<string, any[]> = {};
    for (const comp of allCompetitors) {
      if (!byBrand[comp.brand_id]) byBrand[comp.brand_id] = [];
      byBrand[comp.brand_id].push(comp);
    }

    for (const [brandId, competitors] of Object.entries(byBrand)) {
      const { data: brand } = await db().from("brands").select("org_id, name").eq("id", brandId).single();
      if (!brand) continue;

      for (const comp of competitors) {
        try {
          let followers: number | null = null;
          let postsCount: number | null = null;
          let avgEngagement: number | null = null;
          let avgViews: number | null = null;

          if (comp.platform === "youtube") {
            // YouTube: use Data API v3 (public, needs API key only)
            const { data: creds } = await db().from("platform_credentials")
              .select("*").eq("org_id", brand.org_id).eq("platform", "youtube").single();

            if (creds) {
              // Use OAuth2 client for YouTube Data API (public endpoints)
              const oauth2 = new google.auth.OAuth2(
                decrypt(creds.client_id_encrypted),
                decrypt(creds.client_secret_encrypted)
              );
              const youtube = google.youtube({ version: "v3", auth: oauth2 });

              // Search for the channel by handle
              const searchRes = await youtube.search.list({
                part: ["snippet"],
                type: ["channel"],
                q: comp.competitor_handle,
                maxResults: 1,
              });
              const channelId = searchRes.data.items?.[0]?.snippet?.channelId || (searchRes.data.items?.[0]?.id as any)?.channelId;

              if (channelId) {
                // Get channel statistics
                const channelRes = await youtube.channels.list({
                  part: ["statistics"],
                  id: [channelId],
                });
                const stats = channelRes.data.items?.[0]?.statistics;

                if (stats) {
                  followers = parseInt(stats.subscriberCount || "0");
                  postsCount = parseInt(stats.videoCount || "0");
                }

                // Get recent videos for avg engagement
                const videosRes = await youtube.search.list({
                  part: ["id"],
                  channelId,
                  type: ["video"],
                  order: "date",
                  maxResults: 5,
                });
                const videoIds = (videosRes.data.items || []).map((v: any) => v.id?.videoId).filter(Boolean);

                if (videoIds.length > 0) {
                  const videoStatsRes = await youtube.videos.list({
                    part: ["statistics"],
                    id: videoIds,
                  });

                  let totalViews = 0, totalEngagement = 0;
                  for (const v of videoStatsRes.data.items || []) {
                    const vs = v.statistics!;
                    const views = parseInt(vs.viewCount || "0");
                    const likes = parseInt(vs.likeCount || "0");
                    const cmts = parseInt(vs.commentCount || "0");
                    totalViews += views;
                    if (views > 0) totalEngagement += (likes + cmts) / views;
                  }
                  const count = videoStatsRes.data.items?.length || 1;
                  avgViews = Math.round(totalViews / count);
                  avgEngagement = Math.round(totalEngagement / count * 10000) / 100;
                }
              }
            }
          } else if (comp.platform === "instagram") {
            // Instagram: use Business Discovery API (needs brand's own IG account)
            const { data: igAccount } = await db().from("social_accounts")
              .select("*").eq("brand_id", brandId).eq("platform", "instagram").eq("is_active", true).limit(1).single();

            if (igAccount) {
              const igEncPageToken = igAccount.platform_metadata?.page_access_token_encrypted;
              const pageToken = igEncPageToken
                ? decrypt(igEncPageToken)
                : decrypt(igAccount.access_token_encrypted);
              const igUserId = igAccount.platform_user_id;
              const igApiUrl = igEncPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";

              if (pageToken && igUserId) {
                const discoveryRes = await fetchWithTimeout(
                  `${igApiUrl}/${igUserId}?fields=business_discovery.fields(followers_count,media_count,media.limit(5){like_count,comments_count,timestamp}){followers_count,media_count,media}&username=${encodeURIComponent(comp.competitor_handle)}&access_token=${pageToken}`
                );
                const discoveryData = await discoveryRes.json();
                const bd = discoveryData.business_discovery;

                if (bd) {
                  followers = bd.followers_count || null;
                  postsCount = bd.media_count || null;

                  // Avg engagement from recent media
                  const recentMedia = bd.media?.data || [];
                  if (recentMedia.length > 0 && followers && followers > 0) {
                    let totalEng = 0;
                    let totalMediaViews = 0;
                    for (const m of recentMedia) {
                      const eng = (m.like_count || 0) + (m.comments_count || 0);
                      totalEng += eng;
                      totalMediaViews += eng; // For images, engagement acts as proxy
                    }
                    avgEngagement = Math.round(totalEng / recentMedia.length / followers * 10000) / 100;
                    avgViews = Math.round(totalMediaViews / recentMedia.length);
                  }
                } else if (discoveryData.error) {
                  console.warn(`[competitor-fetch] IG discovery failed for @${comp.competitor_handle}: ${discoveryData.error.message}`);
                }
              }
            }
          } else if (comp.platform === "linkedin") {
            // LinkedIn does not provide public competitor data via API
            console.log(`[competitor-fetch] LinkedIn competitor data not available via API — @${comp.competitor_handle} requires manual entry`);
            continue;
          } else if (comp.platform === "tiktok") {
            // TikTok Research API is limited; skip for now
            console.log(`[competitor-fetch] TikTok competitor API limited — @${comp.competitor_handle} requires manual entry`);
            continue;
          }

          // Update if we got any data
          if (followers !== null || postsCount !== null || avgEngagement !== null) {
            const updates: Record<string, any> = { fetched_at: new Date().toISOString() };
            if (followers !== null) updates.followers = followers;
            if (postsCount !== null) updates.posts_count = postsCount;
            if (avgEngagement !== null) updates.avg_engagement_rate = avgEngagement;
            if (avgViews !== null) updates.avg_views_recent = avgViews;

            await db().from("competitor_metrics")
              .update(updates)
              .eq("id", comp.id);

            console.log(`[competitor-fetch] Updated @${comp.competitor_handle} (${comp.platform}): ${followers} followers, ${postsCount} posts, ${avgEngagement}% engagement`);
          }

          await new Promise(r => setTimeout(r, 500));
        } catch (e: any) {
          console.error(`[competitor-fetch] Error for @${comp.competitor_handle} (${comp.platform}):`, e.message);
        }
      }
    }

    console.log("[competitor-fetch] Competitor fetch complete");
  },
  { connection: redis }
);

// ─── Trend Forecast Worker ───

const trendForecastWorker = new Worker(
  "trend-forecast",
  async () => {
    console.log("[trend-forecast] Running weekly trend forecast...");

    // Get all brands
    const { data: brands } = await db().from("brands").select("id, org_id, name");

    for (const brand of brands || []) {
      try {
        // Get last 90 days of content categories
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { data: categories } = await db().from("content_categories")
          .select("primary_category, secondary_category, tone, topics, predicted_engagement_score, actual_engagement_rate")
          .eq("brand_id", brand.id)
          .gte("created_at", ninetyDaysAgo);

        // Get post analytics
        const { data: posts } = await db().from("content_posts")
          .select("id, status, published_at, group_id")
          .eq("brand_id", brand.id)
          .eq("status", "published")
          .gte("published_at", ninetyDaysAgo);

        const postIds = (posts || []).map((p: any) => p.id);
        let analytics: any[] = [];
        if (postIds.length > 0) {
          const { data: analyticsData } = await db().from("post_analytics")
            .select("post_id, views, likes, comments, shares, engagement_rate")
            .in("post_id", postIds);
          analytics = analyticsData || [];
        }

        // Resolve LLM config (with key pool support)
        const llm = await resolveLlmForOrg(brand.org_id);
        if (!llm) {
          console.warn(`[trend-forecast] No LLM config for org ${brand.org_id} — skipping brand ${brand.name}`);
          continue;
        }

        // Aggregate category counts
        const catCounts: Record<string, number> = {};
        const topicCounts: Record<string, number> = {};
        for (const cat of categories || []) {
          catCounts[cat.primary_category] = (catCounts[cat.primary_category] || 0) + 1;
          for (const topic of cat.topics || []) {
            topicCounts[topic] = (topicCounts[topic] || 0) + 1;
          }
        }

        // Analyze posting time performance
        const analyticsMap: Record<string, any> = {};
        for (const a of analytics) analyticsMap[a.post_id] = a;

        const timeSlots: Record<string, { totalEngagement: number; count: number }> = {};
        for (const post of posts || []) {
          if (!post.published_at) continue;
          const dt = new Date(post.published_at);
          const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dt.getUTCDay()];
          const hour = dt.getUTCHours();
          const key = `${day} ${hour}:00`;
          const pa = analyticsMap[post.id];
          if (!timeSlots[key]) timeSlots[key] = { totalEngagement: 0, count: 0 };
          timeSlots[key].count++;
          if (pa && pa.views > 0) {
            timeSlots[key].totalEngagement += ((pa.likes || 0) + (pa.comments || 0) + (pa.shares || 0)) / pa.views;
          }
        }

        const timePerformance = Object.entries(timeSlots)
          .map(([slot, data]) => ({
            slot,
            posts: data.count,
            avgEngagement: data.count > 0 ? Math.round(data.totalEngagement / data.count * 10000) / 100 : 0,
          }))
          .sort((a, b) => b.avgEngagement - a.avgEngagement)
          .slice(0, 15);

        const systemPrompt = `You are a social media trend forecasting AI. Analyze the brand's content history, performance data, and posting time performance to generate a trend forecast. Return a JSON object with:
- trending_categories (array of objects: { category: string, score: number 0-100, trend: "rising"|"stable"|"declining" })
- trending_topics (array of objects: { topic: string, score: number 0-100 })
- trending_formats (array of objects: { format: string, recommendation: string })
- content_recommendations (array of strings, 5-7 actionable content ideas)
- content_gaps (array of strings, 3-5 content opportunities the brand is missing)
- weekly_plan (array of objects: { day: string, content_type: string, topic: string, platform: string, best_time: string })
- best_posting_times (array of objects: { day: string, times: string[] (24h format like "09:00"), platform: string, reason: string, expected_engagement_boost: number 0-100 })

For best_posting_times, analyze when this brand's posts historically perform best and recommend optimal posting windows for each day of the week. If there's insufficient data, use industry best practices for the brand's niche.

Respond ONLY with valid JSON, no markdown.`;

        const userMessage = `Brand: "${brand.name}"
Content categories (last 90 days): ${JSON.stringify(catCounts)}
Top topics: ${JSON.stringify(Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 20))}
Total posts: ${(posts || []).length}
Average views: ${analytics.length > 0 ? Math.round(analytics.reduce((s, a) => s + (a.views || 0), 0) / analytics.length) : 0}
Average engagement: ${analytics.length > 0 ? Math.round(analytics.reduce((s, a) => s + (a.engagement_rate || 0), 0) / analytics.length * 100) / 100 : 0}%
Publishing time performance (slot -> avg engagement%): ${JSON.stringify(timePerformance)}`;

        let llmResult: any;
        try {
          llmResult = await workerLlmCall(llm, [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ], 2048);
        } catch (llmErr: any) {
          console.error(`[trend-forecast] LLM error for brand ${brand.name}:`, llmErr.message);
          continue;
        }
        const content = llmResult.choices?.[0]?.message?.content || "{}";
        let parsed: any;
        try {
          parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
        } catch {
          console.error(`[trend-forecast] Failed to parse LLM response for brand ${brand.name}`);
          continue;
        }

        // Determine platforms from publish history
        const platforms = ["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"];
        const today = new Date().toISOString().slice(0, 10);

        for (const platform of platforms) {
          await db().from("trend_snapshots").upsert({
            brand_id: brand.id,
            platform,
            snapshot_date: today,
            trending_categories: parsed.trending_categories || [],
            trending_topics: parsed.trending_topics || [],
            trending_formats: parsed.trending_formats || [],
            content_recommendations: parsed.content_recommendations || [],
            content_gaps: parsed.content_gaps || [],
            weekly_plan: (parsed.weekly_plan || []).filter((p: any) => !p.platform || p.platform === platform),
            best_posting_times: (parsed.best_posting_times || []).filter((p: any) => !p.platform || p.platform === platform),
            generated_by: "ai",
          }, { onConflict: "brand_id,platform,snapshot_date" });
        }

        console.log(`[trend-forecast] Generated forecast for brand ${brand.name}`);
      } catch (e: any) {
        console.error(`[trend-forecast] Error for brand ${brand.name}:`, e.message);
      }
    }

    console.log("[trend-forecast] Weekly forecast complete");
  },
  { connection: redis }
);

// ─── Prediction Accuracy Update (runs after analytics fetch) ───

async function updatePredictionAccuracy() {
  console.log("[prediction-accuracy] Updating prediction accuracy...");

  // Get predictions that don't have actual data yet
  const { data: predictions } = await db().from("performance_predictions")
    .select("id, group_id, brand_id, predicted_views_min, predicted_views_max, predicted_engagement_rate")
    .is("actual_views", null);

  let updated = 0;
  for (const pred of predictions || []) {
    // Find the content_post for this group
    const { data: post } = await db().from("content_posts")
      .select("id")
      .eq("group_id", pred.group_id)
      .eq("status", "published")
      .limit(1)
      .single();

    if (!post) continue;

    // Get the latest analytics for this post
    const { data: analytics } = await db().from("post_analytics")
      .select("views, engagement_rate")
      .eq("post_id", post.id)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .single();

    if (!analytics) continue;

    // Calculate prediction accuracy
    const actualViews = analytics.views || 0;
    const predictedMid = ((pred.predicted_views_min || 0) + (pred.predicted_views_max || 0)) / 2;
    let viewsAccuracy: number | null = null;
    if (predictedMid > 0) {
      viewsAccuracy = Math.max(0, 1 - Math.abs(actualViews - predictedMid) / predictedMid);
    }

    await db().from("performance_predictions")
      .update({
        actual_views: actualViews,
        actual_engagement_rate: analytics.engagement_rate || 0,
      })
      .eq("id", pred.id);

    // Also update content_categories with actual engagement rate
    const { data: catRow } = await db().from("content_categories")
      .select("id, predicted_engagement_score")
      .eq("group_id", pred.group_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (catRow) {
      const predScore = catRow.predicted_engagement_score || 0;
      const actualRate = analytics.engagement_rate || 0;
      const catAccuracy = predScore > 0 ? Math.max(0, 1 - Math.abs(actualRate - predScore) / predScore) : null;

      await db().from("content_categories")
        .update({
          actual_engagement_rate: actualRate,
          prediction_accuracy: catAccuracy,
        })
        .eq("id", catRow.id);
    }

    updated++;
  }

  console.log(`[prediction-accuracy] Updated ${updated} predictions`);
}

// ─── Comment Sync Helpers ───

function detectSentiment(text: string): string {
  const lower = text.toLowerCase();

  // Question detection
  if (/\?/.test(text) || /^(how|what|when|where|why|who|which|can|could|would|is|are|do|does|will)\b/i.test(text.trim())) {
    return "question";
  }

  const positiveWords = /\b(love|great|amazing|awesome|excellent|fantastic|beautiful|perfect|best|wonderful|thank|thanks|congrats|congratulations|fire|lit|goat|incredible|insane|stunning|brilliant|good|nice|cool|wow|bravo|superb|gorgeous|❤️|🔥|👏|💯|😍|🥰|👍|💪|🎉)\b/i;
  const negativeWords = /\b(hate|terrible|awful|worst|bad|ugly|disgusting|horrible|trash|garbage|sucks|pathetic|disappointed|disappointing|scam|fake|fraud|boring|annoying|stupid|dumb|ridiculous|👎|😡|🤮|💩|😠)\b/i;

  const posMatch = lower.match(positiveWords);
  const negMatch = lower.match(negativeWords);

  if (posMatch && !negMatch) return "positive";
  if (negMatch && !posMatch) return "negative";
  if (posMatch && negMatch) return "neutral";

  return "neutral";
}

async function syncInstagramComments(account: any, brandId: string) {
  const igEncPageToken = account.platform_metadata?.page_access_token_encrypted;
  const pageToken = igEncPageToken
    ? decrypt(igEncPageToken)
    : decrypt(account.access_token_encrypted);
  if (!pageToken) return 0;
  const igApiBase = igEncPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";

  const igUserId = account.platform_user_id;
  let synced = 0;

  // Get recent media to fetch comments from
  const mediaRes = await fetchWithTimeout(
    `${igApiBase}/${igUserId}/media?fields=id,caption,timestamp&limit=25&access_token=${pageToken}`
  );
  const mediaData = await mediaRes.json();
  if (mediaData.error) {
    console.error(`[comment-sync] IG media list error: ${mediaData.error.message}`);
    return 0;
  }

  for (const media of mediaData.data || []) {
    try {
      // Fetch top-level comments for this media
      const commentsRes = await fetchWithTimeout(
        `${igApiBase}/${media.id}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${pageToken}`
      );
      const commentsData = await commentsRes.json();
      if (commentsData.error) continue;

      // Find the content_post linked to this platform_post_id
      const { data: publishJob } = await db().from("publish_jobs")
        .select("id, post_id")
        .eq("platform_post_id", media.id)
        .eq("social_account_id", account.id)
        .limit(1)
        .maybeSingle();

      for (const comment of commentsData.data || []) {
        // Fetch replies for this comment separately (more reliable than nested expansion)
        let replyCount = 0;
        let repliesData: any[] = [];
        try {
          const repliesRes = await fetchWithTimeout(
            `${igApiBase}/${comment.id}/replies?fields=id,text,username,timestamp,like_count&limit=50&access_token=${pageToken}`
          );
          const repliesJson = await repliesRes.json();
          if (!repliesJson.error) {
            repliesData = repliesJson.data || [];
            replyCount = repliesData.length;
          }
        } catch {
          // Replies fetch failed — continue with top-level comment only
        }

        // Upsert top-level comment
        const authorUsername = comment.username || "unknown";
        const { error: upsertErr } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: publishJob?.post_id || null,
            publish_job_id: publishJob?.id || null,
            social_account_id: account.id,
            platform: "instagram",
            platform_comment_id: comment.id,
            platform_post_id: media.id,
            author_username: authorUsername,
            author_profile_url: authorUsername !== "unknown" ? `https://www.instagram.com/${authorUsername}/` : null,
            author_avatar_url: null,
            comment_text: comment.text || "",
            comment_timestamp: comment.timestamp || new Date().toISOString(),
            like_count: comment.like_count || 0,
            reply_count: replyCount,
            sentiment: detectSentiment(comment.text || ""),
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!upsertErr) synced++;

        // Upsert replies
        for (const reply of repliesData) {
          const replyUsername = reply.username || "unknown";
          const { error: replyErr } = await db().from("platform_comments")
            .upsert({
              brand_id: brandId,
              post_id: publishJob?.post_id || null,
              publish_job_id: publishJob?.id || null,
              social_account_id: account.id,
              platform: "instagram",
              platform_comment_id: reply.id,
              platform_post_id: media.id,
              platform_parent_comment_id: comment.id,
              author_username: replyUsername,
              author_profile_url: replyUsername !== "unknown" ? `https://www.instagram.com/${replyUsername}/` : null,
              comment_text: reply.text || "",
              comment_timestamp: reply.timestamp || new Date().toISOString(),
              like_count: reply.like_count || 0,
              sentiment: detectSentiment(reply.text || ""),
              synced_at: new Date().toISOString(),
            }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

          if (!replyErr) synced++;
        }
      }

      // Rate limit
      if (synced % 20 === 0 && synced > 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[comment-sync] IG comment fetch error for media ${media.id}:`, e.message);
    }
  }

  return synced;
}

async function syncYouTubeComments(account: any, brandId: string, orgId: string) {
  const { data: creds } = await db().from("platform_credentials")
    .select("*").eq("org_id", orgId).eq("platform", "youtube").single();
  if (!creds) return 0;

  const oauth2 = new google.auth.OAuth2(
    decrypt(creds.client_id_encrypted),
    decrypt(creds.client_secret_encrypted)
  );
  oauth2.setCredentials({
    access_token: decrypt(account.access_token_encrypted),
    refresh_token: account.refresh_token_encrypted ? decrypt(account.refresh_token_encrypted) : null,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });
  let synced = 0;

  // Get recent videos
  const searchRes = await youtube.search.list({
    channelId: account.platform_user_id,
    type: ["video"],
    part: ["snippet"],
    maxResults: 25,
    order: "date",
  });

  for (const item of searchRes.data.items || []) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;

    try {
      // Find linked content_post once per video
      const { data: publishJob } = await db().from("publish_jobs")
        .select("id, post_id")
        .eq("platform_post_id", videoId)
        .eq("social_account_id", account.id)
        .limit(1)
        .maybeSingle();

      let pageToken: string | undefined;
      do {
        const commentsRes = await youtube.commentThreads.list({
          videoId,
          part: ["snippet", "replies"],
          maxResults: 100,
          pageToken,
          order: "time",
        });

        for (const thread of commentsRes.data.items || []) {
          const topComment = thread.snippet?.topLevelComment?.snippet;
          if (!topComment) continue;

          const commentId = thread.snippet?.topLevelComment?.id || thread.id || "";

          const { error } = await db().from("platform_comments")
            .upsert({
              brand_id: brandId,
              post_id: publishJob?.post_id || null,
              publish_job_id: publishJob?.id || null,
              social_account_id: account.id,
              platform: "youtube",
              platform_comment_id: commentId,
              platform_post_id: videoId,
              author_username: topComment.authorDisplayName || "unknown",
              author_profile_url: topComment.authorChannelUrl || null,
              author_avatar_url: topComment.authorProfileImageUrl || null,
              comment_text: topComment.textDisplay || topComment.textOriginal || "",
              comment_timestamp: topComment.publishedAt || new Date().toISOString(),
              like_count: topComment.likeCount || 0,
              reply_count: thread.snippet?.totalReplyCount || 0,
              sentiment: detectSentiment(topComment.textDisplay || topComment.textOriginal || ""),
              synced_at: new Date().toISOString(),
            }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

          if (!error) synced++;

          // Sync replies
          for (const reply of thread.replies?.comments || []) {
            const replySnippet = reply.snippet;
            if (!replySnippet) continue;

            const { error: replyErr } = await db().from("platform_comments")
              .upsert({
                brand_id: brandId,
                post_id: publishJob?.post_id || null,
                publish_job_id: publishJob?.id || null,
                social_account_id: account.id,
                platform: "youtube",
                platform_comment_id: reply.id || "",
                platform_post_id: videoId,
                platform_parent_comment_id: commentId,
                author_username: replySnippet.authorDisplayName || "unknown",
                author_profile_url: replySnippet.authorChannelUrl || null,
                author_avatar_url: replySnippet.authorProfileImageUrl || null,
                comment_text: replySnippet.textDisplay || replySnippet.textOriginal || "",
                comment_timestamp: replySnippet.publishedAt || new Date().toISOString(),
                like_count: replySnippet.likeCount || 0,
                sentiment: detectSentiment(replySnippet.textDisplay || replySnippet.textOriginal || ""),
                synced_at: new Date().toISOString(),
              }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

            if (!replyErr) synced++;
          }
        }

        pageToken = commentsRes.data.nextPageToken || undefined;
      } while (pageToken && synced < 100000);
    } catch (e: any) {
      console.error(`[comment-sync] YT comment fetch error for video ${videoId}:`, e.message);
    }
  }

  return synced;
}

async function syncLinkedInComments(account: any, brandId: string) {
  const accessToken = decrypt(account.access_token_encrypted);
  const personUrn = account.platform_metadata?.person_urn;
  if (!personUrn) return 0;

  let synced = 0;

  // Get recent published posts for this account
  const { data: publishJobs } = await db().from("publish_jobs")
    .select("id, post_id, platform_post_id")
    .eq("social_account_id", account.id)
    .eq("status", "completed")
    .not("platform_post_id", "is", null)
    .order("completed_at", { ascending: false })
    .limit(25);

  for (const pj of publishJobs || []) {
    if (!pj.platform_post_id) continue;

    try {
      const commentsRes = await fetchWithTimeout(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(pj.platform_post_id)}/comments?count=50`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "LinkedIn-Version": "202401",
          },
        }
      );

      if (!commentsRes.ok) continue;
      const commentsData = await commentsRes.json();

      for (const comment of commentsData.elements || []) {
        const commentId = comment["$URN"] || comment.id || `li_${Date.now()}_${synced}`;
        const actorUrn = comment.actor || comment.created?.actor || "";
        const actorId = actorUrn.split(":").pop() || "";
        const authorName = comment.authorName || comment.created?.actorDisplayName || actorId || "LinkedIn User";
        const authorProfileUrl = actorId ? `https://www.linkedin.com/in/${actorId}` : null;
        const authorAvatarUrl = comment.actor$?.image?.["com.linkedin.common.VectorImage"]?.rootUrl || null;

        const { error } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: pj.post_id,
            publish_job_id: pj.id,
            social_account_id: account.id,
            platform: "linkedin",
            platform_comment_id: commentId,
            platform_post_id: pj.platform_post_id,
            author_username: authorName,
            author_profile_url: authorProfileUrl,
            author_avatar_url: authorAvatarUrl,
            comment_text: comment.message?.text || comment.comment || "",
            comment_timestamp: comment.created?.time
              ? new Date(comment.created.time).toISOString()
              : new Date().toISOString(),
            like_count: comment.likeCount || 0,
            sentiment: detectSentiment(comment.message?.text || comment.comment || ""),
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!error) synced++;
      }
    } catch (e: any) {
      console.error(`[comment-sync] LI comment fetch error for post ${pj.platform_post_id}:`, e.message);
    }
  }

  return synced;
}

async function syncFacebookComments(account: any, brandId: string) {
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) return 0;

  const pageId = account.platform_user_id;
  let synced = 0;

  // Get recent published posts
  const postsRes = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${pageId}/published_posts?fields=id,message,created_time&limit=25&access_token=${pageToken}`
  );
  const postsData = await postsRes.json();
  if (postsData.error) {
    console.error(`[comment-sync] FB posts list error: ${postsData.error.message}`);
    return 0;
  }

  for (const post of postsData.data || []) {
    try {
      const commentsRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${post.id}/comments?fields=id,message,from,created_time,like_count&limit=50&access_token=${pageToken}`
      );
      const commentsData = await commentsRes.json();
      if (commentsData.error) continue;

      // Find the content_post linked to this platform_post_id
      const { data: publishJob } = await db().from("publish_jobs")
        .select("id, post_id")
        .eq("platform_post_id", post.id)
        .eq("social_account_id", account.id)
        .limit(1)
        .maybeSingle();

      for (const comment of commentsData.data || []) {
        const { error: upsertErr } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: publishJob?.post_id || null,
            publish_job_id: publishJob?.id || null,
            social_account_id: account.id,
            platform: "facebook",
            platform_comment_id: comment.id,
            platform_post_id: post.id,
            author_username: comment.from?.name || "Facebook User",
            author_profile_url: comment.from?.id ? `https://facebook.com/${comment.from.id}` : null,
            author_avatar_url: comment.from?.id ? `https://graph.facebook.com/${comment.from.id}/picture?type=small` : null,
            comment_text: comment.message || "",
            comment_timestamp: comment.created_time || new Date().toISOString(),
            like_count: comment.like_count || 0,
            sentiment: detectSentiment(comment.message || ""),
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!upsertErr) synced++;
      }

      // Rate limit
      if (synced % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[comment-sync] FB comment fetch error for post ${post.id}:`, e.message);
    }
  }

  return synced;
}

async function syncTikTokComments(account: any, brandId: string) {
  const accessToken = decrypt(account.access_token_encrypted);
  let synced = 0;

  // Get recent videos
  const videosRes = await fetchWithTimeout(
    `https://open.tiktokapis.com/v2/video/list/`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_count: 20,
      }),
    }
  );
  const videosData = await videosRes.json();
  if (videosData.error?.code) {
    console.error(`[comment-sync] TikTok video list error: ${videosData.error.message}`);
    return 0;
  }

  for (const video of videosData.data?.videos || []) {
    const videoId = video.id;
    if (!videoId) continue;

    try {
      let cursor = 0;
      let hasMore = true;

      while (hasMore && synced < 100000) {
        const commentsRes = await fetchWithTimeout(
          `https://open.tiktokapis.com/v2/comment/list/`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              video_id: videoId,
              max_count: 50,
              cursor,
            }),
          }
        );
        const commentsData = await commentsRes.json();
        if (commentsData.error?.code) break;

        // Find the content_post linked to this platform_post_id
        const { data: publishJob } = await db().from("publish_jobs")
          .select("id, post_id")
          .eq("platform_post_id", videoId)
          .eq("social_account_id", account.id)
          .limit(1)
          .maybeSingle();

        for (const comment of commentsData.data?.comments || []) {
          const { error: upsertErr } = await db().from("platform_comments")
            .upsert({
              brand_id: brandId,
              post_id: publishJob?.post_id || null,
              publish_job_id: publishJob?.id || null,
              social_account_id: account.id,
              platform: "tiktok",
              platform_comment_id: comment.id || `tt_${videoId}_${synced}`,
              platform_post_id: videoId,
              platform_parent_comment_id: comment.parent_comment_id || null,
              author_username: comment.user?.display_name || comment.user?.unique_id || "TikTok User",
              author_profile_url: comment.user?.unique_id ? `https://www.tiktok.com/@${comment.user.unique_id}` : null,
              author_avatar_url: comment.user?.avatar_url || null,
              comment_text: comment.text || "",
              comment_timestamp: comment.create_time
                ? new Date(comment.create_time * 1000).toISOString()
                : new Date().toISOString(),
              like_count: comment.likes || 0,
              sentiment: detectSentiment(comment.text || ""),
              synced_at: new Date().toISOString(),
            }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

          if (!upsertErr) synced++;
        }

        hasMore = commentsData.data?.has_more || false;
        cursor = commentsData.data?.cursor || 0;
      }

      // Rate limit
      if (synced % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[comment-sync] TikTok comment fetch error for video ${videoId}:`, e.message);
    }
  }

  return synced;
}

async function syncTwitterComments(account: any, brandId: string) {
  const accessToken = decrypt(account.access_token_encrypted);
  const userId = account.platform_user_id;
  let synced = 0;

  // Get recent tweets
  const tweetsRes = await fetchWithTimeout(
    `https://api.twitter.com/2/users/${userId}/tweets?max_results=25&tweet.fields=created_at,conversation_id`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
    }
  );
  const tweetsData = await tweetsRes.json();
  if (tweetsData.errors) {
    console.error(`[comment-sync] Twitter tweets list error: ${tweetsData.errors[0]?.message}`);
    return 0;
  }

  for (const tweet of tweetsData.data || []) {
    const tweetId = tweet.id;
    if (!tweetId) continue;

    try {
      // Search for replies to this tweet
      const repliesRes = await fetchWithTimeout(
        `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${tweetId}&tweet.fields=created_at,author_id,in_reply_to_user_id,public_metrics&expansions=author_id&user.fields=username,profile_image_url&max_results=100`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
          },
        }
      );
      const repliesData = await repliesRes.json();
      if (repliesData.errors) continue;

      // Build user lookup map from includes
      const userMap: Record<string, { username: string; profile_image_url?: string }> = {};
      for (const user of repliesData.includes?.users || []) {
        userMap[user.id] = { username: user.username, profile_image_url: user.profile_image_url };
      }

      // Find the content_post linked to this platform_post_id
      const { data: publishJob } = await db().from("publish_jobs")
        .select("id, post_id")
        .eq("platform_post_id", tweetId)
        .eq("social_account_id", account.id)
        .limit(1)
        .maybeSingle();

      for (const reply of repliesData.data || []) {
        // Skip the original tweet itself
        if (reply.id === tweetId) continue;

        const author = userMap[reply.author_id] || {};
        const { error: upsertErr } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: publishJob?.post_id || null,
            publish_job_id: publishJob?.id || null,
            social_account_id: account.id,
            platform: "twitter",
            platform_comment_id: reply.id,
            platform_post_id: tweetId,
            author_username: author.username || `user_${reply.author_id}`,
            author_profile_url: author.username ? `https://x.com/${author.username}` : null,
            author_avatar_url: author.profile_image_url || null,
            comment_text: reply.text || "",
            comment_timestamp: reply.created_at || new Date().toISOString(),
            like_count: reply.public_metrics?.like_count || 0,
            reply_count: reply.public_metrics?.reply_count || 0,
            sentiment: detectSentiment(reply.text || ""),
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!upsertErr) synced++;
      }

      // Rate limit
      if (synced % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[comment-sync] Twitter reply fetch error for tweet ${tweetId}:`, e.message);
    }
  }

  return synced;
}

async function syncSnapchatComments(account: any, brandId: string) {
  const accessToken = decrypt(account.access_token_encrypted);
  let synced = 0;

  // Get recent published posts for this account
  const { data: publishJobs } = await db().from("publish_jobs")
    .select("id, post_id, platform_post_id")
    .eq("social_account_id", account.id)
    .eq("status", "completed")
    .not("platform_post_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(25);

  for (const pj of publishJobs || []) {
    try {
      // Snapchat Marketing API: fetch comments on a creative/media
      const commentsRes = await fetchWithTimeout(
        `https://adsapi.snapchat.com/v1/media/${pj.platform_post_id}/comments?limit=50`,
        {
          headers: { "Authorization": `Bearer ${accessToken}` },
        }
      );

      if (!commentsRes.ok) continue;
      const commentsData = await commentsRes.json();

      for (const comment of commentsData.comments || commentsData.data || []) {
        const commentId = comment.id || comment.comment_id || `sc_${pj.platform_post_id}_${synced}`;

        const { error: upsertErr } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: pj.post_id,
            publish_job_id: pj.id,
            social_account_id: account.id,
            platform: "snapchat",
            platform_comment_id: commentId,
            platform_post_id: pj.platform_post_id,
            author_username: comment.user?.display_name || comment.user?.username || "Snapchat User",
            author_avatar_url: comment.user?.bitmoji_avatar_url || null,
            comment_text: comment.text || comment.message || "",
            comment_timestamp: comment.created_at
              ? new Date(comment.created_at).toISOString()
              : new Date().toISOString(),
            like_count: comment.like_count || 0,
            sentiment: detectSentiment(comment.text || comment.message || ""),
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!upsertErr) synced++;
      }

      if (synced % 20 === 0 && synced > 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[comment-sync] Snapchat comment fetch error for media ${pj.platform_post_id}:`, e.message);
    }
  }

  return synced;
}

// ─── Comment Sync Worker ───

const commentSyncWorker = new Worker(
  "comment-sync",
  async (job) => {
    const { brandId } = job.data;
    console.log(`[comment-sync] Starting sync for brand ${brandId || "all"}...`);

    let totalSynced = 0;
    let brandsProcessed = 0;

    // Get brands to sync
    let brands: any[];
    if (brandId) {
      const { data } = await db().from("brands").select("id, org_id").eq("id", brandId).single();
      brands = data ? [data] : [];
    } else {
      const { data } = await db().from("brands").select("id, org_id");
      brands = data || [];
    }

    for (const brand of brands) {
      // Get all active social accounts for this brand
      const { data: accounts } = await db().from("social_accounts")
        .select("*")
        .eq("brand_id", brand.id)
        .eq("is_active", true);

      for (const account of accounts || []) {
        try {
          let count = 0;
          if (account.platform === "instagram") {
            count = await syncInstagramComments(account, brand.id);
          } else if (account.platform === "youtube") {
            count = await syncYouTubeComments(account, brand.id, brand.org_id);
          } else if (account.platform === "linkedin") {
            count = await syncLinkedInComments(account, brand.id);
          } else if (account.platform === "facebook") {
            count = await syncFacebookComments(account, brand.id);
          } else if (account.platform === "tiktok") {
            count = await syncTikTokComments(account, brand.id);
          } else if (account.platform === "twitter") {
            count = await syncTwitterComments(account, brand.id);
          } else if (account.platform === "snapchat") {
            count = await syncSnapchatComments(account, brand.id);
          }
          totalSynced += count;
          console.log(`[comment-sync] ${account.platform}/@${account.platform_username}: ${count} comments synced`);
        } catch (e: any) {
          console.error(`[comment-sync] Error syncing ${account.platform}/@${account.platform_username}:`, e.message);
        }
      }
      brandsProcessed++;
    }

    console.log(`[comment-sync] Done: ${totalSynced} comments synced across ${brandsProcessed} brands`);
  },
  { connection: redis }
);

// ─── Comment Reply Worker ───

async function postInstagramReply(comment: any, replyText: string, account: any): Promise<string> {
  const igEncPageToken = account.platform_metadata?.page_access_token_encrypted;
  const pageToken = igEncPageToken
    ? decrypt(igEncPageToken)
    : decrypt(account.access_token_encrypted);
  if (!pageToken) throw new Error("No Instagram access token");
  const igApiBase = igEncPageToken ? "https://graph.facebook.com/v19.0" : "https://graph.instagram.com/v21.0";

  const res = await fetchWithTimeout(
    `${igApiBase}/${comment.platform_comment_id}/replies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: replyText,
        access_token: pageToken,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Instagram reply failed: ${err}`);
  }

  const data = await res.json();
  return data.id || `ig_reply_${Date.now()}`;
}

async function postYouTubeReply(comment: any, replyText: string, account: any, orgId: string): Promise<string> {
  const { data: creds } = await db().from("platform_credentials")
    .select("*").eq("org_id", orgId).eq("platform", "youtube").single();
  if (!creds) throw new Error("YouTube credentials not found");

  const oauth2 = new google.auth.OAuth2(
    decrypt(creds.client_id_encrypted),
    decrypt(creds.client_secret_encrypted)
  );
  oauth2.setCredentials({
    access_token: decrypt(account.access_token_encrypted),
    refresh_token: account.refresh_token_encrypted ? decrypt(account.refresh_token_encrypted) : null,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // YouTube replies must be to the top-level comment
  const parentId = comment.platform_parent_comment_id || comment.platform_comment_id;

  const response = await youtube.comments.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        parentId: parentId,
        textOriginal: replyText,
      },
    },
  });

  return response.data.id || `yt_reply_${Date.now()}`;
}

async function postLinkedInReply(comment: any, replyText: string, account: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);
  const personUrn = account.platform_metadata?.person_urn;
  if (!personUrn) throw new Error("No LinkedIn person URN");

  const postUrn = comment.platform_post_id;

  const res = await fetchWithTimeout(
    `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}/comments`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": "202401",
      },
      body: JSON.stringify({
        actor: personUrn,
        message: { text: replyText },
        parentComment: comment.platform_comment_id,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn reply failed: ${err}`);
  }

  const data = await res.json();
  return data.id || data["$URN"] || `li_reply_${Date.now()}`;
}

async function postFacebookReply(comment: any, replyText: string, account: any): Promise<string> {
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) throw new Error("No Facebook page access token");

  const res = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${comment.platform_comment_id}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: replyText,
        access_token: pageToken,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook reply failed: ${err}`);
  }

  const data = await res.json();
  return data.id || `fb_reply_${Date.now()}`;
}

async function postTikTokReply(comment: any, replyText: string, account: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    `https://open.tiktokapis.com/v2/comment/reply/`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        video_id: comment.platform_post_id,
        comment_id: comment.platform_comment_id,
        text: replyText,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok reply failed: ${err}`);
  }

  const data = await res.json();
  return data.data?.comment_id || `tt_reply_${Date.now()}`;
}

async function postTwitterReply(comment: any, replyText: string, account: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    `https://api.twitter.com/2/tweets`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: replyText,
        reply: {
          in_reply_to_tweet_id: comment.platform_comment_id,
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twitter reply failed: ${err}`);
  }

  const data = await res.json();
  return data.data?.id || `tw_reply_${Date.now()}`;
}

async function postSnapchatReply(comment: any, replyText: string, account: any): Promise<string> {
  const accessToken = decrypt(account.access_token_encrypted);

  const res = await fetchWithTimeout(
    `https://adsapi.snapchat.com/v1/media/${comment.platform_post_id}/comments`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: replyText,
        parent_comment_id: comment.platform_comment_id,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Snapchat reply failed: ${err}`);
  }

  const data = await res.json();
  return data.comment?.id || data.id || `sc_reply_${Date.now()}`;
}

const commentReplyWorker = new Worker(
  "comment-reply",
  async () => {
    // Process all pending replies
    const { data: pendingReplies } = await db().from("comment_replies")
      .select("*, platform_comments(id, platform, platform_comment_id, platform_post_id, platform_parent_comment_id, social_account_id, brand_id)")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);

    let sent = 0;
    let errors = 0;

    for (const reply of pendingReplies || []) {
      const comment = reply.platform_comments;
      if (!comment) {
        await db().from("comment_replies").update({ status: "failed", error_message: "Comment not found" }).eq("id", reply.id);
        errors++;
        continue;
      }

      // Mark as sending
      await db().from("comment_replies").update({ status: "sending" }).eq("id", reply.id);

      try {
        // Get social account
        const { data: account } = await db().from("social_accounts")
          .select("*").eq("id", comment.social_account_id).single();
        if (!account) throw new Error("Social account not found");

        // Get org_id for YouTube credentials
        const { data: brand } = await db().from("brands")
          .select("org_id").eq("id", comment.brand_id).single();
        if (!brand) throw new Error("Brand not found");

        let platformReplyId: string;

        if (comment.platform === "instagram") {
          platformReplyId = await postInstagramReply(comment, reply.reply_text, account);
        } else if (comment.platform === "youtube") {
          platformReplyId = await postYouTubeReply(comment, reply.reply_text, account, brand.org_id);
        } else if (comment.platform === "linkedin") {
          platformReplyId = await postLinkedInReply(comment, reply.reply_text, account);
        } else if (comment.platform === "facebook") {
          platformReplyId = await postFacebookReply(comment, reply.reply_text, account);
        } else if (comment.platform === "tiktok") {
          platformReplyId = await postTikTokReply(comment, reply.reply_text, account);
        } else if (comment.platform === "twitter") {
          platformReplyId = await postTwitterReply(comment, reply.reply_text, account);
        } else if (comment.platform === "snapchat") {
          platformReplyId = await postSnapchatReply(comment, reply.reply_text, account);
        } else {
          throw new Error(`Unsupported platform: ${comment.platform}`);
        }

        await db().from("comment_replies").update({
          status: "sent",
          platform_reply_id: platformReplyId,
          sent_at: new Date().toISOString(),
        }).eq("id", reply.id);

        sent++;
      } catch (e: any) {
        console.error(`[comment-reply] Failed to post reply ${reply.id}:`, e.message);
        await db().from("comment_replies").update({
          status: "failed",
          error_message: e.message,
        }).eq("id", reply.id);
        errors++;
      }
    }

    if (sent > 0 || errors > 0) {
      console.log(`[comment-reply] Processed: ${sent} sent, ${errors} failed`);
    }
  },
  { connection: redis }
);

// ─── Startup ───

async function verifyStartup() {
  try {
    const pong = await redis.ping();
    console.log(`  ✓ Redis connected (${pong})`);
  } catch (e: any) {
    console.error("  ✗ Redis failed:", e.message);
    process.exit(1);
  }

  try {
    await db().from("organizations").select("id").limit(1);
    console.log("  ✓ Supabase connected");
  } catch (e: any) {
    console.error("  ✗ Supabase failed:", e.message);
    process.exit(1);
  }

  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.error("  ✗ TOKEN_ENCRYPTION_KEY is not set — cannot decrypt tokens");
    process.exit(1);
  }
  console.log("  ✓ Encryption key configured");

  try {
    const { execSync } = require("child_process");
    execSync("ffmpeg -version", { encoding: "utf8", stdio: "pipe" });
    console.log("  ✓ FFmpeg available");
  } catch {
    console.warn("  ⚠ FFmpeg not found — video processing limited");
  }

  // Background work is deliberately opt-in. A running worker must not start
  // polling every connected account simply because the dashboard is open.
  // Manual queue actions are still available; setting this flag to "true"
  // enables the periodic maintenance jobs below.
  const automaticBackgroundJobsEnabled = process.env.ENABLE_AUTOMATIC_BACKGROUND_JOBS === "true";

  // Schedule cron jobs
  const analyticsQueue = new Queue("analytics-fetch", { connection: redis });
  const tokenQueue = new Queue("token-refresh", { connection: redis });
  const trendQueue = new Queue("trend-forecast", { connection: redis });
  const sentimentQueue = new Queue("comment-sentiment", { connection: redis });
  const competitorQueue = new Queue("competitor-fetch", { connection: redis });
  const commentSyncQueue = new Queue("comment-sync", { connection: redis });
  const commentReplyQueue = new Queue("comment-reply", { connection: redis });

  if (automaticBackgroundJobsEnabled) {
    await analyticsQueue.add("fetch-all", {}, { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: "analytics-cron" });
    await tokenQueue.add("refresh-all", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "token-refresh-cron" });
    await trendQueue.add("forecast-all", {}, { repeat: { every: 7 * 24 * 60 * 60 * 1000 }, jobId: "trend-forecast-cron" });
    await sentimentQueue.add("analyze-all", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "comment-sentiment-cron" });
    await competitorQueue.add("fetch-all", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "competitor-fetch-cron" });
    await commentSyncQueue.add("sync-all", {}, { repeat: { every: 2 * 60 * 60 * 1000 }, jobId: "comment-sync-cron" });
    await commentReplyQueue.add("process-pending", {}, { repeat: { every: 5 * 60 * 1000 }, jobId: "comment-reply-cron" });
    console.log("  ✓ Automatic background jobs enabled");
  } else {
    await analyticsQueue.removeRepeatable("fetch-all", { every: 6 * 60 * 60 * 1000 }, "analytics-cron");
    await tokenQueue.removeRepeatable("refresh-all", { every: 24 * 60 * 60 * 1000 }, "token-refresh-cron");
    await trendQueue.removeRepeatable("forecast-all", { every: 7 * 24 * 60 * 60 * 1000 }, "trend-forecast-cron");
    await sentimentQueue.removeRepeatable("analyze-all", { every: 24 * 60 * 60 * 1000 }, "comment-sentiment-cron");
    await competitorQueue.removeRepeatable("fetch-all", { every: 24 * 60 * 60 * 1000 }, "competitor-fetch-cron");
    await commentSyncQueue.removeRepeatable("sync-all", { every: 2 * 60 * 60 * 1000 }, "comment-sync-cron");
    await commentReplyQueue.removeRepeatable("process-pending", { every: 5 * 60 * 1000 }, "comment-reply-cron");
    console.log("  • Automatic background jobs disabled; use manual actions when needed");
  }
}

// ─── Instagram comment harvest ───
//
// Long-running (minutes to days), so it lives here rather than in a request.
// Progress is streamed into insta_comment_runs so the dashboard can poll it,
// and the run's status doubles as a cooperative cancel flag.
const instaCommentWorker = new Worker(
  "insta-comment-harvest",
  async (job) => {
    const { runId } = job.data as { runId: string };
    console.log(`[insta-comment-harvest] starting run ${runId}`);

    const { data: run } = await db().from("insta_comment_runs").select("*").eq("id", runId).maybeSingle();
    if (!run) {
      console.warn(`[insta-comment-harvest] run ${runId} not found`);
      return;
    }

    const fail = async (message: string) => {
      await db()
        .from("insta_comment_runs")
        .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
        .eq("id", runId);
      console.error(`[insta-comment-harvest] ${runId} failed: ${message}`);
    };

    // Resolve the session the run was created with, falling back to any active one.
    const { data: sess } = await db()
      .from("insta_sessions")
      .select("id, session_id_encrypted, status")
      .eq("id", run.session_id)
      .maybeSingle();
    const encrypted =
      sess?.session_id_encrypted ??
      (
        await db()
          .from("insta_sessions")
          .select("session_id_encrypted")
          .eq("org_id", run.org_id)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ).data?.session_id_encrypted;
    if (!encrypted) return fail("No usable Instagram session");

    let session: string;
    try {
      session = decrypt(encrypted);
    } catch {
      return fail("Instagram session could not be decrypted");
    }

    const { harvestManyPosts, CommentRateGovernor } = await import(
      "./src/server/services/instagram/comments"
    );

    const allPosts: { mediaId: string; shortcode: string; commentCount: number }[] = run.posts ?? [];
    const retryIds = Array.isArray(run.retry_media_ids)
      ? new Set(run.retry_media_ids.filter((id: unknown): id is string => typeof id === "string"))
      : null;
    const posts = retryIds ? allPosts.filter((post) => retryIds.has(post.mediaId)) : allPosts;
    if (!posts.length) return fail("Run has no posts");

    const startedAt = Date.now();
    await db()
      .from("insta_comment_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", runId);

    const shortcodeFor = new Map(allPosts.map((p) => [p.mediaId, p.shortcode]));
    type PostProgress = {
      status: "pending" | "running" | "complete" | "partial" | "failed";
      reportedCount: number | null;
      scrapedCount: number;
      topLevelCount: number;
      replyCount: number;
      pagesFetched: number;
      requestCount: number;
      error?: string;
    };
    const perPost: Record<string, PostProgress> = Object.fromEntries(
      Object.entries(run.progress?.perPost ?? {}).map(([mediaId, value]: [string, any]) => {
        // Older runs stored only a numeric count. Preserve it rather than
        // making a retry erase visible progress when upgrading this worker.
        if (typeof value === "number") {
          const expected = allPosts.find((post) => post.mediaId === mediaId)?.commentCount ?? null;
          return [mediaId, { status: "partial", reportedCount: expected, scrapedCount: value, topLevelCount: value, replyCount: 0, pagesFetched: 0, requestCount: 0 }];
        }
        return [mediaId, value as PostProgress];
      }),
    );
    const governor = new CommentRateGovernor();
    const abort = new AbortController();

    // Cooperative cancel + progress flush, both on the same interval.
    let lastFlush = 0;
    const flush = async (force = false) => {
      if (!force && Date.now() - lastFlush < 3000) return;
      lastFlush = Date.now();
      const total = Object.values(perPost).reduce((sum, post) => sum + post.scrapedCount, 0);
      const secs = (Date.now() - startedAt) / 1000;
      await db()
        .from("insta_comment_runs")
        .update({
          total_comments: total,
          throughput_per_sec: secs > 0 ? Math.round((total / secs) * 10) / 10 : null,
          throttle_count: governor.throttleCount,
          current_pace_ms: governor.current,
          progress: { perPost, updatedAt: new Date().toISOString() },
        })
        .eq("id", runId);
    };

    const cancelPoll = setInterval(async () => {
      const { data } = await db().from("insta_comment_runs").select("status").eq("id", runId).maybeSingle();
      if (data?.status === "cancelled") {
        console.log(`[insta-comment-harvest] ${runId} cancelled by user`);
        abort.abort();
      }
    }, 5000);

    const persistResult = async (r: { mediaId: string; comments: any[]; reportedTotal: number | null; pagesFetched: number; requestCount: number; truncated: boolean; error?: string }) => {
      const reportedCount = r.reportedTotal ?? allPosts.find((post) => post.mediaId === r.mediaId)?.commentCount ?? null;

      // Checkpoint each completed post immediately. A worker restart, manual
      // cancel, or rate-limit after this point never loses its comments.
      const rows = r.comments.map((c) => ({
        run_id: runId,
        org_id: run.org_id,
        post_media_id: r.mediaId,
        post_shortcode: shortcodeFor.get(r.mediaId) ?? null,
        comment_id: c.id,
        comment_text: c.text,
        comment_created_at: c.createdAt,
        comment_likes: c.likeCount,
        depth: c.depth,
        parent_comment_id: c.parentId,
        reply_count: c.replyCount,
        commenter_username: c.username,
        commenter_full_name: c.fullName,
        commenter_user_id: c.userId,
        commenter_verified: c.isVerified,
      }));
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await db().from("insta_comments").upsert(rows.slice(i, i + 1000), { onConflict: "run_id,comment_id", ignoreDuplicates: true });
        if (error) throw new Error(`Could not checkpoint Instagram comments: ${error.message}`);
      }

      // Keep a local, merged media workspace in addition to the normalized
      // audit rows. This is the source for UI deltas and retries, so a partial
      // later pass never makes an earlier complete collection disappear.
      const { data: existingMedia, error: existingError } = await db()
        .from("insta_comment_media")
        .select("comments_json")
        .eq("org_id", run.org_id)
        .eq("target_username", run.target_username)
        .eq("media_id", r.mediaId)
        .maybeSingle();
      if (existingError) throw new Error(`Could not read Instagram comment workspace: ${existingError.message}`);
      const commentsById = new Map<string, any>();
      for (const comment of Array.isArray(existingMedia?.comments_json) ? existingMedia.comments_json : []) {
        if (comment?.id != null) commentsById.set(String(comment.id), comment);
      }
      for (const comment of r.comments) if (comment?.id != null) commentsById.set(String(comment.id), comment);
      const mergedComments = [...commentsById.values()];
      const topLevelCount = mergedComments.filter((comment) => comment.depth === 0).length;
      const replyCount = mergedComments.length - topLevelCount;
      const status: PostProgress["status"] = r.error ? "failed" : r.truncated || (reportedCount != null && mergedComments.length < reportedCount) ? "partial" : "complete";
      perPost[r.mediaId] = {
        status,
        reportedCount,
        scrapedCount: mergedComments.length,
        topLevelCount,
        replyCount,
        pagesFetched: r.pagesFetched,
        requestCount: r.requestCount,
        ...(r.error ? { error: r.error } : {}),
      };
      const post = allPosts.find((entry) => entry.mediaId === r.mediaId);
      const { error: workspaceError } = await db().from("insta_comment_media").upsert({
        org_id: run.org_id,
        target_username: run.target_username,
        media_id: r.mediaId,
        shortcode: post?.shortcode ?? null,
        media_url: (post as any)?.url ?? null,
        media_kind: (post as any)?.kind ?? null,
        likes_count: Number.isFinite((post as any)?.likes) ? (post as any).likes : null,
        comments_count_reported: reportedCount,
        comments_scraped_count: mergedComments.length,
        comments_top_level_count: topLevelCount,
        comments_reply_count: replyCount,
        comments_status: status,
        comments_stop_reason: r.truncated ? "pagination_incomplete" : null,
        comments_error: r.error ?? null,
        comments_json: mergedComments,
        last_run_id: runId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,target_username,media_id" });
      if (workspaceError) throw new Error(`Could not save Instagram comment workspace: ${workspaceError.message}`);
      await flush(true);
    };

    try {
      const { results, totalComments: harvestedComments, throttleCount, elapsedMs } = await harvestManyPosts(
        posts.map((p) => p.mediaId),
        session,
        {
          concurrency: run.concurrency ?? 5,
          maxPerPost: run.comment_limit > 0 ? run.comment_limit : Infinity,
          includeReplies: Boolean(run.include_replies),
          governor,
          signal: abort.signal,
          onProgress: ({ mediaId, fetched, reportedTotal }) => {
            const previous = perPost[mediaId];
            perPost[mediaId] = {
              status: "running",
              reportedCount: reportedTotal ?? previous?.reportedCount ?? allPosts.find((post) => post.mediaId === mediaId)?.commentCount ?? null,
              scrapedCount: fetched,
              topLevelCount: previous?.topLevelCount ?? fetched,
              replyCount: previous?.replyCount ?? 0,
              pagesFetched: previous?.pagesFetched ?? 0,
              requestCount: previous?.requestCount ?? 0,
            };
            void flush();
          },
          onResult: persistResult,
        },
      );

      const expected = run.expected_comments || allPosts.reduce((a, p) => a + p.commentCount, 0);
      const cancelled = abort.signal.aborted;
      const requestCount = results.reduce((a, r) => a + r.requestCount, 0);
      const secs = elapsedMs / 1000;
      const { count: storedComments } = await db().from("insta_comments").select("id", { count: "exact", head: true }).eq("run_id", runId);
      const totalComments = storedComments ?? harvestedComments;
      const hasGap = Object.values(perPost).some((post) => post.status !== "complete" || (post.reportedCount != null && post.scrapedCount < post.reportedCount));

      await db()
        .from("insta_comment_runs")
        .update({
          status: cancelled ? "cancelled" : hasGap ? "partial" : "completed",
          total_comments: totalComments,
          coverage_pct: expected > 0 ? Math.round((totalComments / expected) * 1000) / 10 : null,
          request_count: requestCount,
          throttle_count: throttleCount,
          throughput_per_sec: secs > 0 ? Math.round((totalComments / secs) * 10) / 10 : null,
          current_pace_ms: governor.current,
          duration_ms: elapsedMs,
          progress: { perPost, updatedAt: new Date().toISOString() },
          retry_media_ids: null,
          completed_at: new Date().toISOString(),
          error: results.find((r) => r.error)?.error ?? null,
        })
        .eq("id", runId);

      // Drive export is deliberately after the durable database checkpoint.
      // A Drive quota/auth failure never turns a completed collection into a
      // failed scrape.  Each profile is merged into one managed Google Sheet.
      if (run.drive_brand_id) {
        try {
          const { syncInstagramProfileSheet } = await import("./src/server/services/instagram/drive-export");
          const saved = await syncInstagramProfileSheet({
            org_id: run.org_id,
            role: "admin",
            brand_id: run.drive_brand_id,
            assigned_brands: [run.drive_brand_id],
          }, { brandId: run.drive_brand_id, username: run.target_username });
          await db().from("insta_comment_media").update({
            drive_sheet_id: saved.id,
            drive_sheet_url: saved.url,
            drive_synced_at: new Date().toISOString(),
          }).eq("org_id", run.org_id).eq("target_username", run.target_username);
          await db().from("insta_comment_runs").update({
            drive_export_status: "complete",
            drive_export_error: null,
            drive_exported_at: new Date().toISOString(),
          }).eq("id", runId);
        } catch (exportError: any) {
          const message = exportError?.message ?? "Instagram Drive export failed";
          await db().from("insta_comment_runs").update({
            drive_export_status: "failed",
            drive_export_error: message,
          }).eq("id", runId);
          console.error(`[insta-comment-harvest] ${runId} Drive export failed: ${message}`);
        }
      }

      console.log(
        `[insta-comment-harvest] ${runId} done: ${totalComments} stored comments in ${(secs / 60).toFixed(1)}min, ${throttleCount} throttles`,
      );
    } catch (err: any) {
      await fail(err?.message ?? "harvest crashed");
    } finally {
      clearInterval(cancelPoll);
      await flush(true).catch(() => {});
    }
  },
  { connection: redis, concurrency: 1 },
);

instaCommentWorker.on("failed", (job, err) => {
  console.error(`[insta-comment-harvest] job ${job?.id} failed:`, err?.message);
});

// ─── Editor Render Worker ───
//
// Renders a media_edits document to a flat file and stores it in the brand's
// Drive "processed" folder.  Images go through sharp in-process; video goes
// through ffmpeg, file -> file on the render-tmp volume (see renderVideoEdit).
//
// The job payload is ID-ONLY ({ editId }).  Redis runs with
// --maxmemory-policy noeviction, so a document (or a base64 overlay) in the job
// body would push it towards refusing writes; re-reading the row is also the
// only way a retry picks up the latest document.
//
// Three facts about sharp 0.34.5 were verified empirically in this image and the
// pipeline below depends on all of them:
//
//  1. `recomb` is applied BEFORE `linear`, and the intermediate is kept in float
//     (clamping happens once, on the final cast to uchar).  So `.recomb(M)` plus
//     `.linear([1,1,1], b)` computes exactly `M·in + b` — which is what lets a
//     whole CSS filter chain collapse into one matrix and one offset.
//  2. `composite` is applied BEFORE the colour operations.  A single pipeline
//     would therefore tint the overlay as well, but the browser preview filters
//     the base image only.  Hence two passes: base+effects to raw pixels, then
//     composite and encode.
//  3. `rotate()` with no argument applies EXIF orientation.  sharp does not do
//     this implicitly but every browser does, so the crop rectangle in the
//     document is expressed against the ORIENTED image.  Skipping it renders
//     phone photos sideways and crops the wrong region.

type ColourXform = { m: number[][]; off: number[] };

const IDENTITY_XFORM: ColourXform = { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], off: [0, 0, 0] };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function matMul3(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}

function matVec3(a: number[][], v: number[]): number[] {
  return [0, 1, 2].map((i) => a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2]);
}

/** Apply `next` after `prev`: next.m·(prev.m·in + prev.off) + next.off. */
function composeXform(prev: ColourXform, next: ColourXform): ColourXform {
  return {
    m: matMul3(next.m, prev.m),
    off: matVec3(next.m, prev.off).map((v, i) => v + next.off[i]),
  };
}

function scalarXform(slope: number, intercept: number): ColourXform {
  return {
    m: [[slope, 0, 0], [0, slope, 0], [0, 0, slope]],
    off: [intercept, intercept, intercept],
  };
}

/** Filter Effects `saturate(s)`.  grayscale(a) is the same matrix at s = 1 - a. */
function saturateMatrix(s: number): number[][] {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
}

/** Filter Effects `sepia(amount)`, k = 1 - amount. */
function sepiaMatrix(amount: number): number[][] {
  const k = 1 - clamp01(amount);
  return [
    [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
    [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
    [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k],
  ];
}

/**
 * Collapse the document's effect list into one colour transform plus one blur
 * sigma.
 *
 * Every supported effect is an exact affine operation on sRGB channel values,
 * which is the whole reason the document only allows these six — `modulate()`
 * works in LCh and `ffmpeg eq` is an additive YUV offset, so neither reproduces
 * the CSS preview.
 *
 * brightness(v) -> out = in·v                (CSS: linear multiply)
 * contrast(v)   -> out = in·v + 127.5·(1-v)  (CSS: pivot around mid-grey)
 * saturate/grayscale/sepia -> 3x3 matrices from the Filter Effects spec
 *
 * Blur is a normalised convolution, so it commutes with any affine colour
 * transform and can be hoisted out of the chain; two Gaussians compose in
 * quadrature, not by addition.
 *
 * One known divergence: CSS clamps between each filter function while this
 * clamps once at the end.  It only shows on chains that overshoot and come back.
 */
function buildEffectChain(effects: Array<{ type: string; value: number }>): {
  colour: ColourXform;
  blurSigma: number;
} {
  let colour = IDENTITY_XFORM;
  let blurVariance = 0;

  for (const effect of effects) {
    const value = Number.isFinite(effect.value) ? effect.value : 1;
    switch (effect.type) {
      case "brightness":
        colour = composeXform(colour, scalarXform(Math.max(0, value), 0));
        break;
      case "contrast": {
        const v = Math.max(0, value);
        colour = composeXform(colour, scalarXform(v, 127.5 * (1 - v)));
        break;
      }
      case "saturation":
        colour = composeXform(colour, { m: saturateMatrix(Math.max(0, value)), off: [0, 0, 0] });
        break;
      case "grayscale":
        colour = composeXform(colour, { m: saturateMatrix(1 - clamp01(value)), off: [0, 0, 0] });
        break;
      case "sepia":
        colour = composeXform(colour, { m: sepiaMatrix(value), off: [0, 0, 0] });
        break;
      case "blur":
        if (value > 0) blurVariance += value * value;
        break;
      default:
        break;
    }
  }

  return { colour, blurSigma: blurVariance > 0 ? Math.sqrt(blurVariance) : 0 };
}

function isIdentityMatrix(m: number[][]): boolean {
  const identity = IDENTITY_XFORM.m;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs(m[i][j] - identity[i][j]) > 1e-6) return false;
    }
  }
  return true;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// Geometry for the image path lives in src/lib/editor/sharp-plan.ts — a pure
// module with its own unit tests (scripts/editor/sharp-plan.test.ts), the same
// shape as ffmpeg-plan.ts for the video path. It is imported dynamically at
// render time like the other @/-resolved modules this worker reaches for.
type BaseTransform = import("./src/lib/editor/sharp-plan").BaseTransform;

async function setRenderState(editId: string, patch: Record<string, unknown>): Promise<void> {
  // No updated_at trigger exists on media_edits, so every write sets it.
  await db()
    .from("media_edits")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", editId);
}

// ─── Editor render: shared plumbing ───

const MIME_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".weba",
  "audio/flac": ".flac",
};

/**
 * A temp-file extension for a Drive download.
 *
 * ffmpeg content-probes rather than trusting the name, so this is a hint only —
 * but a few demuxers (and every "what is this file" debugging session) are
 * easier when the scratch file is named plausibly.
 */
function tmpExtension(
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
  fallback: string
): string {
  const normalized = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (normalized && MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized];
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(fileName ?? ""));
  if (match) return `.${match[1].toLowerCase()}`;
  return fallback;
}

/** The one Drive original a render reads from, plus the tenancy it belongs to. */
type RenderSource = {
  driveFileId: string;
  fileName: string;
  fileType: string;
  brandId: string;
  orgId: string;
};

/**
 * Resolve the source original for an edit — the single place both the image and
 * the video path get their input, so the two cannot drift.
 *
 * Order matters, and the two cases are genuinely different shapes:
 *
 *  1. `source_drive_file_id` (migration 00042, the normal case now): the Editor
 *     sources its OWN media, so the draft carries a freshly uploaded original in
 *     the brand's Originals folder with NO `media_assets` row at all. That is
 *     expected, not a missing join — only `transferToLibrary` ever creates an
 *     asset row. The brand is the edit's own `brand_id`, and the org comes from
 *     `brands.org_id`.
 *  2. `source_asset_id` (pre-00042 drafts): a Media Library asset, reached
 *     through `media_groups` so the asset's brand can be compared with the
 *     edit's.
 */
async function resolveRenderSource(edit: any): Promise<RenderSource> {
  const brandId: string | undefined = edit.brand_id;
  if (!brandId) throw new Error("This draft has no brand");

  // Needed by every path: the Drive client is keyed on (brand, org) and for an
  // Editor-owned source `brands.org_id` is the only place the org lives.
  const { data: brand } = await db()
    .from("brands")
    .select("id, org_id")
    .eq("id", brandId)
    .single();
  if (!brand?.org_id) throw new Error("Brand not found for this edit");
  const orgId: string = brand.org_id;

  if (edit.source_drive_file_id) {
    return {
      driveFileId: edit.source_drive_file_id,
      fileName: edit.source_file_name || "source",
      fileType: edit.source_file_type || "application/octet-stream",
      brandId,
      orgId,
    };
  }

  if (edit.source_asset_id) {
    const { data: asset } = await db()
      .from("media_assets")
      .select("id, drive_file_id, file_name, file_type, group:media_groups(id, brand_id)")
      .eq("id", edit.source_asset_id)
      .single();
    if (!asset) throw new Error("Source asset not found");
    if (!asset.drive_file_id) throw new Error("Source asset has no Drive file");

    const assetBrandId: string | undefined = (asset as any).group?.brand_id;
    if (!assetBrandId || assetBrandId !== brandId) {
      throw new Error("Source asset does not belong to this edit's brand");
    }

    // Only drive_file_id is carried out of the asset row on purpose:
    // downloadFromDrive prefers processed_drive_file_id, and the editor must
    // always start from the ORIGINAL rather than from a previously processed
    // derivative.
    return {
      driveFileId: asset.drive_file_id,
      fileName: asset.file_name || "source",
      fileType: asset.file_type || "application/octet-stream",
      brandId,
      orgId,
    };
  }

  throw new Error(
    "This draft has no source: neither source_drive_file_id nor source_asset_id is set"
  );
}

/**
 * Resolve `doc.audio.trackId` to an audio_tracks row.
 *
 * The track id arrives inside a client-supplied document, so the brand check is
 * a real authorization boundary (this worker uses the service role and bypasses
 * RLS), not a sanity check.
 */
async function resolveAudioTrack(
  edit: any,
  trackId: string | null
): Promise<{ id: string; drive_file_id: string; name: string | null; mime_type: string | null } | null> {
  if (!trackId) return null;

  const { data: track } = await db()
    .from("audio_tracks")
    .select("id, brand_id, drive_file_id, name, mime_type")
    .eq("id", trackId)
    .single();
  if (!track) throw new Error("Audio track not found");
  if (track.brand_id !== edit.brand_id) {
    throw new Error("Audio track does not belong to this edit's brand");
  }
  if (!track.drive_file_id) throw new Error("Audio track has no Drive file");

  return {
    id: track.id,
    drive_file_id: track.drive_file_id,
    name: track.name ?? null,
    mime_type: track.mime_type ?? null,
  };
}

/** No new bytes on disk for this long means the Drive stream is wedged, not slow. */
const DRIVE_STALL_MS = 120_000;

/** How often the stall watchdog looks at the growing file. */
const DRIVE_STALL_POLL_MS = 5_000;

/**
 * Stream a Drive file straight to `destPath`.
 *
 * Deliberately NOT the Buffer-returning helpers (`downloadFromDrive` above, or
 * the service's `downloadFile`): a video render has a source, an overlay, an
 * audio bed and an output alive at once, the container is capped at 2 GB with a
 * 1536 MB heap, and an OOM here kills all 12 workers in this process — including
 * a publish job that has created an Instagram container but not yet recorded
 * platform_post_id, which then re-posts on retry across every account.
 *
 * The client is fetched per call because `getAuthenticatedDrive` re-checks the
 * token expiry and refreshes through drive_connections; a render easily outlives
 * an access token.
 *
 * Progress is measured by stat()ing the destination rather than by listening for
 * 'data' on the response: attaching a data listener switches the stream to
 * flowing mode before pipeline() attaches its consumer, which silently drops the
 * leading chunks.
 */
async function downloadDriveFileToDisk(
  driveFileId: string,
  brandId: string,
  orgId: string,
  destPath: string
): Promise<number> {
  const driveSvc = await import("./src/server/services/drive/client");
  const drive = await driveSvc.getAuthenticatedDrive(brandId, orgId);

  const res = await drive.files.get({ fileId: driveFileId, alt: "media" }, { responseType: "stream" });
  const body = res.data as unknown as NodeJS.ReadableStream & {
    destroy: (error?: Error) => void;
  };

  const fs = await import("fs");
  const fsp = await import("fs/promises");
  const { pipeline } = await import("stream/promises");

  let lastSize = -1;
  let lastGrowthAt = Date.now();
  const watchdog = setInterval(() => {
    void fsp
      .stat(destPath)
      .then((info) => {
        if (info.size > lastSize) {
          lastSize = info.size;
          lastGrowthAt = Date.now();
        } else if (Date.now() - lastGrowthAt > DRIVE_STALL_MS) {
          body.destroy(new Error(`Drive download stalled at ${info.size} bytes`));
        }
      })
      .catch(() => {});
  }, DRIVE_STALL_POLL_MS);

  try {
    await pipeline(body, fs.createWriteStream(destPath));
  } finally {
    clearInterval(watchdog);
  }

  const info = await fsp.stat(destPath);
  if (!info.size) throw new Error(`Drive file ${driveFileId} downloaded as 0 bytes`);
  return info.size;
}

/**
 * Every ffmpeg/ffprobe child currently running, so a SIGTERM can kill them
 * before `renderWorker.close()` sits waiting on a render that would otherwise
 * hold shutdown open until the container is SIGKILLed — which would skip the
 * temp-file cleanup entirely.
 */
const activeRenderChildren = new Set<any>();

function killActiveRenderChildren(): void {
  for (const child of activeRenderChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** `ffprobe -show_streams -show_format` as parsed JSON, spawned asynchronously. */
async function probeMediaFile(filePath: string): Promise<unknown> {
  const { spawn } = await import("child_process");
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    activeRenderChildren.add(child);

    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 2000) err += chunk.toString("utf8");
    });
    child.once("error", (e: any) => {
      activeRenderChildren.delete(child);
      reject(new Error(`ffprobe could not be started: ${e?.message ?? e}`));
    });
    child.once("close", (code: number | null) => {
      activeRenderChildren.delete(child);
      if (code !== 0) {
        reject(
          new Error(`ffprobe exited ${code}: ${err.trim().slice(0, 400) || "no stderr output"}`)
        );
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("ffprobe returned unparseable JSON"));
      }
    });
  });
}

/** Keep at most this many non-progress stderr lines for render_error. */
const FFMPEG_ERROR_LINES = 24;

/**
 * True for a `-stats` / `-progress` line.
 *
 * `-loglevel error -stats` interleaves progress with real errors on the same
 * stream, so separating them is what keeps render_error readable instead of
 * being 700 characters of `frame= ... speed=`.
 */
function isFfmpegStatsLine(line: string): boolean {
  if (/^(frame|fps|size|total_size|bitrate|speed|out_time|out_time_us|out_time_ms|dup_frames|drop_frames|stream_\d|progress)=/.test(line)) {
    return true;
  }
  return /\btime=\s*-?\d+:\d{2}:\d{2}/.test(line) && /\bbitrate=|\bspeed=/.test(line);
}

/**
 * Run ffmpeg to completion, forwarding progress lines and keeping the tail of
 * everything else for the error message.
 *
 * `spawn`, never `execSync`/`execFileSync`: blocking the event loop for the
 * length of a render stops BullMQ renewing the job lock, the job is picked up as
 * stalled, and the same edit renders twice.
 */
async function runFfmpeg(args: string[], onStatsLine: (line: string) => void): Promise<void> {
  const { spawn } = await import("child_process");
  return await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    activeRenderChildren.add(child);

    const errorLines: string[] = [];
    let partial = "";

    const consume = (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      if (isFfmpegStatsLine(trimmed)) {
        onStatsLine(trimmed);
        return;
      }
      errorLines.push(trimmed.slice(0, 300));
      if (errorLines.length > FFMPEG_ERROR_LINES) errorLines.shift();
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      // -stats separates updates with \r, not \n. Splitting on newlines alone
      // accumulates one ever-growing line and never reports any progress.
      partial += chunk.toString("utf8");
      const parts = partial.split(/[\r\n]+/);
      partial = parts.pop() ?? "";
      // A pathological line with no separator must not grow without bound.
      if (partial.length > 65536) partial = partial.slice(-4096);
      for (const line of parts) consume(line);
    });

    child.once("error", (err: any) => {
      activeRenderChildren.delete(child);
      reject(new Error(`ffmpeg could not be started: ${err?.message ?? err}`));
    });

    child.once("close", (code: number | null, signal: string | null) => {
      activeRenderChildren.delete(child);
      if (partial) consume(partial);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = errorLines.join(" | ").slice(-700) || "no stderr output";
      reject(new Error(`ffmpeg exited ${code ?? `on ${signal}`}: ${detail}`));
    });
  });
}

/** Progress band reserved for ffmpeg itself; downloads are below, upload above. */
const RENDER_PROGRESS_FLOOR = 30;
const RENDER_PROGRESS_CEIL = 85;
/** Floor on the gap between two render_progress UPDATEs. */
const RENDER_PROGRESS_MIN_INTERVAL_MS = 2000;

/**
 * Cap on the rendered output before it is read into a Buffer for the upload.
 *
 * `uploadFile` takes a Buffer, so this one read is unavoidable; the cap is what
 * keeps it from becoming the OOM that streaming everything else avoided.
 */
const RENDER_MAX_OUTPUT_BYTES = 400 * 1024 * 1024;

/**
 * Render a video edit: Drive -> temp file -> ffmpeg -> temp file -> Drive.
 *
 * The filter graph and the whole argv come from src/lib/editor/ffmpeg-plan.ts,
 * which is unit-tested and was validated against this image's ffmpeg 8.0.1.
 * `plan.args` is passed through verbatim — appending or reordering flags here
 * would silently invalidate that validation (notably `-display_rotation 0`
 * and `-noautorotate`, which must stay INPUT options ahead of `-i`).
 */
async function renderVideoEdit(
  editId: string,
  edit: any
): Promise<{
  editId: string;
  driveFileId: string;
  width: number;
  height: number;
  durationMs: number | null;
}> {
  const { editDocSchema, reduceRatio } = await import("./src/lib/editor/doc");
  const { parseProbe, buildRenderPlan, parseProgress } = await import(
    "./src/lib/editor/ffmpeg-plan"
  );

  const doc = editDocSchema.parse(edit.doc);
  const source = await resolveRenderSource(edit);
  const { brandId, orgId } = source;

  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  // One directory per job on the render-tmp volume (a real volume, not tmpfs —
  // tmpfs would spend the container's memory limit on scratch files). The unique
  // name is what stops two concurrent renders colliding, and the whole directory
  // is what the finally removes.
  const tmpRoot = process.env.RENDER_TMP_DIR || os.tmpdir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(tmpRoot, `edit-${editId.slice(0, 8)}-`));

  try {
    await setRenderState(editId, {
      render_status: "rendering",
      render_progress: 5,
      render_error: null,
    });

    // ── Inputs: streamed to disk, never held as Buffers ──
    const inputPath = path.join(
      workDir,
      `source${tmpExtension(source.fileName, source.fileType, ".mp4")}`
    );
    const inputBytes = await downloadDriveFileToDisk(
      source.driveFileId,
      brandId,
      orgId,
      inputPath
    );
    console.log(
      `[render] ${editId}: source ${(inputBytes / 1024 / 1024).toFixed(1)} MB streamed to disk`
    );
    await setRenderState(editId, { render_progress: 15 });

    // One browser-rasterised transparent PNG holding the whole layer stack; the
    // planner composites it after the effects, exactly as the CSS preview
    // filters only the media element.
    const overlayFileId: string | null =
      doc.overlayDriveFileId || edit.overlay_drive_file_id || null;
    let overlayPngPath: string | null = null;
    if (overlayFileId) {
      overlayPngPath = path.join(workDir, "overlay.png");
      await downloadDriveFileToDisk(overlayFileId, brandId, orgId, overlayPngPath);
    }

    let audioPath: string | null = null;
    const track = await resolveAudioTrack(edit, doc.audio.trackId);
    if (track) {
      audioPath = path.join(
        workDir,
        `music${tmpExtension(track.name, track.mime_type, ".m4a")}`
      );
      await downloadDriveFileToDisk(track.drive_file_id, brandId, orgId, audioPath);
    }

    await setRenderState(editId, { render_progress: 25 });

    // ── Plan ──
    // Probe the REAL file. media_edits.source_* / media_assets columns are what
    // the uploader happened to record; rotation, HDR transfer and the exact
    // duration all come from the bytes we are about to feed ffmpeg.
    const probe = parseProbe(await probeMediaFile(inputPath));
    if (!probe.width || !probe.height) {
      throw new Error("ffprobe found no video stream in the source file");
    }

    const outputPath = path.join(workDir, "out.mp4");
    const plan = buildRenderPlan({
      doc,
      probe,
      inputVideoPath: inputPath,
      overlayPngPath,
      audioPath,
      outputPath,
    });
    if (plan.notes.length > 0) {
      console.log(`[render] ${editId}: ${plan.notes.join("; ")}`);
    }

    // ── Encode ──
    const total = plan.expectedDurationSeconds;
    let lastPercentWritten = -1;
    let lastWriteAt = 0;
    let writeInFlight = false;

    const reportProgress = (line: string) => {
      const pct = parseProgress(line, total);
      if (pct === null) return;
      const mapped = Math.round(
        RENDER_PROGRESS_FLOOR + (pct / 100) * (RENDER_PROGRESS_CEIL - RENDER_PROGRESS_FLOOR)
      );
      // Throttled three ways: the whole percent must actually have moved, two
      // seconds must have passed, and the previous UPDATE must have landed.
      // ffmpeg emits several stats lines a second and one write per line would
      // be hundreds of UPDATEs on a short clip.
      if (mapped === lastPercentWritten || writeInFlight) return;
      const now = Date.now();
      if (now - lastWriteAt < RENDER_PROGRESS_MIN_INTERVAL_MS) return;
      lastPercentWritten = mapped;
      lastWriteAt = now;
      writeInFlight = true;
      // Fire-and-forget: a progress write must never fail the render, and must
      // never leave an unhandled rejection either.
      void setRenderState(editId, { render_progress: mapped })
        .catch(() => {})
        .then(() => {
          writeInFlight = false;
        });
    };

    const startedAt = Date.now();
    await runFfmpeg(plan.args, reportProgress);
    const encodeSeconds = (Date.now() - startedAt) / 1000;

    // ── Measure what ffmpeg ACTUALLY produced ──
    // Not plan.expectedDurationSeconds and not doc.canvas: if ffmpeg emitted
    // something else, the database has to say so. rules-engine.getValidActions
    // matches aspect_ratio as an EXACT string, so a wrong value here silently
    // removes every publish action later.
    const outStat = await fs.stat(outputPath);
    if (!outStat.size) throw new Error("ffmpeg produced an empty output file");
    if (outStat.size > RENDER_MAX_OUTPUT_BYTES) {
      throw new Error(
        `Rendered output is ${(outStat.size / 1024 / 1024).toFixed(0)} MB, over the ${Math.round(
          RENDER_MAX_OUTPUT_BYTES / 1024 / 1024
        )} MB limit for a single upload`
      );
    }

    const outProbe = parseProbe(await probeMediaFile(outputPath));
    const outW = outProbe.width;
    const outH = outProbe.height;
    if (!outW || !outH) throw new Error("ffprobe found no video stream in the rendered output");
    const aspectRatio = reduceRatio(outW, outH);
    if (aspectRatio !== doc.canvas.ratio) {
      console.warn(
        `[render] ${editId}: output ${outW}x${outH} reduces to "${aspectRatio}", expected "${doc.canvas.ratio}"`
      );
    }
    const durationMs =
      outProbe.durationSeconds > 0 ? Math.round(outProbe.durationSeconds * 1000) : null;

    await setRenderState(editId, { render_progress: 90 });

    // ── Upload to Processed; the original stays untouched in Originals ──
    const driveSvc = await import("./src/server/services/drive/client");
    // A fresh client immediately before the upload. getAuthenticatedDrive
    // re-checks the expiry and writes a refreshed token back to
    // drive_connections, which uploadFile then reads — renders are long enough
    // that the token the download used has often expired by now, and that has
    // already bitten this project once.
    await driveSvc.getAuthenticatedDrive(brandId, orgId);

    const safeTitle =
      String(edit.title || "edit")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "edit";
    const fileName = `${safeTitle}-${doc.canvas.ratio.replace(":", "x")}-${Date.now()}.mp4`;

    // The only moment the whole file is in memory: uploadFile takes a Buffer.
    // Bounded by RENDER_MAX_OUTPUT_BYTES above.
    const outputBuffer = await fs.readFile(outputPath);
    const renderedDriveFileId = await driveSvc.uploadFile(
      brandId,
      orgId,
      outputBuffer,
      fileName,
      "video/mp4",
      "processed"
    );

    await setRenderState(editId, {
      render_status: "ready",
      render_progress: 100,
      render_error: null,
      rendered_drive_file_id: renderedDriveFileId,
      rendered_width: outW,
      rendered_height: outH,
      rendered_aspect_ratio: aspectRatio,
      rendered_duration_ms: durationMs,
      rendered_file_size: outStat.size,
      rendered_mime_type: "video/mp4",
    });

    console.log(
      `[render] ${editId} ready: ${outW}x${outH} ${aspectRatio} ${
        durationMs === null ? "unknown duration" : `${(durationMs / 1000).toFixed(2)}s`
      } ${(outStat.size / 1024 / 1024).toFixed(2)} MB in ${encodeSeconds.toFixed(
        1
      )}s -> ${renderedDriveFileId}`
    );

    return { editId, driveFileId: renderedDriveFileId, width: outW, height: outH, durationMs };
  } finally {
    // Always: success, a failed ffmpeg, a bad document, and the SIGKILL-on-
    // shutdown path all land here. The volume is small and one leaked source
    // per failed render fills it.
    await fs
      .rm(workDir, { recursive: true, force: true })
      .catch((e: any) =>
        console.warn(`[render] ${editId}: could not remove ${workDir}: ${e?.message}`)
      );
  }
}

/** A still + music is still a video; cap it so a 2-hour podcast cannot be one. */
const STILL_VIDEO_MAX_SECONDS = 600;

/**
 * Wrap an already-rendered still frame with a music track, producing an MP4.
 *
 * Deliberately a SECOND pass over the finished sharp output rather than an
 * ffmpeg render of its own: the frame keeps the exact crop, overlay compositing
 * and effect matrices the image path already produces, so a photo with music
 * looks pixel-identical to the same photo without it. Rebuilding the frame in
 * ffmpeg would reintroduce the preview/render divergence the browser-side
 * overlay rasterisation exists to prevent (ffmpeg `drawtext` has no word wrap,
 * and this image ships two fonts).
 *
 * The caller has already confirmed `doc.audio.trackId` is set.
 */
async function wrapStillAsVideo(params: {
  editId: string;
  edit: any;
  doc: any;
  still: Buffer;
  brandId: string;
  orgId: string;
}): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
} | null> {
  const { editId, edit, doc, still, brandId, orgId } = params;

  const track = await resolveAudioTrack(edit, doc.audio?.trackId ?? null);
  if (!track) return null;

  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");
  const { parseProbe } = await import("./src/lib/editor/ffmpeg-plan");

  const tmpRoot = process.env.RENDER_TMP_DIR || os.tmpdir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(tmpRoot, `still-${editId.slice(0, 8)}-`));

  try {
    const stillPath = path.join(workDir, "still.png");
    await fs.writeFile(stillPath, still);

    const musicPath = path.join(
      workDir,
      `music${tmpExtension(track.name, track.mime_type, ".m4a")}`
    );
    await downloadDriveFileToDisk(track.drive_file_id, brandId, orgId, musicPath);

    const musicProbe = parseProbe(await probeMediaFile(musicPath));
    const audio = doc.audio ?? {};
    const startOffset = Math.max(0, Number(audio.startOffset) || 0);
    const loop = audio.loop !== false;

    // Length comes from the track, minus any offset into it. A trim on the
    // document wins when present, and looping lets a trim run past the track.
    const trackSeconds = Number.isFinite(musicProbe.durationSeconds) ? musicProbe.durationSeconds : 0;
    const trim = doc.base?.trim;
    let seconds =
      trim && trim.end > trim.start ? trim.end - trim.start : Math.max(0, trackSeconds - startOffset);
    if (!loop && trackSeconds > 0) seconds = Math.min(seconds, Math.max(0, trackSeconds - startOffset));
    seconds = Math.min(Math.max(seconds, 0.1), STILL_VIDEO_MAX_SECONDS);

    // Audio chain. `volume` applies to the music (it is the only source here).
    const filters: string[] = [];
    const volume = Number(audio.volume);
    if (Number.isFinite(volume) && Math.abs(volume - 1) > 1e-3) {
      filters.push(`volume=${volume.toFixed(3)}`);
    }
    const fadeIn = Math.max(0, Number(audio.fadeIn) || 0);
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${Math.min(fadeIn, seconds).toFixed(3)}`);
    const fadeOut = Math.max(0, Number(audio.fadeOut) || 0);
    if (fadeOut > 0) {
      const d = Math.min(fadeOut, seconds);
      filters.push(`afade=t=out:st=${Math.max(0, seconds - d).toFixed(3)}:d=${d.toFixed(3)}`);
    }

    const outputPath = path.join(workDir, "out.mp4");
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-stats", "-y"];
    // Still input: one frame held for the whole duration.
    args.push("-loop", "1", "-framerate", "30", "-i", stillPath);
    // Music input. -stream_loop precedes its own -i; -ss seeks into the track.
    if (loop) args.push("-stream_loop", "-1");
    if (startOffset > 0) args.push("-ss", startOffset.toFixed(3));
    args.push("-i", musicPath);
    if (filters.length) args.push("-filter:a", filters.join(","));
    args.push(
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      // stillimage tunes rate control for a frame that never changes, which is
      // what keeps a 10-minute still from costing hundreds of megabytes.
      "-tune", "stillimage",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-t", seconds.toFixed(3),
      "-movflags", "+faststart",
      outputPath
    );

    await runFfmpeg(args, () => {});

    const outProbe = parseProbe(await probeMediaFile(outputPath));
    const stat = await fs.stat(outputPath);
    if (stat.size > RENDER_MAX_OUTPUT_BYTES) {
      throw new Error(
        `Rendered video is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${Math.round(
          RENDER_MAX_OUTPUT_BYTES / 1024 / 1024
        )} MB limit`
      );
    }

    return {
      buffer: await fs.readFile(outputPath),
      width: outProbe.width,
      height: outProbe.height,
      durationMs: Math.round((outProbe.durationSeconds || seconds) * 1000),
      mimeType: "video/mp4",
    };
  } finally {
    await fs
      .rm(workDir, { recursive: true, force: true })
      .catch((e: any) =>
        console.warn(`[render] ${editId}: could not remove ${workDir}: ${e?.message}`)
      );
  }
}

const renderWorker = new Worker(
  "render",
  async (job) => {
    const editId: string | undefined = job.data?.editId;
    if (!editId) throw new Error("render job has no editId");

    const { data: edit } = await db().from("media_edits").select("*").eq("id", editId).single();
    if (!edit) throw new Error(`media_edits ${editId} not found`);

    try {
      if (edit.kind === "video") return await renderVideoEdit(editId, edit);

      // Relative dynamic imports resolve the "@/*" tsconfig paths under tsx
      // (verified in this image), which is the escape hatch that lets this
      // otherwise self-contained worker reuse the app's Drive upload, its token
      // refresh and the shared render planner instead of duplicating them.
      const { editDocSchema, reduceRatio } = await import("./src/lib/editor/doc");
      const doc = editDocSchema.parse(edit.doc);

      // Both paths resolve their source through the same helper so they cannot
      // drift: an Editor-owned Drive original first, a pre-00042 library asset
      // second.
      const source = await resolveRenderSource(edit);
      const { brandId, orgId } = source;

      await setRenderState(editId, {
        render_status: "rendering",
        render_progress: 10,
        render_error: null,
      });

      // Only drive_file_id is set on purpose: downloadFromDrive prefers
      // processed_drive_file_id, and the editor must always start from the
      // ORIGINAL rather than from a previously processed derivative.
      const { buffer: sourceBuffer } = await downloadFromDrive(
        {
          drive_file_id: source.driveFileId,
          file_name: source.fileName,
          file_type: source.fileType,
        },
        orgId,
        brandId
      );

      await setRenderState(editId, { render_progress: 35 });

      const sharp = (await import("sharp")).default;

      // Source dimensions in the ORIENTED frame, computed explicitly: EXIF
      // orientations 5-8 transpose the image, and the document's crop is
      // normalised against what the browser showed.
      const probe = await sharp(sourceBuffer, { failOn: "none" }).metadata();
      const orientation = probe.orientation ?? 1;
      const transposed = orientation >= 5 && orientation <= 8;
      const srcW = (transposed ? probe.height : probe.width) ?? 0;
      const srcH = (transposed ? probe.width : probe.height) ?? 0;
      if (!srcW || !srcH) throw new Error("Could not read the source image dimensions");

      const background = doc.canvas.background.color || "#000000";
      const t = doc.base.transform as BaseTransform;
      const { planCoverGeometry } = await import("./src/lib/editor/sharp-plan");
      const geom = planCoverGeometry(doc.canvas.w, doc.canvas.h, doc.base.crop, t, srcW, srcH);

      const { colour, blurSigma } = buildEffectChain(doc.effects);

      // Pass 1 — geometry and effects on the base image only.
      //
      // Staged deliberately through raw intermediates rather than chained in
      // one sharp call: sharp applies operations in its own fixed internal
      // order, not call order, so a chained .flip()/.rotate()/.resize() would
      // NOT reproduce the CSS order `rotate(r) scale(sx,sy)` the preview uses.
      // Each stage is skipped when it is a no-op, so the common identity case
      // costs exactly what the previous single-extract version did.
      let staged = sharp(sourceBuffer, { failOn: "none" })
        .rotate() // EXIF orientation FIRST, always — see note (3) above.
        .extract(geom.extract);
      if (geom.extend) {
        staged = staged.extend({ ...geom.extend, background });
      }

      if (t.flipH || t.flipV) {
        const flipped = await staged.raw().toBuffer({ resolveWithObject: true });
        let s = sharp(flipped.data, {
          raw: {
            width: flipped.info.width,
            height: flipped.info.height,
            channels: flipped.info.channels as 1 | 2 | 3 | 4,
          },
        });
        if (t.flipH) s = s.flop(); // mirror horizontally (CSS scaleX(-1))
        if (t.flipV) s = s.flip(); // mirror vertically   (CSS scaleY(-1))
        staged = s;
      }

      if (t.rotate % 360 !== 0) {
        const pre = await staged.raw().toBuffer({ resolveWithObject: true });
        staged = sharp(pre.data, {
          raw: {
            width: pre.info.width,
            height: pre.info.height,
            channels: pre.info.channels as 1 | 2 | 3 | 4,
          },
        }).rotate(t.rotate, { background });
      }

      // `fill` not `cover`: planCoverGeometry already solved the framing, so the
      // staged patch has the canvas aspect and must not be re-cropped here.
      // t.scale is carried by that rect too, so it needs no separate step.
      let base = staged
        .resize(doc.canvas.w, doc.canvas.h, { fit: "fill" })
        // Kill any alpha from a transparent source so the canvas background
        // shows through rather than leaving an alpha channel in a JPEG.
        .flatten({ background })
        .toColourspace("srgb");

      if (!isIdentityMatrix(colour.m)) {
        // sharp types recomb as a fixed 3x3 tuple; the composed matrix is built
        // as number[][] but is always exactly 3x3.
        base = base.recomb(
          colour.m as [
            [number, number, number],
            [number, number, number],
            [number, number, number],
          ]
        );
      }
      if (colour.off.some((v) => Math.abs(v) > 1e-6)) {
        base = base.linear([1, 1, 1], colour.off);
      }
      if (blurSigma >= 0.3) base = base.blur(Math.min(blurSigma, 1000));

      const rendered = await base.raw().toBuffer({ resolveWithObject: true });

      await setRenderState(editId, { render_progress: 60 });

      // Pass 2 — composite the browser-rasterised overlay, un-filtered, then
      // encode.  The overlay may have been rasterised at devicePixelRatio, so it
      // is resized to the exact canvas before compositing.
      let out = sharp(rendered.data, {
        raw: {
          width: rendered.info.width,
          height: rendered.info.height,
          channels: rendered.info.channels as 1 | 2 | 3 | 4,
        },
      });

      const overlayFileId: string | null = doc.overlayDriveFileId || edit.overlay_drive_file_id || null;
      if (overlayFileId) {
        const { buffer: overlayRaw } = await downloadFromDrive(
          { drive_file_id: overlayFileId, file_name: "overlay.png", file_type: "image/png" },
          orgId,
          brandId
        );
        const overlayPng = await sharp(overlayRaw, { failOn: "none" })
          .resize(doc.canvas.w, doc.canvas.h, { fit: "fill" })
          .png()
          .toBuffer();
        out = out.composite([{ input: overlayPng, top: 0, left: 0 }]);
      }

      // A still that is about to be wrapped with music is encoded as PNG
      // whatever the source was: it becomes libx264's input, so a JPEG pass
      // would add generation loss for nothing.
      const wantsMusic = Boolean(doc.audio?.trackId);
      // PNG only for a PNG source (flat artwork, where JPEG ringing is visible);
      // JPEG for everything else, which is what the platform publishers prefer.
      const wantPng = wantsMusic || source.fileType === "image/png";
      let mimeType = wantPng ? "image/png" : "image/jpeg";
      const encoded = await (wantPng ? out.png() : out.jpeg({ quality: 90 })).toBuffer({
        resolveWithObject: true,
      });

      await setRenderState(editId, { render_progress: 80 });

      let payload: Buffer = encoded.data;
      let outW = encoded.info.width;
      let outH = encoded.info.height;
      let durationMs: number | null = null;
      let extension = wantPng ? "png" : "jpg";

      // Music on a photo makes the output a VIDEO — the user's explicit ask.
      // `edit.kind` stays 'image', so everything downstream must read
      // `rendered_mime_type` rather than `kind` to know what this file is.
      if (wantsMusic) {
        const wrapped = await wrapStillAsVideo({
          editId,
          edit,
          doc,
          still: encoded.data,
          brandId,
          orgId,
        });
        if (wrapped) {
          payload = wrapped.buffer;
          outW = wrapped.width;
          outH = wrapped.height;
          durationMs = wrapped.durationMs;
          mimeType = wrapped.mimeType;
          extension = "mp4";
        } else {
          // The track vanished or belongs to another brand. Ship the still
          // rather than failing the whole render.
          console.warn(`[render] ${editId}: audio track unavailable; rendering a still instead`);
        }
      }
      const aspectRatio = reduceRatio(outW, outH);
      if (aspectRatio !== doc.canvas.ratio) {
        // rules-engine.getValidActions matches aspect_ratio as an EXACT string,
        // so a mismatch here silently removes every publish action later.
        console.warn(
          `[render] ${editId}: output ${outW}x${outH} reduces to "${aspectRatio}", expected "${doc.canvas.ratio}"`
        );
      }

      const driveSvc = await import("./src/server/services/drive/client");
      const safeTitle =
        String(edit.title || "edit")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "edit";
      const fileName = `${safeTitle}-${doc.canvas.ratio.replace(":", "x")}-${Date.now()}.${extension}`;

      const renderedDriveFileId = await driveSvc.uploadFile(
        brandId,
        orgId,
        payload,
        fileName,
        mimeType,
        "processed"
      );

      await setRenderState(editId, {
        render_status: "ready",
        render_progress: 100,
        render_error: null,
        rendered_drive_file_id: renderedDriveFileId,
        rendered_width: outW,
        rendered_height: outH,
        rendered_aspect_ratio: aspectRatio,
        rendered_duration_ms: durationMs,
        rendered_file_size: payload.length,
        rendered_mime_type: mimeType,
      });

      console.log(
        `[render] ${editId} ready: ${outW}x${outH} ${aspectRatio} ${(
          encoded.data.length / 1024
        ).toFixed(0)} KB -> ${renderedDriveFileId}`
      );

      return { editId, driveFileId: renderedDriveFileId, width: outW, height: outH };
    } catch (err: any) {
      const message = String(err?.message ?? "Render failed").slice(0, 1000);
      await setRenderState(editId, { render_status: "failed", render_error: message }).catch(() => {});
      // Rethrow so BullMQ records the failure and applies its backoff.  A retry
      // sets render_status back to 'rendering' on its first write, so the row is
      // only left 'failed' once the attempts are exhausted.
      throw err;
    }
  },
  { connection: redis, concurrency: 1 }
);

renderWorker.on("failed", (job, err) => {
  console.error(`[render] job ${job?.id} (edit ${job?.data?.editId}) failed:`, err?.message);
});

// ─── Editor audio import: an Instagram reel's audio → the brand's track library ───
//
// This lives in the worker and not in a route handler or a tRPC mutation for one
// hard reason: ffmpeg and ffprobe are installed in the Dockerfile's `worker` and
// `dev` stages only. The production `app` stage has neither, so there is no
// in-request place to transcode. The tRPC mutation creates an `importing` row
// and enqueues its id; everything below fills that row in.

/**
 * Cap on the reel we are willing to pull down.
 *
 * Streamed to disk rather than buffered, so this protects the render volume and
 * a wedged/hostile response — not the heap. The heap is protected by never
 * holding the video in memory at all: an OOM in this process kills all 13
 * workers, including a publish job that has created an Instagram container but
 * not yet recorded platform_post_id, which then re-posts on retry.
 */
const AUDIO_IMPORT_MAX_INPUT_BYTES = 300 * 1024 * 1024;

/**
 * Cap on the extracted track. 50MB is what `/api/editor/asset` accepts for an
 * uploaded one (`EDITOR_ASSET_KINDS.audio.maxBytes`), and a track the library
 * would refuse by one door must not arrive through another. This one IS a heap
 * bound as well: `uploadFile` takes a Buffer, so the output is read whole.
 */
const AUDIO_IMPORT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Whole-download deadline. A reel is seconds of audio; minutes means stuck. */
const AUDIO_IMPORT_FETCH_TIMEOUT_MS = 180_000;

/** Deadline for the HEAD-like redirect hop on a `/share/<token>` link. */
const AUDIO_IMPORT_REDIRECT_TIMEOUT_MS = 20_000;

/** Browser UA, matching `/api/insta-media`: the CDN refuses unusual clients. */
const AUDIO_IMPORT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Every in-flight Instagram fetch, so a SIGTERM can abort it.
 *
 * The same reasoning as `activeRenderChildren`: `audioImportWorker.close()`
 * waits for the active job, and a download has up to
 * AUDIO_IMPORT_FETCH_TIMEOUT_MS to run, so without this shutdown would hang
 * until Docker SIGKILLs the process — and a SIGKILL skips the `finally` that
 * removes the work directory from the render volume. Aborting makes the job fail
 * fast, which lets that finally run.
 */
const activeAudioImportFetches = new Set<AbortController>();

function abortActiveAudioImports(): void {
  for (const controller of activeAudioImportFetches) {
    try {
      controller.abort();
    } catch {
      // Already settled.
    }
  }
}

/** Anything the user can read and act on; everything else keeps its own text. */
class AudioImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioImportError";
  }
}

async function setAudioImportState(trackId: string, patch: Record<string, unknown>): Promise<void> {
  await db()
    .from("audio_tracks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", trackId);
}

/**
 * The Instagram cookie to fetch with, or null for an anonymous attempt.
 *
 * Replicates `insta-fetcher.ts`'s lookup (this brand's org first, then any
 * active session, because the local studio shares one) rather than importing
 * it: `resolveAnyActiveSession` there is module-private, and this worker is
 * deliberately self-contained apart from relative dynamic imports.
 *
 * A missing or undecryptable session is NOT an error here — anonymous reads
 * still work for some public reels, and failing early would turn "Instagram
 * refused this" into "you have no session", which is a different claim.
 */
async function resolveInstagramCookie(
  orgId: string
): Promise<{ cookie: string; csrftoken: string; hadSession: boolean }> {
  const read = async (scoped: boolean) => {
    let query = db()
      .from("insta_sessions")
      .select("session_id_encrypted")
      .eq("status", "active");
    if (scoped) query = query.eq("org_id", orgId);
    const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    return data?.session_id_encrypted ?? null;
  };

  let raw: string | null = null;
  try {
    raw = (await read(true)) ?? (await read(false));
  } catch {
    raw = null;
  }
  if (!raw) return { cookie: "", csrftoken: "", hadSession: false };

  try {
    const { normalizeSession } = await import("./src/server/services/instagram/fetcher");
    const session = normalizeSession(decrypt(raw));
    return { cookie: session.cookie, csrftoken: session.csrftoken ?? "", hadSession: true };
  } catch {
    // A session that will not decrypt is the same situation as none at all.
    return { cookie: "", csrftoken: "", hadSession: false };
  }
}

/**
 * Follow a `/share/<token>` link to the reel it points at.
 *
 * The token is opaque — base64-decoding it the way a shortcode is decoded would
 * produce a real-looking but wrong media id, and the import would then quietly
 * fetch somebody else's post. The destination is re-validated through
 * `parseInstagramMediaUrl`, so the redirect cannot walk off instagram.com.
 */
async function resolveInstagramShareLink(shareUrl: string, cookie: string): Promise<string> {
  const { parseInstagramMediaUrl } = await import("./src/lib/editor/instagram-audio");
  const controller = new AbortController();
  activeAudioImportFetches.add(controller);
  const timer = setTimeout(() => controller.abort(), AUDIO_IMPORT_REDIRECT_TIMEOUT_MS);

  let finalUrl: string;
  try {
    const res = await fetch(shareUrl, {
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": AUDIO_IMPORT_UA, Accept: "*/*", ...(cookie ? { Cookie: cookie } : {}) },
    });
    finalUrl = res.url || shareUrl;
    // The body is HTML we have no use for; not draining it leaves the socket
    // held until GC.
    await res.body?.cancel().catch(() => {});
  } catch (err: any) {
    throw new AudioImportError(
      `Could not follow that Instagram share link: ${err?.name === "AbortError" ? "it timed out" : err?.message}`
    );
  } finally {
    clearTimeout(timer);
    activeAudioImportFetches.delete(controller);
  }

  const parsed = parseInstagramMediaUrl(finalUrl);
  if (!parsed.ok || parsed.value.needsRedirectResolve || !parsed.value.shortcode) {
    throw new AudioImportError(
      "That share link did not resolve to a reel or post. Open it in a browser and copy the reel link instead."
    );
  }
  return parsed.value.shortcode;
}

/**
 * Stream a URL to `destPath`, refusing to exceed `maxBytes`.
 *
 * A counting Transform rather than a Content-Length check: the header is
 * optional, and advisory even when present. Nothing is accumulated — the
 * transform passes each chunk straight through and only adds up its length.
 */
async function downloadUrlToDisk(
  url: string,
  destPath: string,
  maxBytes: number,
  cookie: string
): Promise<{ bytes: number; contentType: string | null }> {
  const fs = await import("fs");
  const { Readable, Transform } = await import("stream");
  const { pipeline } = await import("stream/promises");

  const controller = new AbortController();
  activeAudioImportFetches.add(controller);
  const timer = setTimeout(() => controller.abort(), AUDIO_IMPORT_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": AUDIO_IMPORT_UA,
        // The Instagram CDN rejects hotlinked media without this, exactly as
        // `/api/insta-media/route.ts` documents.
        Referer: "https://www.instagram.com/",
        Accept: "*/*",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    if (!res.ok || !res.body) {
      throw new AudioImportError(
        `Instagram's media server returned ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for that reel's video.`
      );
    }

    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AudioImportError(
        `That reel's video is ${(declared / 1024 / 1024).toFixed(0)}MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB import limit.`
      );
    }

    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc: unknown, cb: (e?: Error | null, c?: Buffer) => void) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          cb(
            new AudioImportError(
              `That reel's video is over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB import limit.`
            )
          );
          return;
        }
        cb(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(res.body as any),
      counter,
      fs.createWriteStream(destPath)
    );

    if (!bytes) throw new AudioImportError("Instagram returned an empty video for that reel.");
    return { bytes, contentType: res.headers.get("content-type") };
  } catch (err: any) {
    if (err instanceof AudioImportError) throw err;
    if (err?.name === "AbortError") {
      throw new AudioImportError("Downloading that reel's video from Instagram timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    activeAudioImportFetches.delete(controller);
  }
}

/** `{ hasAudio, durationMs }` out of a parsed ffprobe payload. */
function readAudioProbe(probe: unknown): { hasAudio: boolean; durationMs: number | null } {
  const p = probe as {
    streams?: Array<{ codec_type?: string; duration?: string | number }>;
    format?: { duration?: string | number };
  };
  const streams = Array.isArray(p?.streams) ? p.streams : [];
  const audio = streams.filter((s) => s?.codec_type === "audio");

  const seconds = Number(p?.format?.duration ?? audio[0]?.duration ?? NaN);
  return {
    hasAudio: audio.length > 0,
    // Unknown stays null rather than becoming a 0, which would silently
    // truncate every trim and fade the user later builds on this track.
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
  };
}

/**
 * Resolve an `importing` track's Instagram URL, extract its audio and complete
 * the row.
 *
 * Every exit path goes through the `finally` that removes the work directory.
 */
async function importAudioFromInstagram(trackId: string): Promise<{
  trackId: string;
  driveFileId: string;
  durationMs: number | null;
  bytes: number;
}> {
  const { data: track } = await db()
    .from("audio_tracks")
    .select("id, brand_id, name, source_url, import_status, drive_file_id")
    .eq("id", trackId)
    .maybeSingle();

  if (!track) {
    // The user deleted the row while the job was queued. Not a failure.
    throw new AudioImportError(`audio_tracks ${trackId} no longer exists`);
  }
  if (track.import_status !== "importing") {
    throw new AudioImportError(
      `audio_tracks ${trackId} is '${track.import_status}', not 'importing' — nothing to do`
    );
  }
  if (!track.source_url) throw new AudioImportError("This track has no Instagram link to import");

  const { data: brand } = await db()
    .from("brands")
    .select("id, org_id")
    .eq("id", track.brand_id)
    .maybeSingle();
  if (!brand?.org_id) throw new AudioImportError("Brand not found for this track");
  const brandId: string = track.brand_id;
  const orgId: string = brand.org_id;

  const { parseInstagramMediaUrl, isInstagramMediaHost, instagramTrackName } = await import(
    "./src/lib/editor/instagram-audio"
  );

  // Re-validated here and not taken on trust: the row has been through the
  // database since the mutation checked it, and this worker holds the service
  // role.
  const parsed = parseInstagramMediaUrl(track.source_url);
  if (!parsed.ok) throw new AudioImportError(parsed.reason);

  const { cookie, csrftoken, hadSession } = await resolveInstagramCookie(orgId);

  const shortcode = parsed.value.needsRedirectResolve
    ? await resolveInstagramShareLink(parsed.value.canonicalUrl, cookie)
    : parsed.value.shortcode!;

  // The existing service layer, reused rather than reimplemented: two tiers
  // (the private media-info endpoint, then the GraphQL web fallback), plain
  // fetch, no Chromium.
  const { fetchInstagramVideoDetails } = await import(
    "./src/server/services/instagram/fetcher"
  );
  const details = await fetchInstagramVideoDetails(shortcode, cookie, csrftoken);

  if (!details.ok || !details.videoUrl) {
    const reason = details.error || "Instagram did not return a video for that link.";
    throw new AudioImportError(
      hadSession
        ? reason
        : `${reason} No active Instagram session is saved, so this was an anonymous request.`
    );
  }

  // The media URL comes back from Instagram, so it is data. Pinning it to the
  // Instagram/Facebook CDNs is what keeps a surprising API response from
  // turning this job into a fetcher for an arbitrary host.
  let mediaHost: string;
  try {
    const mediaUrl = new URL(details.videoUrl);
    mediaHost = mediaUrl.hostname;
    if (mediaUrl.protocol !== "https:" || !isInstagramMediaHost(mediaHost)) {
      throw new AudioImportError(
        `Instagram returned a video URL on an unexpected host (${mediaHost}); refusing to download it.`
      );
    }
  } catch (err: any) {
    if (err instanceof AudioImportError) throw err;
    throw new AudioImportError("Instagram returned a video URL that could not be parsed.");
  }

  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  // Same work-directory pattern as a render: one mkdtemp per job on the
  // render-tmp volume (a real volume, not tmpfs — tmpfs would spend the
  // container's memory limit on scratch files), and the whole directory is what
  // the finally removes.
  const tmpRoot = process.env.RENDER_TMP_DIR || os.tmpdir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(tmpRoot, `audio-${trackId.slice(0, 8)}-`));

  let uploadedDriveFileId: string | null = null;

  try {
    const videoPath = path.join(workDir, "reel.mp4");
    console.log(`[audio-import] ${trackId}: downloading ${shortcode} from ${mediaHost}`);
    const { bytes: inputBytes } = await downloadUrlToDisk(
      details.videoUrl,
      videoPath,
      AUDIO_IMPORT_MAX_INPUT_BYTES,
      cookie
    );

    const inputProbe = readAudioProbe(await probeMediaFile(videoPath));
    if (!inputProbe.hasAudio) {
      // Explicitly not "extract anyway": ffmpeg with -vn and no audio stream
      // produces a valid, silent, useless file, and the user would only find
      // out after putting it under a video.
      throw new AudioImportError("That reel has no audio track.");
    }

    const audioPath = path.join(workDir, "audio.m4a");
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        videoPath,
        // Drop the video, re-encode to AAC in MP4. Not `-c:a copy`: the source
        // is often AAC already but may be Opus in WebM, and the track has to be
        // something both the browser's <audio> preview and the render's music
        // bed can read.
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        // Moves the moov atom to the front so the panel's preview can start
        // playing before the whole file has arrived from Drive.
        "-movflags",
        "+faststart",
        audioPath,
      ],
      () => {}
    );

    const outStat = await fs.stat(audioPath);
    if (!outStat.size) throw new AudioImportError("Extracting the audio produced an empty file.");
    if (outStat.size > AUDIO_IMPORT_MAX_OUTPUT_BYTES) {
      throw new AudioImportError(
        `The extracted audio is ${(outStat.size / 1024 / 1024).toFixed(0)}MB, over the ${(
          AUDIO_IMPORT_MAX_OUTPUT_BYTES / 1024 / 1024
        ).toFixed(0)}MB limit for a track.`
      );
    }

    // Probed from the OUTPUT, not from `details.duration` (which Instagram
    // rounds to whole seconds) and not from the input: this is the file the
    // editor will trim and fade, so its length has to be its own.
    const outputProbe = readAudioProbe(await probeMediaFile(audioPath));
    if (!outputProbe.hasAudio) {
      throw new AudioImportError("The extracted file has no audio stream.");
    }

    const driveSvc = await import("./src/server/services/drive/client");
    const safeShortcode = shortcode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "reel";
    const fileName = `instagram-${safeShortcode}-${Date.now()}.m4a`;

    // Bounded by AUDIO_IMPORT_MAX_OUTPUT_BYTES above; `uploadFile` takes a
    // Buffer, so this one read is unavoidable.
    const payload = await fs.readFile(audioPath);
    uploadedDriveFileId = await driveSvc.uploadFile(
      brandId,
      orgId,
      payload,
      fileName,
      "audio/mp4",
      "processed"
    );

    const { data: completed } = await db()
      .from("audio_tracks")
      .update({
        name: instagramTrackName(shortcode, details.ownerUsername),
        drive_file_id: uploadedDriveFileId,
        mime_type: "audio/mp4",
        duration_ms: outputProbe.durationMs,
        file_size: payload.length,
        import_status: "ready",
        import_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trackId)
      .eq("brand_id", brandId)
      .select("id")
      .maybeSingle();

    if (!completed) {
      // The row went away mid-import. The file just uploaded is litter in the
      // user's Drive that nobody has ever seen, so the finally removes that ONE
      // file — the same orphan cleanup `/api/editor/asset/route.ts` does for its
      // own just-created upload.
      throw new AudioImportError("This track was removed while its audio was being imported.");
    }

    const driveFileId = uploadedDriveFileId;
    uploadedDriveFileId = null; // committed; the finally must not remove it

    console.log(
      `[audio-import] ${trackId} ready: ${shortcode} ${(inputBytes / 1024 / 1024).toFixed(
        1
      )}MB video -> ${(payload.length / 1024).toFixed(0)} KB audio, ${
        outputProbe.durationMs ?? "unknown"
      } ms -> ${fileName} (${driveFileId})`
    );

    return {
      trackId,
      driveFileId,
      durationMs: outputProbe.durationMs,
      bytes: payload.length,
    };
  } finally {
    if (uploadedDriveFileId) {
      const orphan = uploadedDriveFileId;
      const driveSvc = await import("./src/server/services/drive/client");
      await driveSvc
        .deleteFile(orphan, brandId, orgId)
        .catch((e: any) =>
          console.warn(`[audio-import] ${trackId}: could not remove orphan ${orphan}: ${e?.message}`)
        );
    }
    await fs
      .rm(workDir, { recursive: true, force: true })
      .catch((e: any) =>
        console.warn(`[audio-import] ${trackId}: could not remove ${workDir}: ${e?.message}`)
      );
  }
}

const audioImportWorker = new Worker(
  "audio-import",
  async (job) => {
    const trackId: string | undefined = job.data?.trackId;
    if (!trackId) throw new Error("audio-import job has no trackId");

    try {
      return await importAudioFromInstagram(trackId);
    } catch (err: any) {
      // The user's only window into this is `import_error`, so the message has
      // to survive. An AudioImportError is already written for them; anything
      // else is a surprise and is reported as itself rather than as a
      // reassuring summary.
      const message = String(err?.message ?? "Importing the audio failed").slice(0, 1000);
      await setAudioImportState(trackId, {
        import_status: "failed",
        import_error: message,
      }).catch(() => {});
      throw err;
    }
  },
  // Two at a time: each one is mostly waiting on Instagram, but they share a
  // single platform session and the render volume, and Instagram rate-limits
  // aggressively.
  { connection: redis, concurrency: 2 }
);

audioImportWorker.on("failed", (job, err) => {
  console.error(
    `[audio-import] job ${job?.id} (track ${job?.data?.trackId}) failed:`,
    err?.message
  );
});

console.log("Worker starting...");
verifyStartup().then(() => {
  console.log("Worker ready. Listening for jobs...");
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  // ffmpeg first: renderWorker.close() waits for the active job, so a render in
  // progress would hold shutdown open until Docker SIGKILLs the process — and a
  // SIGKILL skips renderVideoEdit's finally, leaking the whole temp directory on
  // the render volume.  Killing the child makes the job fail fast, which lets
  // that finally run.
  killActiveRenderChildren();
  // Same reason, different mechanism: an audio import can be parked on a fetch
  // from Instagram rather than on a child process.
  abortActiveAudioImports();
  await publishWorker.close();
  await analyticsWorker.close();
  await historicalWorker.close();
  await tokenWorker.close();
  await categorizeWorker.close();
  await trendForecastWorker.close();
  await sentimentWorker.close();
  await competitorFetchWorker.close();
  await commentSyncWorker.close();
  await commentReplyWorker.close();
  await instaCommentWorker.close();
  await renderWorker.close();
  await audioImportWorker.close();
  await redis.quit();
  process.exit(0);
});
