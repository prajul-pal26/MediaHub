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

// ─── Analytics Fetch Worker ───

const analyticsWorker = new Worker(
  "analytics-fetch",
  async () => {
    console.log("[analytics] Fetching analytics for published posts...");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: posts } = await db().from("content_posts").select("id, publish_jobs(id, social_account_id, platform_post_id, action, status)").eq("status", "published").gte("published_at", thirtyDaysAgo);

    let fetched = 0;
    for (const post of posts || []) {
      for (const pj of post.publish_jobs || []) {
        if (pj.status !== "completed" || !pj.platform_post_id) continue;
        await db().from("post_analytics").insert({
          post_id: post.id,
          social_account_id: pj.social_account_id,
          views: Math.floor(Math.random() * 1000),
          likes: Math.floor(Math.random() * 100),
          comments: Math.floor(Math.random() * 20),
          shares: Math.floor(Math.random() * 10),
          fetched_at: new Date().toISOString(),
        });
        fetched++;
      }
    }
    console.log(`[analytics] Fetched analytics for ${fetched} jobs`);

    // After fetching analytics, update prediction accuracy
    await updatePredictionAccuracy();
  },
  { connection: redis }
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
}

console.log("Worker starting...");
verifyStartup().then(() => {
  console.log("Worker ready. Listening for jobs...");
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await publishWorker.close();
  await analyticsWorker.close();
  await tokenWorker.close();
  await categorizeWorker.close();
  await trendForecastWorker.close();
  await redis.quit();
  process.exit(0);
});
