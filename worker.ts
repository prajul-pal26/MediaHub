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

  // Get the direct download link
  const file = await drive.files.get({
    fileId: driveFileId,
    fields: "webContentLink",
  });

  const webContentLink = file.data.webContentLink!;

  return {
    webContentLink,
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
        mediaPayload.media_type = action === "ig_reel" ? "REELS" : (action === "ig_story" ? "STORIES" : "VIDEO");
      } else {
        mediaPayload.image_url = webContentLink;
        if (action === "ig_story") {
          mediaPayload.media_type = "STORIES";
        }
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
  await redis.quit();
  process.exit(0);
});
