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
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
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

async function createTempPublicUrl(driveFileId: string, oauth2: any): Promise<{ webContentLink: string; cleanup: () => Promise<void> }> {
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // Make file publicly readable temporarily
  await drive.permissions.create({
    fileId: driveFileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  // Use direct Google content URL (works without redirects for Instagram)
  const directUrl = `https://lh3.googleusercontent.com/d/${driveFileId}`;

  return {
    webContentLink: directUrl,
    cleanup: async () => {
      // Remove public access
      const perms = await drive.permissions.list({ fileId: driveFileId });
      const anyonePerm = perms.data.permissions?.find((p: any) => p.type === "anyone");
      if (anyonePerm?.id) {
        await drive.permissions.delete({ fileId: driveFileId, permissionId: anyonePerm.id });
      }
    },
  };
}

async function waitForIgContainer(containerId: string, accessToken: string, maxWaitMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    const data = await res.json();
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") throw new Error(`Instagram media processing failed: ${JSON.stringify(data)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Instagram media processing timed out");
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
  const encryptedPageToken = account.platform_metadata?.page_access_token_encrypted;
  if (!encryptedPageToken) throw new Error("Instagram account missing page access token — reconnect the account");
  const pageAccessToken = decrypt(encryptedPageToken);
  const caption = platformMeta?.caption || "";

  const driveOAuth = await getDriveClient(orgId, brandId);
  const driveFileId = asset.processed_drive_file_id || asset.drive_file_id;
  const isVideo = (asset.file_type || "").startsWith("video/");

  // Create temporary public URL on Google Drive for Instagram to fetch
  const { webContentLink, cleanup } = await createTempPublicUrl(driveFileId, driveOAuth);

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
        const { webContentLink: itemUrl, cleanup: itemCleanup } = await createTempPublicUrl(carouselDriveFileId, driveOAuth);
        const isItemVideo = (carouselAsset.file_type || "").startsWith("video/");

        const containerRes = await fetchWithTimeout(
          `https://graph.facebook.com/v19.0/${igUserId}/media`,
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
        if (containerData.error) throw new Error(`Instagram carousel item error: ${containerData.error.message}`);
        childContainerIds.push(containerData.id);

        // For videos, wait until ready
        if (isItemVideo) {
          await waitForIgContainer(containerData.id, pageAccessToken);
        }
        await itemCleanup();
      }

      // Create carousel container
      const carouselRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: "CAROUSEL",
            children: childContainerIds.join(","),
            caption,
            access_token: pageAccessToken,
          }),
        }
      );
      const carouselData = await carouselRes.json();
      if (carouselData.error) throw new Error(`Instagram carousel error: ${carouselData.error.message}`);

      // Publish carousel
      const publishRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${igUserId}/media_publish`,
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
      if (publishData.error) throw new Error(`Instagram publish error: ${publishData.error.message}`);

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

      // Create container
      const containerRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mediaPayload),
        }
      );
      const containerData = await containerRes.json();
      if (containerData.error) throw new Error(`Instagram container error: ${containerData.error.message}`);

      // For videos, wait for processing
      if (isVideo) {
        await waitForIgContainer(containerData.id, pageAccessToken);
      }

      // Publish
      const publishRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${igUserId}/media_publish`,
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
      if (publishData.error) throw new Error(`Instagram publish error: ${publishData.error.message}`);

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

// ─── Publish Worker ───

const publishQueue = new Queue("publish", { connection: redis });

const publishWorker = new Worker(
  "publish",
  async (job) => {
    const { publishJobId, assetId, socialAccountId, action, resizeOption, groupId, platformMeta } = job.data;

    console.log(`[publish] Processing job ${publishJobId}: ${action}`);

    await db().from("publish_jobs").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", publishJobId);

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
      else {
        throw new Error(`Unknown action: ${action}`);
      }

      // Mark as completed
      await db().from("publish_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_post_id: platformPostId,
      }).eq("id", publishJobId);

      // Check if all sibling jobs for this post are done
      const { data: postJobs } = await db().from("publish_jobs").select("id, post_id").eq("id", publishJobId).single();
      if (postJobs) {
        const { data: allJobs } = await db().from("publish_jobs").select("status").eq("post_id", postJobs.post_id);
        const statuses = (allJobs || []).map((j: any) => j.status);
        const allCompleted = statuses.every((s: string) => s === "completed");
        const hasActiveJobs = statuses.some((s: string) => s === "processing" || s === "queued");
        const hasFailures = statuses.some((s: string) => s === "failed" || s === "dead");

        if (allCompleted) {
          await db().from("content_posts").update({ status: "published", published_at: new Date().toISOString() }).eq("id", postJobs.post_id);
          await db().from("media_groups").update({ status: "published" }).eq("id", groupId);
        } else if (hasFailures && !hasActiveJobs) {
          // Some jobs failed/dead but none are still running — partial publish
          await db().from("content_posts").update({ status: "partial_published" }).eq("id", postJobs.post_id);
        }
        // Otherwise, jobs are still in flight — leave post status as "publishing"
      }

      console.log(`[publish] Job ${publishJobId} completed: ${platformPostId}`);
    } catch (error: any) {
      console.error(`[publish] Job ${publishJobId} failed:`, error.message);

      await db().from("publish_jobs").update({
        status: job.attemptsMade + 1 >= 3 ? "dead" : "failed",
        error_message: error.message,
        attempt_count: job.attemptsMade + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", publishJobId);

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 3,
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
    await db().from("publish_jobs").update({ status: "dead", updated_at: new Date().toISOString() }).eq("id", publishJobId);

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
  try {
    const youtubeAnalytics = google.youtubeAnalytics({ version: "v2", auth: oauth2 });
    const analyticsRes = await youtubeAnalytics.reports.query({
      ids: "channel==MINE",
      startDate: "2020-01-01",
      endDate: new Date().toISOString().split("T")[0],
      metrics: "estimatedMinutesWatched,averageViewDuration",
      filters: `video==${platformPostId}`,
    });
    const row = analyticsRes.data.rows?.[0];
    if (row) {
      watchTimeMinutes = row[0] as number || 0;
      avgViewDuration = row[1] as number || 0;
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

  return {
    views,
    likes: parseInt(stats.likeCount || "0"),
    comments: parseInt(stats.commentCount || "0"),
    shares: 0,
    impressions: views,
    watch_time_seconds: Math.round(watchTimeMinutes * 60),
    avg_view_duration_seconds: Math.round(avgViewDuration),
    retention_rate: retentionRate,
  };
}

async function fetchInstagramAnalytics(account: any, platformPostId: string) {
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) return null;

  // Get post insights (include video_views and plays for retention)
  const insightsRes = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${platformPostId}/insights?metric=impressions,reach,engagement,saved,video_views,plays&access_token=${pageToken}`
  );
  const insightsData = await insightsRes.json();

  // Also get basic metrics + media type
  const mediaRes = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${platformPostId}?fields=like_count,comments_count,timestamp,media_type&access_token=${pageToken}`
  );
  const mediaData = await mediaRes.json();

  const insights = insightsData.data || [];
  const getMetric = (name: string) => insights.find((i: any) => i.name === name)?.values?.[0]?.value || 0;

  const impressions = getMetric("impressions");
  const videoViews = getMetric("video_views") || getMetric("plays");
  const isVideo = mediaData.media_type === "VIDEO" || mediaData.media_type === "REELS";

  // For video content: retention = video_views / impressions (what % of people who saw it actually watched)
  const retentionRate = isVideo && impressions > 0
    ? Math.round((videoViews / impressions) * 10000) / 100
    : 0;

  return {
    views: isVideo ? videoViews || impressions : impressions,
    likes: mediaData.like_count || 0,
    comments: mediaData.comments_count || 0,
    shares: 0,
    saves: getMetric("saved"),
    reach: getMetric("reach"),
    impressions,
    retention_rate: retentionRate,
    engagement_rate: getMetric("engagement"),
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
  };
}

// ─── Analytics Fetch Worker ───

const analyticsWorker = new Worker(
  "analytics-fetch",
  async () => {
    console.log("[analytics] Fetching real analytics for published posts...");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: posts } = await db().from("content_posts")
      .select("id, brand_id, publish_jobs(id, social_account_id, platform_post_id, action, status)")
      .eq("status", "published")
      .gte("published_at", thirtyDaysAgo);

    let fetched = 0;
    let errors = 0;

    for (const post of posts || []) {
      for (const pj of post.publish_jobs || []) {
        if (pj.status !== "completed" || !pj.platform_post_id) continue;

        try {
          // Get the social account
          const { data: account } = await db().from("social_accounts")
            .select("*").eq("id", pj.social_account_id).single();
          if (!account) continue;

          // Get brand's org_id
          const { data: brand } = await db().from("brands")
            .select("org_id").eq("id", post.brand_id).single();
          if (!brand) continue;

          let analytics: Record<string, number> | null = null;

          if (pj.action.startsWith("yt_")) {
            analytics = await fetchYouTubeAnalytics(account, pj.platform_post_id, brand.org_id);
          } else if (pj.action.startsWith("ig_")) {
            analytics = await fetchInstagramAnalytics(account, pj.platform_post_id);
          } else if (pj.action.startsWith("li_")) {
            analytics = await fetchLinkedInAnalytics(account, pj.platform_post_id);
          }

          if (analytics) {
            // Upsert analytics (update if exists, insert if not)
            const { data: existing } = await db().from("post_analytics")
              .select("id")
              .eq("post_id", post.id)
              .eq("social_account_id", pj.social_account_id)
              .maybeSingle();

            if (existing) {
              await db().from("post_analytics").update({
                ...analytics,
                fetched_at: new Date().toISOString(),
              }).eq("id", existing.id);
            } else {
              await db().from("post_analytics").insert({
                post_id: post.id,
                social_account_id: pj.social_account_id,
                ...analytics,
                fetched_at: new Date().toISOString(),
              });
            }
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

// ─── Historical Import Helpers ───

async function importInstagramHistory(account: any, brandId: string, _orgId: string): Promise<number> {
  const igUserId = account.platform_user_id;
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) throw new Error("No page access token");

  console.log(`[historical] Importing Instagram history for @${account.platform_username}...`);

  let url: string | null = `https://graph.facebook.com/v19.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink&limit=50&access_token=${pageToken}`;
  let totalImported = 0;

  while (url && totalImported < 500) {
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
        }).select().single();

        if (!contentPost) continue;

        // Create publish job record (no media_asset needed)
        await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: post.media_type === "VIDEO" ? "ig_reel" : "ig_post",
          status: "completed",
          platform_post_id: post.id,
          completed_at: post.timestamp,
        });

        // Fetch insights for this post
        let insights: Record<string, number> = {};
        try {
          const insightsRes = await fetchWithTimeout(
            `https://graph.facebook.com/v19.0/${post.id}/insights?metric=impressions,reach,engagement,saved&access_token=${pageToken}`,
            {}, 10000
          );
          const insightsData = await insightsRes.json();
          const metrics = insightsData.data || [];
          const getMetric = (name: string) => metrics.find((i: any) => i.name === name)?.values?.[0]?.value || 0;
          insights = {
            reach: getMetric("reach"),
            impressions: getMetric("impressions"),
            engagement_rate: getMetric("engagement"),
            saves: getMetric("saved"),
          };
        } catch {
          // Insights may not be available for old posts
        }

        // Save analytics
        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          views: insights.impressions || 0,
          likes: post.like_count || 0,
          comments: post.comments_count || 0,
          shares: 0,
          saves: insights.saves || 0,
          reach: insights.reach || 0,
          impressions: insights.impressions || 0,
          engagement_rate: insights.engagement_rate || 0,
          platform_specific: { permalink: post.permalink, media_type: post.media_type },
          fetched_at: new Date().toISOString(),
        });

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

  let pageToken: string | undefined;
  let totalImported = 0;

  do {
    const searchRes = await youtube.search.list({
      channelId: account.platform_user_id,
      type: ["video"],
      part: ["snippet"],
      maxResults: 50,
      pageToken,
      order: "date",
    });

    const videoIds = (searchRes.data.items || [])
      .map((item) => item.id?.videoId)
      .filter((id): id is string => Boolean(id));

    if (videoIds.length === 0) break;

    // Get statistics for all videos in batch
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
        }).select().single();

        if (!contentPost) continue;

        // Determine if short
        const duration = video.contentDetails?.duration || "";
        const secondsMatch = duration.match(/PT(?:(\d+)M)?(\d+)S/);
        const totalSeconds = secondsMatch
          ? (parseInt(secondsMatch[1] || "0") * 60) + parseInt(secondsMatch[2] || "0")
          : 999;
        const isShort = totalSeconds <= 60 && !duration.includes("H");

        // Create publish job (no media_asset needed)
        await db().from("publish_jobs").insert({
          post_id: contentPost.id,
          asset_id: null,
          social_account_id: account.id,
          action: isShort ? "yt_short" : "yt_video",
          status: "completed",
          platform_post_id: video.id,
          completed_at: snippet.publishedAt,
        });

        // Save analytics
        await db().from("post_analytics").insert({
          post_id: contentPost.id,
          social_account_id: account.id,
          views: parseInt(stats.viewCount || "0"),
          likes: parseInt(stats.likeCount || "0"),
          comments: parseInt(stats.commentCount || "0"),
          shares: 0,
          platform_specific: { video_id: video.id, duration: video.contentDetails?.duration },
          fetched_at: new Date().toISOString(),
        });

        totalImported++;
      } catch (e: any) {
        console.error(`[historical] Error importing YT video ${video.id}:`, e.message);
      }
    }

    pageToken = searchRes.data.nextPageToken || undefined;

    // Rate limiting
    if (totalImported % 50 === 0 && totalImported > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } while (pageToken && totalImported < 500);

  console.log(`[historical] YouTube import complete: ${totalImported} videos`);
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
      // LinkedIn historical import is limited — API doesn't support fetching past shares easily
      console.log("[historical] LinkedIn historical import not available (API limitation)");
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
      .select("id, platform, platform_username, access_token_encrypted, refresh_token_encrypted, platform_metadata")
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
        updated_at: new Date().toISOString(),
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

        // Resolve LLM config
        let apiKey = "";
        let baseUrl = "https://openrouter.ai/api/v1";
        let model = "deepseek/deepseek-chat-v3";
        let headers: Record<string, string> = {};

        const { data: orgConfig } = await db().from("llm_configurations")
          .select("*")
          .eq("org_id", brand.org_id)
          .eq("scope", "org")
          .eq("is_active", true)
          .limit(1)
          .single();

        if (orgConfig?.api_key_encrypted) {
          apiKey = decrypt(orgConfig.api_key_encrypted);
          headers = { "Authorization": `Bearer ${apiKey}` };
          if (orgConfig.base_url) baseUrl = orgConfig.base_url;
        } else {
          const { data: cred } = await db().from("platform_credentials")
            .select("client_id_encrypted")
            .eq("org_id", brand.org_id)
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

        const systemPrompt = `You are a social media trend forecasting AI. Analyze the brand's content history and performance data to generate a trend forecast. Return a JSON object with:
- trending_categories (array of objects: { category: string, score: number 0-100, trend: "rising"|"stable"|"declining" })
- trending_topics (array of objects: { topic: string, score: number 0-100 })
- trending_formats (array of objects: { format: string, recommendation: string })
- content_recommendations (array of strings, 5-7 actionable content ideas)
- content_gaps (array of strings, 3-5 content opportunities the brand is missing)
- weekly_plan (array of objects: { day: string, content_type: string, topic: string, platform: string, best_time: string })

Respond ONLY with valid JSON, no markdown.`;

        const userMessage = `Brand: "${brand.name}"
Content categories (last 90 days): ${JSON.stringify(catCounts)}
Top topics: ${JSON.stringify(Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 20))}
Total posts: ${(posts || []).length}
Average views: ${analytics.length > 0 ? Math.round(analytics.reduce((s, a) => s + (a.views || 0), 0) / analytics.length) : 0}
Average engagement: ${analytics.length > 0 ? Math.round(analytics.reduce((s, a) => s + (a.engagement_rate || 0), 0) / analytics.length * 100) / 100 : 0}%`;

        const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          console.error(`[trend-forecast] LLM error for brand ${brand.name}:`, (err as any).error?.message || response.statusText);
          continue;
        }

        const llmResult = await response.json() as any;
        const content = llmResult.choices?.[0]?.message?.content || "{}";
        let parsed: any;
        try {
          parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
        } catch {
          console.error(`[trend-forecast] Failed to parse LLM response for brand ${brand.name}`);
          continue;
        }

        // Determine platforms from publish history
        const platforms = ["instagram", "youtube", "linkedin"];
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

async function syncInstagramComments(account: any, brandId: string) {
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) return 0;

  const igUserId = account.platform_user_id;
  let synced = 0;

  // Get recent media to fetch comments from
  const mediaRes = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${igUserId}/media?fields=id,caption,timestamp&limit=25&access_token=${pageToken}`
  );
  const mediaData = await mediaRes.json();
  if (mediaData.error) {
    console.error(`[comment-sync] IG media list error: ${mediaData.error.message}`);
    return 0;
  }

  for (const media of mediaData.data || []) {
    try {
      // Fetch comments for this media
      const commentsRes = await fetchWithTimeout(
        `https://graph.facebook.com/v19.0/${media.id}/comments?fields=id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}&limit=50&access_token=${pageToken}`
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
        // Upsert comment
        const { error: upsertErr } = await db().from("platform_comments")
          .upsert({
            brand_id: brandId,
            post_id: publishJob?.post_id || null,
            publish_job_id: publishJob?.id || null,
            social_account_id: account.id,
            platform: "instagram",
            platform_comment_id: comment.id,
            platform_post_id: media.id,
            author_username: comment.username || "unknown",
            author_profile_url: null,
            author_avatar_url: null,
            comment_text: comment.text,
            comment_timestamp: comment.timestamp,
            like_count: comment.like_count || 0,
            reply_count: comment.replies?.data?.length || 0,
            synced_at: new Date().toISOString(),
          }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

        if (!upsertErr) synced++;

        // Also sync nested replies as separate comments
        for (const reply of comment.replies?.data || []) {
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
              author_username: reply.username || "unknown",
              comment_text: reply.text,
              comment_timestamp: reply.timestamp,
              like_count: reply.like_count || 0,
              synced_at: new Date().toISOString(),
            }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

          if (!replyErr) synced++;
        }
      }

      // Rate limit
      if (synced % 20 === 0) await new Promise(r => setTimeout(r, 1000));
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
      let pageToken: string | undefined;
      do {
        const commentsRes = await youtube.commentThreads.list({
          videoId,
          part: ["snippet", "replies"],
          maxResults: 100,
          pageToken,
          order: "time",
        });

        // Find linked content_post
        const { data: publishJob } = await db().from("publish_jobs")
          .select("id, post_id")
          .eq("platform_post_id", videoId)
          .eq("social_account_id", account.id)
          .limit(1)
          .maybeSingle();

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
                synced_at: new Date().toISOString(),
              }, { onConflict: "platform,platform_comment_id", ignoreDuplicates: false });

            if (!replyErr) synced++;
          }
        }

        pageToken = commentsRes.data.nextPageToken || undefined;
      } while (pageToken && synced < 500);
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
        const actorUrn = comment.actor || "";
        const authorName = comment.created?.actor || actorUrn.split(":").pop() || "LinkedIn User";

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
            comment_text: comment.message?.text || comment.comment || "",
            comment_timestamp: comment.created?.time
              ? new Date(comment.created.time).toISOString()
              : new Date().toISOString(),
            like_count: comment.likeCount || 0,
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
  const pageToken = account.platform_metadata?.page_access_token_encrypted
    ? decrypt(account.platform_metadata.page_access_token_encrypted)
    : null;
  if (!pageToken) throw new Error("No Instagram page access token");

  const res = await fetchWithTimeout(
    `https://graph.facebook.com/v19.0/${comment.platform_comment_id}/replies`,
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

  // Schedule cron jobs
  const analyticsQueue = new Queue("analytics-fetch", { connection: redis });
  const tokenQueue = new Queue("token-refresh", { connection: redis });

  await analyticsQueue.add("fetch-all", {}, { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: "analytics-cron" });
  console.log("  ✓ Analytics cron (every 6 hours)");

  await tokenQueue.add("refresh-all", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "token-refresh-cron" });
  console.log("  ✓ Token refresh cron (daily)");

  const trendQueue = new Queue("trend-forecast", { connection: redis });
  await trendQueue.add("forecast-all", {}, { repeat: { every: 7 * 24 * 60 * 60 * 1000 }, jobId: "trend-forecast-cron" });
  console.log("  ✓ Trend forecast cron (weekly)");

  // Comment sync — every 2 hours
  const commentSyncQueue = new Queue("comment-sync", { connection: redis });
  await commentSyncQueue.add("sync-all", {}, { repeat: { every: 2 * 60 * 60 * 1000 }, jobId: "comment-sync-cron" });
  console.log("  ✓ Comment sync cron (every 2 hours)");

  // Comment reply processing — every 30 seconds
  const commentReplyQueue = new Queue("comment-reply", { connection: redis });
  await commentReplyQueue.add("process-pending", {}, { repeat: { every: 30 * 1000 }, jobId: "comment-reply-cron" });
  console.log("  ✓ Comment reply processing (every 30s)");
}

console.log("Worker starting...");
verifyStartup().then(() => {
  console.log("Worker ready. Listening for jobs...");
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await publishWorker.close();
  await analyticsWorker.close();
  await historicalWorker.close();
  await tokenWorker.close();
  await categorizeWorker.close();
  await trendForecastWorker.close();
  await commentSyncWorker.close();
  await commentReplyWorker.close();
  await redis.quit();
  process.exit(0);
});
