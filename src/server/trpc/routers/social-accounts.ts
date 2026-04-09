import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { encrypt, decrypt } from "@/lib/encryption";
import { createHmac, randomBytes, createHash } from "crypto";
import { getRedis } from "@/lib/redis";
import { getHistoricalImportQueue, getCommentSyncQueue } from "@/server/queue/queues";

const platformSchema = z.enum(["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"]);

function getHmacKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is not set — cannot sign OAuth state");
  return key;
}

export function signState(state: object): string {
  const payload = JSON.stringify(state);
  const sig = createHmac("sha256", getHmacKey()).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64");
}

export function verifyState(encoded: string): { brandId: string; orgId: string; codeVerifier?: string } {
  const { payload, sig } = JSON.parse(Buffer.from(encoded, "base64").toString());
  const expected = createHmac("sha256", getHmacKey()).update(payload).digest("hex");
  if (sig !== expected) throw new Error("Invalid state signature");
  return JSON.parse(payload);
}

export const socialAccountsRouter = router({
  // Returns which social platforms have credentials configured (visible to all authenticated users)
  configuredPlatforms: protectedProcedure
    .query(async ({ ctx }) => {
      const { db, profile } = ctx;
      const socialPlatforms = ["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"];

      const { data } = await db
        .from("platform_credentials")
        .select("platform")
        .eq("org_id", profile.org_id)
        .in("platform", socialPlatforms);

      return (data || []).map((row: any) => row.platform as string);
    }),

  list: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("social_accounts")
        .select("id, brand_id, platform, platform_user_id, platform_username, token_expires_at, connection_method, platform_metadata, is_active, created_at")
        .eq("brand_id", input.brandId)
        .order("created_at", { ascending: false });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data || [];
    }),

  initiateOAuth: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        platform: platformSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Only brand_owner can connect social accounts
      if (profile.role !== "brand_owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the brand owner can connect social accounts" });
      }

      // brand_owner can only connect to their own brand
      if (profile.brand_id !== input.brandId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only connect accounts for your own brand" });
      }

      // Get platform credentials
      const platKey = input.platform === "youtube" ? "youtube" : input.platform;
      const { data: creds } = await db
        .from("platform_credentials")
        .select("*")
        .eq("org_id", profile.org_id)
        .eq("platform", platKey)
        .single();

      if (!creds) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.platform} credentials not configured. Set them in Settings.`,
        });
      }

      const clientId = decrypt(creds.client_id_encrypted);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
      const redirectUri = `${appUrl}/api/callback/${input.platform}`;
      const state = signState({ brandId: input.brandId, orgId: profile.org_id });

      let url: string;

      switch (input.platform) {
        case "instagram":
          url = `https://www.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_manage_insights&response_type=code&state=${encodeURIComponent(state)}`;
          break;
        case "youtube":
          url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly")}&response_type=code&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
          break;
        case "linkedin":
          url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid profile w_member_social")}&state=${encodeURIComponent(state)}`;
          break;
        case "facebook":
          url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_show_list,business_management&response_type=code&auth_type=rerequest&state=${encodeURIComponent(state)}`;
          break;
        case "tiktok":
          url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientId}&scope=user.info.basic,video.publish,video.upload,comment.list,comment.list.manage&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
          break;
        case "twitter": {
          // Twitter OAuth 2.0 with PKCE
          const codeVerifier = randomBytes(32).toString("base64url");
          const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
          // Store code_verifier in state metadata so callback can retrieve it
          const twitterState = signState({ brandId: input.brandId, orgId: profile.org_id, codeVerifier });
          url = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("tweet.read tweet.write users.read offline.access")}&state=${encodeURIComponent(twitterState)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
          break;
        }
        case "snapchat":
          url = `https://accounts.snapchat.com/login/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=snapchat-marketing-api&state=${encodeURIComponent(state)}`;
          break;
      }

      return { url };
    }),

  connectManual: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        platform: platformSchema,
        accessToken: z.string().min(1),
        platformUserId: z.string().min(1),
        platformUsername: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Only brand_owner can connect social accounts
      if (profile.role !== "brand_owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the brand owner can connect social accounts" });
      }

      // brand_owner can only connect to their own brand
      if (profile.brand_id !== input.brandId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only connect accounts for your own brand" });
      }

      // Validate token with a test API call per platform
      try {
        let testUrl = "";
        const testHeaders: Record<string, string> = { "Authorization": `Bearer ${input.accessToken}` };

        if (input.platform === "instagram") {
          testUrl = `https://graph.facebook.com/v19.0/${input.platformUserId}?fields=id,username&access_token=${input.accessToken}`;
        } else if (input.platform === "youtube") {
          testUrl = `https://www.googleapis.com/youtube/v3/channels?part=id&mine=true`;
        } else if (input.platform === "linkedin") {
          testUrl = "https://api.linkedin.com/v2/userinfo";
          testHeaders["LinkedIn-Version"] = "202401";
        } else if (input.platform === "facebook") {
          testUrl = `https://graph.facebook.com/v19.0/me?access_token=${input.accessToken}`;
        } else if (input.platform === "tiktok") {
          testUrl = "https://open.tiktokapis.com/v2/user/info/?fields=open_id";
        } else if (input.platform === "twitter") {
          testUrl = "https://api.twitter.com/2/users/me";
        }

        if (testUrl) {
          const testRes = await fetch(testUrl, { headers: testHeaders });
          if (!testRes.ok) {
            const err = await testRes.text().catch(() => "");
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Token validation failed for ${input.platform}: ${testRes.status} ${err.slice(0, 200)}`,
            });
          }
        }
      } catch (e: any) {
        if (e.code === "BAD_REQUEST") throw e;
        throw new TRPCError({ code: "BAD_REQUEST", message: `Token validation failed: ${e.message}` });
      }

      // Check for existing account — upsert instead of creating duplicate
      const { data: existing } = await db.from("social_accounts")
        .select("id")
        .eq("brand_id", input.brandId)
        .eq("platform", input.platform)
        .eq("platform_user_id", input.platformUserId)
        .single();

      if (existing) {
        const { data: updated, error } = await db.from("social_accounts")
          .update({
            access_token_encrypted: encrypt(input.accessToken),
            platform_username: input.platformUsername || null,
            is_active: true,
          })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
        return updated;
      }

      const { data, error } = await db
        .from("social_accounts")
        .insert({
          brand_id: input.brandId,
          platform: input.platform,
          platform_user_id: input.platformUserId,
          platform_username: input.platformUsername || null,
          access_token_encrypted: encrypt(input.accessToken),
          connection_method: "manual_token",
          is_active: true,
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  disconnect: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: account } = await db
        .from("social_accounts")
        .select("brand_id")
        .eq("id", input.accountId)
        .single();

      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      assertBrandAccess(profile, account.brand_id);

      // ── Cascade-delete all content tied to this social account ──

      // 1. Delete replies on comments from this account
      const { data: commentRows } = await db
        .from("platform_comments")
        .select("id")
        .eq("social_account_id", input.accountId);
      if (commentRows && commentRows.length > 0) {
        await db.from("comment_replies").delete()
          .in("comment_id", commentRows.map((c: any) => c.id));
      }

      // 2. Delete platform comments
      await db.from("platform_comments").delete()
        .eq("social_account_id", input.accountId);

      // 3. Collect post IDs from publish jobs for this account
      const { data: jobRows } = await db
        .from("publish_jobs")
        .select("post_id")
        .eq("social_account_id", input.accountId)
        .not("post_id", "is", null);
      const postIds = [...new Set((jobRows || []).map((j: any) => j.post_id).filter(Boolean))];

      // 4. Delete comment sentiments for those posts
      if (postIds.length > 0) {
        await db.from("comment_sentiments").delete().in("post_id", postIds);
      }

      // 5. Delete post analytics + history for this account
      await db.from("post_analytics_history").delete()
        .eq("social_account_id", input.accountId);
      await db.from("post_analytics").delete()
        .eq("social_account_id", input.accountId);

      // 6. Delete publish jobs for this account
      await db.from("publish_jobs").delete()
        .eq("social_account_id", input.accountId);

      // 7. Remove orphaned content_posts that have zero remaining jobs
      //    For imported posts (source='api'), always delete — they belong solely to this account.
      //    For click posts, only delete if no other account's jobs remain.
      if (postIds.length > 0) {
        for (const pid of postIds) {
          const { data: postRow } = await db.from("content_posts")
            .select("source").eq("id", pid).maybeSingle();

          // Check if any jobs from OTHER accounts still reference this post
          const { count } = await db.from("publish_jobs")
            .select("id", { count: "exact", head: true })
            .eq("post_id", pid);

          if (count === 0 || postRow?.source === "api") {
            await db.from("post_analytics_history").delete().eq("post_id", pid);
            await db.from("post_analytics").delete().eq("post_id", pid);
            await db.from("comment_sentiments").delete().eq("post_id", pid);
            await db.from("publish_jobs").delete().eq("post_id", pid); // clean any remaining NULL-account jobs
            await db.from("content_posts").delete().eq("id", pid);
          }
        }
      }

      // 8. Delete the social account itself
      const { error } = await db
        .from("social_accounts")
        .delete()
        .eq("id", input.accountId);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),

  checkHealth: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: account } = await db
        .from("social_accounts")
        .select("brand_id, is_active, token_expires_at")
        .eq("id", input.accountId)
        .single();

      if (!account) return { healthy: false, reason: "Account not found" };
      assertBrandAccess(profile, account.brand_id);

      if (!account.is_active) return { healthy: false, reason: "Account inactive" };

      if (account.token_expires_at && new Date(account.token_expires_at) < new Date()) {
        return { healthy: false, reason: "Token expired" };
      }

      return { healthy: true };
    }),

  refreshToken: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: account } = await db
        .from("social_accounts")
        .select("*")
        .eq("id", input.accountId)
        .single();

      if (!account) throw new TRPCError({ code: "NOT_FOUND" });
      assertBrandAccess(profile, account.brand_id);
      if (!account.refresh_token_encrypted) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No refresh token available for this account" });
      }

      const refreshToken = decrypt(account.refresh_token_encrypted);
      const { data: brand } = await db.from("brands").select("org_id").eq("id", account.brand_id).single();
      if (!brand) throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });

      try {
        if (account.platform === "instagram" || account.platform === "facebook") {
          // Instagram/Facebook: long-lived token refresh
          const pageToken = account.platform_metadata?.page_access_token_encrypted
            ? decrypt(account.platform_metadata.page_access_token_encrypted)
            : decrypt(account.access_token_encrypted);
          const res = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=ig_refresh_token&access_token=${pageToken}`
          );
          const data = await res.json();
          if (data.error) throw new Error(data.error.message);
          if (data.access_token) {
            await db.from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
            }).eq("id", account.id);
          }
        } else if (account.platform === "youtube") {
          // Google/YouTube OAuth2 refresh
          const { data: creds } = await db.from("platform_credentials")
            .select("*").eq("org_id", brand.org_id).eq("platform", "youtube").single();
          if (!creds) throw new Error("YouTube credentials not configured");

          const res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: decrypt(creds.client_id_encrypted),
              client_secret: decrypt(creds.client_secret_encrypted),
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error_description || data.error);
          if (data.access_token) {
            await db.from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
            }).eq("id", account.id);
          }
        } else if (account.platform === "linkedin") {
          // LinkedIn tokens cannot be refreshed via API — user must re-authenticate
          throw new Error("LinkedIn tokens must be refreshed by reconnecting the account");
        } else if (account.platform === "tiktok") {
          const { data: creds } = await db.from("platform_credentials")
            .select("*").eq("org_id", brand.org_id).eq("platform", "tiktok").single();
          if (!creds) throw new Error("TikTok credentials not configured");

          const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_key: decrypt(creds.client_id_encrypted),
              client_secret: decrypt(creds.client_secret_encrypted),
              grant_type: "refresh_token",
              refresh_token: refreshToken,
            }),
          });
          const data = await res.json();
          if (data.data?.access_token) {
            await db.from("social_accounts").update({
              access_token_encrypted: encrypt(data.data.access_token),
              refresh_token_encrypted: data.data.refresh_token ? encrypt(data.data.refresh_token) : account.refresh_token_encrypted,
              token_expires_at: data.data.expires_in ? new Date(Date.now() + data.data.expires_in * 1000).toISOString() : null,
            }).eq("id", account.id);
          } else {
            throw new Error(data.error?.message || "TikTok token refresh failed");
          }
        } else if (account.platform === "twitter") {
          const { data: creds } = await db.from("platform_credentials")
            .select("*").eq("org_id", brand.org_id).eq("platform", "twitter").single();
          if (!creds) throw new Error("Twitter credentials not configured");

          const basicAuth = Buffer.from(`${decrypt(creds.client_id_encrypted)}:${decrypt(creds.client_secret_encrypted)}`).toString("base64");
          const res = await fetch("https://api.twitter.com/2/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${basicAuth}` },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
          });
          const data = await res.json();
          if (data.access_token) {
            await db.from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : account.refresh_token_encrypted,
              token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
            }).eq("id", account.id);
          } else {
            throw new Error(data.error_description || "Twitter token refresh failed");
          }
        } else if (account.platform === "snapchat") {
          const { data: creds } = await db.from("platform_credentials")
            .select("*").eq("org_id", brand.org_id).eq("platform", "snapchat").single();
          if (!creds) throw new Error("Snapchat credentials not configured");

          const res = await fetch("https://accounts.snapchat.com/login/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: decrypt(creds.client_id_encrypted),
              client_secret: decrypt(creds.client_secret_encrypted),
              grant_type: "refresh_token",
              refresh_token: refreshToken,
            }),
          });
          const data = await res.json();
          if (data.access_token) {
            await db.from("social_accounts").update({
              access_token_encrypted: encrypt(data.access_token),
              refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : account.refresh_token_encrypted,
              token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
            }).eq("id", account.id);
          } else {
            throw new Error("Snapchat token refresh failed");
          }
        } else {
          throw new Error(`Token refresh not supported for ${account.platform}`);
        }

        return { success: true, message: `${account.platform} token refreshed successfully` };
      } catch (e: any) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e.message });
      }
    }),

  getPendingChannels: protectedProcedure
    .input(z.object({ pendingId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const redis = getRedis();
      const raw = await redis.get(`pending_channels:${input.pendingId}`);
      if (!raw) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pending channel selection expired or not found" });
      }

      const data = JSON.parse(raw);

      // Verify the user has access to this brand
      assertBrandAccess(ctx.profile, data.brandId);

      // Return channels without sensitive token data
      return {
        platform: data.platform as string,
        brandId: data.brandId as string,
        channels: (data.channels as Array<{ id: string; name: string; thumbnail?: string }>).map((ch) => ({
          id: ch.id,
          name: ch.name,
          thumbnail: (ch as any).thumbnail || null,
        })),
      };
    }),

  connectSelectedChannels: protectedProcedure
    .input(z.object({
      pendingId: z.string().uuid(),
      selectedChannelIds: z.array(z.string()).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      if (profile.role !== "brand_owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the brand owner can connect social accounts" });
      }

      const redis = getRedis();
      const raw = await redis.get(`pending_channels:${input.pendingId}`);
      if (!raw) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pending channel selection expired. Please re-authenticate." });
      }

      const data = JSON.parse(raw);
      assertBrandAccess(profile, data.brandId);

      if (profile.brand_id !== data.brandId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only connect accounts for your own brand" });
      }

      const platform = data.platform as string;
      const allChannels = data.channels as Array<{
        id: string;
        name: string;
        pageId?: string;
        pageToken?: string;
        thumbnail?: string;
      }>;

      const selected = allChannels.filter((ch) => input.selectedChannelIds.includes(ch.id));
      if (selected.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "None of the selected channels were found" });
      }

      const connected: string[] = [];

      for (const ch of selected) {
        const tokenToStore = ch.pageToken || data.userAccessToken;
        const platformMetadata: Record<string, unknown> = {};
        let platformUserId = ch.id;
        let platformUsername = ch.name;

        if (platform === "instagram" || platform === "facebook") {
          platformMetadata.page_id = ch.pageId || ch.id;
          platformMetadata.page_access_token_encrypted = encrypt(ch.pageToken || data.userAccessToken);
        } else if (platform === "youtube") {
          platformMetadata.channel_id = ch.id;
        }

        // Upsert: update if exists, insert if new
        const { data: existing } = await db.from("social_accounts")
          .select("id")
          .eq("brand_id", data.brandId)
          .eq("platform", platform)
          .eq("platform_user_id", platformUserId)
          .single();

        if (existing) {
          await db.from("social_accounts").update({
            access_token_encrypted: encrypt(tokenToStore),
            refresh_token_encrypted: data.refreshToken ? encrypt(data.refreshToken) : null,
            token_expires_at: data.expiresAt || null,
            platform_username: platformUsername,
            platform_metadata: platformMetadata,
            is_active: true,
          }).eq("id", existing.id);

          connected.push(existing.id);

          // Queue jobs for reconnected account
          try {
            const queue = getHistoricalImportQueue();
            await queue.add(`historical-${platform}-${data.brandId}`, {
              accountId: existing.id, brandId: data.brandId, orgId: data.orgId, platform,
            });
          } catch {}
        } else {
          const { data: newAccount } = await db.from("social_accounts").insert({
            brand_id: data.brandId,
            platform,
            platform_user_id: platformUserId,
            platform_username: platformUsername,
            access_token_encrypted: encrypt(tokenToStore),
            refresh_token_encrypted: data.refreshToken ? encrypt(data.refreshToken) : null,
            token_expires_at: data.expiresAt || null,
            connection_method: "oauth",
            platform_metadata: platformMetadata,
            is_active: true,
          }).select("id").single();

          if (newAccount) {
            connected.push(newAccount.id);

            // Queue jobs for new account
            try {
              const queue = getHistoricalImportQueue();
              await queue.add(`historical-${platform}-${data.brandId}`, {
                accountId: newAccount.id, brandId: data.brandId, orgId: data.orgId, platform,
              });
            } catch {}
          }
        }

        // Queue comment sync
        try {
          const commentSyncQueue = getCommentSyncQueue();
          await commentSyncQueue.add(`comment-sync-${platform}-${data.brandId}`, {
            brandId: data.brandId,
          });
        } catch {}
      }

      // Clean up Redis
      await redis.del(`pending_channels:${input.pendingId}`);

      return { connected: connected.length, platform };
    }),
});
