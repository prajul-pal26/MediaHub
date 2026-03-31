import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { encrypt, decrypt } from "@/lib/encryption";
import { createHmac } from "crypto";

const platformSchema = z.enum(["instagram", "youtube", "linkedin"]);

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

export function verifyState(encoded: string): { brandId: string; orgId: string } {
  const { payload, sig } = JSON.parse(Buffer.from(encoded, "base64").toString());
  const expected = createHmac("sha256", getHmacKey()).update(payload).digest("hex");
  if (sig !== expected) throw new Error("Invalid state signature");
  return JSON.parse(payload);
}

export const socialAccountsRouter = router({
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
          url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement&response_type=code&auth_type=reauthorize&state=${encodeURIComponent(state)}`;
          break;
        case "youtube":
          url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly")}&response_type=code&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
          break;
        case "linkedin":
          url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid profile w_member_social")}&state=${encodeURIComponent(state)}`;
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

      // TODO: Validate token with a test API call per platform

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

      // Clean up all content tied to this social account before deleting

      // 1. Delete comment replies linked to this account's comments
      const { data: commentIds } = await db
        .from("platform_comments")
        .select("id")
        .eq("social_account_id", input.accountId);
      if (commentIds && commentIds.length > 0) {
        await db
          .from("comment_replies")
          .delete()
          .in("comment_id", commentIds.map((c: any) => c.id));
      }

      // 2. Delete platform comments from this account
      await db
        .from("platform_comments")
        .delete()
        .eq("social_account_id", input.accountId);

      // 3. Delete comment sentiments for posts published via this account
      const { data: jobsWithPosts } = await db
        .from("publish_jobs")
        .select("post_id")
        .eq("social_account_id", input.accountId)
        .not("post_id", "is", null);
      const postIds = [...new Set((jobsWithPosts || []).map((j: any) => j.post_id).filter(Boolean))];

      if (postIds.length > 0) {
        await db
          .from("comment_sentiments")
          .delete()
          .in("post_id", postIds);
      }

      // 4. Delete post analytics for this account
      await db
        .from("post_analytics")
        .delete()
        .eq("social_account_id", input.accountId);

      // 5. Delete publish jobs for this account
      await db
        .from("publish_jobs")
        .delete()
        .eq("social_account_id", input.accountId);

      // 6. Clean up content_posts that have no remaining publish jobs
      if (postIds.length > 0) {
        for (const postId of postIds) {
          const { count } = await db
            .from("publish_jobs")
            .select("id", { count: "exact", head: true })
            .eq("post_id", postId);
          if (count === 0) {
            // No jobs left — delete orphaned post and its analytics
            await db.from("post_analytics").delete().eq("post_id", postId);
            await db.from("comment_sentiments").delete().eq("post_id", postId);
            await db.from("content_posts").delete().eq("id", postId);
          }
        }
      }

      // 7. Finally delete the social account itself
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
        throw new TRPCError({ code: "BAD_REQUEST", message: "No refresh token available" });
      }

      // TODO: Call platform-specific refresh endpoint
      // For now, return success placeholder
      return { success: true, message: "Token refresh will be implemented with platform APIs" };
    }),
});
