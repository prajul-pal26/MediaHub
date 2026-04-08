import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/supabase/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { verifyState } from "@/server/trpc/routers/social-accounts";
import { getHistoricalImportQueue, getCommentSyncQueue } from "@/server/queue/queues";
import { getRedis } from "@/lib/redis";
import { randomUUID } from "crypto";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.url;

  console.log(`[social-callback] Platform: ${platform}, code: ${code ? "yes" : "no"}, error: ${error}`);

  if (error) {
    return NextResponse.redirect(
      new URL(`/accounts?error=${encodeURIComponent(error)}`, baseUrl)
    );
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(
      new URL("/accounts?error=missing_code_or_state", baseUrl)
    );
  }

  let state: { brandId: string; orgId: string; codeVerifier?: string };
  try {
    state = verifyState(stateParam);
  } catch {
    return NextResponse.redirect(
      new URL("/accounts?error=invalid_state", baseUrl)
    );
  }

  const db = getDb();

  try {
    // Get platform credentials
    const { data: creds } = await db
      .from("platform_credentials")
      .select("*")
      .eq("org_id", state.orgId)
      .eq("platform", platform)
      .single();

    if (!creds) {
      return NextResponse.redirect(
        new URL(`/accounts?error=credentials_not_configured_for_${platform}`, baseUrl)
      );
    }

    const clientId = decrypt(creds.client_id_encrypted);
    const clientSecret = decrypt(creds.client_secret_encrypted);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const redirectUri = `${appUrl}/api/callback/${platform}`;

    let accessToken: string = "";
    let refreshToken: string | null = null;
    let expiresAt: string | null = null;
    let platformUserId = "";
    let platformUsername = "";
    let platformMetadata: Record<string, unknown> = {};

    // ─── YouTube ───
    if (platform === "youtube") {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error("[social-callback] YouTube token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Get ALL channels (includes brand accounts managed by this Google account)
      const channelRes = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const channelData = await channelRes.json();
      const allChannels = channelData.items || [];

      if (allChannels.length > 1) {
        // Multiple channels — store in Redis and let user pick
        const pendingId = randomUUID();
        const redis = getRedis();
        await redis.set(
          `pending_channels:${pendingId}`,
          JSON.stringify({
            platform,
            brandId: state.brandId,
            orgId: state.orgId,
            userAccessToken: accessToken,
            refreshToken,
            expiresAt,
            channels: allChannels.map((ch: any) => ({
              id: ch.id,
              name: ch.snippet?.title || ch.id,
              thumbnail: ch.snippet?.thumbnails?.default?.url || null,
            })),
          }),
          "EX",
          600
        );

        console.log(`[social-callback] YouTube: ${allChannels.length} channels found, pending selection ${pendingId}`);
        return NextResponse.redirect(
          new URL(`/accounts?pending_channels=${pendingId}&platform=${platform}`, baseUrl)
        );
      }

      // Single channel — auto-connect as before
      const channel = allChannels[0];
      platformUserId = channel?.id || "";
      platformUsername = channel?.snippet?.title || "";
      platformMetadata = { channel_id: channel?.id };

      console.log("[social-callback] YouTube connected:", platformUsername);
    }

    // ─── Instagram (Instagram Login API) ───
    else if (platform === "instagram") {
      console.log("[social-callback] Instagram redirect_uri for token exchange:", redirectUri);
      // Step 1: Exchange code for short-lived token (Instagram requires multipart/form-data)
      const tokenBody = new FormData();
      tokenBody.append("client_id", clientId);
      tokenBody.append("client_secret", clientSecret);
      tokenBody.append("grant_type", "authorization_code");
      tokenBody.append("redirect_uri", redirectUri);
      tokenBody.append("code", code);
      const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        body: tokenBody,
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error_type || tokenData.error_message) {
        console.error("[social-callback] Instagram token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_message || "Instagram auth failed")}`, baseUrl)
        );
      }

      const shortLivedToken = tokenData.access_token;
      const igUserId = String(tokenData.user_id);

      // Step 2: Exchange for long-lived token (60 days)
      const longLivedRes = await fetch(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${clientSecret}&access_token=${shortLivedToken}`
      );
      const longLivedData = await longLivedRes.json();

      if (longLivedData.error) {
        console.error("[social-callback] Instagram long-lived token error:", longLivedData);
        // Fall back to short-lived token
        accessToken = shortLivedToken;
      } else {
        accessToken = longLivedData.access_token;
        if (longLivedData.expires_in) {
          expiresAt = new Date(Date.now() + longLivedData.expires_in * 1000).toISOString();
        }
      }

      // Step 3: Get user profile
      const profileRes = await fetch(
        `https://graph.instagram.com/v21.0/me?fields=user_id,username,account_type,profile_picture_url&access_token=${accessToken}`
      );
      const profileData = await profileRes.json();

      if (profileData.error) {
        console.error("[social-callback] Instagram profile error:", profileData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(profileData.error?.message || "Failed to get Instagram profile")}`, baseUrl)
        );
      }

      platformUserId = profileData.user_id || igUserId;
      platformUsername = profileData.username || "";
      platformMetadata = {
        account_type: profileData.account_type,
        profile_picture_url: profileData.profile_picture_url,
        ig_user_id: igUserId,
      };

      console.log("[social-callback] Instagram connected via Instagram Login:", platformUsername);
    }

    // ─── LinkedIn ───
    else if (platform === "linkedin") {
      const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error("[social-callback] LinkedIn token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const profileData = await profileRes.json();
      platformUserId = profileData.sub || "";
      platformUsername = profileData.name || "";
      platformMetadata = { person_urn: `urn:li:person:${profileData.sub}` };

      console.log("[social-callback] LinkedIn connected:", platformUsername);
    }

    // ─── Facebook ───
    else if (platform === "facebook") {
      console.log("[social-callback] Facebook: exchanging code for token...");
      console.log("[social-callback] Facebook redirect_uri:", redirectUri);
      const tokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`
      );
      const tokenData = await tokenRes.json();
      console.log("[social-callback] Facebook token response:", tokenData.error ? JSON.stringify(tokenData.error) : "OK (token received)");

      if (tokenData.error) {
        console.error("[social-callback] Facebook token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error?.message || "Facebook auth failed")}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;

      // Get ALL pages
      console.log("[social-callback] Facebook: fetching pages...");
      const pagesRes = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`
      );
      const pagesData = await pagesRes.json();
      const allPages = pagesData.data || [];
      console.log(`[social-callback] Facebook: ${allPages.length} pages found`, allPages.map((p: any) => p.name));

      if (allPages.length === 0) {
        return NextResponse.redirect(
          new URL("/accounts?error=No+Facebook+Page+found.+Please+ensure+your+account+has+at+least+one+Page.", baseUrl)
        );
      }

      if (allPages.length > 1) {
        // Multiple pages — store in Redis and let user pick
        const pendingId = randomUUID();
        const redis = getRedis();
        await redis.set(
          `pending_channels:${pendingId}`,
          JSON.stringify({
            platform,
            brandId: state.brandId,
            orgId: state.orgId,
            userAccessToken: accessToken,
            refreshToken: null,
            expiresAt: null,
            channels: allPages.map((page: any) => ({
              id: page.id,
              name: page.name || page.id,
              pageId: page.id,
              pageToken: page.access_token,
            })),
          }),
          "EX",
          600
        );

        console.log(`[social-callback] Facebook: ${allPages.length} pages found, pending selection ${pendingId}`);
        return NextResponse.redirect(
          new URL(`/accounts?pending_channels=${pendingId}&platform=${platform}`, baseUrl)
        );
      }

      // Single page — auto-connect as before
      const page = allPages[0];
      const pageToken = page.access_token;
      platformUserId = page.id;
      platformUsername = page.name || "";
      platformMetadata = { page_id: page.id, page_access_token_encrypted: encrypt(pageToken) };
      accessToken = pageToken;

      console.log("[social-callback] Facebook connected:", platformUsername);
    }

    // ─── TikTok ───
    else if (platform === "tiktok") {
      const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error || !tokenData.access_token) {
        console.error("[social-callback] TikTok token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error || "TikTok auth failed")}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Get user info
      const userRes = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = await userRes.json();
      const userInfo = userData.data?.user;

      platformUserId = tokenData.open_id || userInfo?.open_id || "";
      platformUsername = userInfo?.display_name || "";
      platformMetadata = { open_id: platformUserId, avatar_url: userInfo?.avatar_url };

      console.log("[social-callback] TikTok connected:", platformUsername);
    }

    // ─── Twitter/X ───
    else if (platform === "twitter") {
      const codeVerifier = state.codeVerifier;
      if (!codeVerifier) {
        return NextResponse.redirect(
          new URL("/accounts?error=missing_code_verifier_for_twitter", baseUrl)
        );
      }

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error("[social-callback] Twitter token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Get user info
      const userRes = await fetch("https://api.twitter.com/2/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = await userRes.json();

      platformUserId = userData.data?.id || "";
      platformUsername = userData.data?.username || "";
      platformMetadata = { twitter_id: platformUserId };

      console.log("[social-callback] Twitter/X connected:", platformUsername);
    }

    // ─── Snapchat ───
    else if (platform === "snapchat") {
      const tokenRes = await fetch("https://accounts.snapchat.com/login/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error("[social-callback] Snapchat token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, baseUrl)
        );
      }

      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Get user info
      const userRes = await fetch("https://kit.snapchat.com/v1/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = await userRes.json();

      platformUserId = userData.data?.me?.externalId || userData.me?.externalId || "";
      platformUsername = userData.data?.me?.displayName || userData.me?.displayName || "";
      platformMetadata = { snap_id: platformUserId };

      console.log("[social-callback] Snapchat connected:", platformUsername);
    }

    else {
      return NextResponse.redirect(
        new URL(`/accounts?error=unsupported_platform_${platform}`, baseUrl)
      );
    }

    // Check for duplicate — same platform_user_id + brand + platform
    const { data: existing } = await db.from("social_accounts")
      .select("id")
      .eq("brand_id", state.brandId)
      .eq("platform", platform)
      .eq("platform_user_id", platformUserId)
      .single();

    if (existing) {
      // Update existing account's tokens instead of creating duplicate
      await db.from("social_accounts").update({
        access_token_encrypted: encrypt(accessToken),
        refresh_token_encrypted: refreshToken ? encrypt(refreshToken) : null,
        token_expires_at: expiresAt,
        platform_username: platformUsername,
        platform_metadata: platformMetadata,
        is_active: true,
      }).eq("id", existing.id);

      console.log("[social-callback] Updated existing account:", platformUsername);

      // Queue historical import for reconnected account
      try {
        const queue = getHistoricalImportQueue();
        await queue.add(`historical-${platform}-${state.brandId}`, {
          accountId: existing.id,
          brandId: state.brandId,
          orgId: state.orgId,
          platform,
        });
        console.log(`[social-callback] Queued historical import for ${platform}`);
      } catch (e: any) {
        console.error("[social-callback] Failed to queue historical import:", e.message);
      }

      // Queue comment sync for the reconnected account
      try {
        const commentSyncQueue = getCommentSyncQueue();
        await commentSyncQueue.add(`comment-sync-${platform}-${state.brandId}`, {
          brandId: state.brandId,
        });
        console.log(`[social-callback] Queued comment sync for ${platform}`);
      } catch (e: any) {
        console.error("[social-callback] Failed to queue comment sync:", e.message);
      }

      return NextResponse.redirect(
        new URL(`/accounts?connected=${platform}&updated=true`, baseUrl)
      );
    }

    // Save new account
    const { data: newAccount, error: insertError } = await db.from("social_accounts").insert({
      brand_id: state.brandId,
      platform,
      platform_user_id: platformUserId,
      platform_username: platformUsername,
      access_token_encrypted: encrypt(accessToken),
      refresh_token_encrypted: refreshToken ? encrypt(refreshToken) : null,
      token_expires_at: expiresAt,
      connection_method: "oauth",
      platform_metadata: platformMetadata,
      is_active: true,
    }).select("id").single();

    if (insertError) {
      console.error("[social-callback] DB insert error:", insertError);
      return NextResponse.redirect(
        new URL(`/accounts?error=${encodeURIComponent(insertError.message)}`, baseUrl)
      );
    }

    // Queue historical import for newly connected account
    try {
      const queue = getHistoricalImportQueue();
      await queue.add(`historical-${platform}-${state.brandId}`, {
        accountId: newAccount.id,
        brandId: state.brandId,
        orgId: state.orgId,
        platform,
      });
      console.log(`[social-callback] Queued historical import for ${platform}`);
    } catch (e: any) {
      console.error("[social-callback] Failed to queue historical import:", e.message);
    }

    // Queue comment sync for the newly connected account
    try {
      const commentSyncQueue = getCommentSyncQueue();
      await commentSyncQueue.add(`comment-sync-${platform}-${state.brandId}`, {
        brandId: state.brandId,
      });
      console.log(`[social-callback] Queued comment sync for ${platform}`);
    } catch (e: any) {
      console.error("[social-callback] Failed to queue comment sync:", e.message);
    }

    return NextResponse.redirect(
      new URL(`/accounts?connected=${platform}`, baseUrl)
    );
  } catch (e: any) {
    console.error("[social-callback] Error:", e.message);
    return NextResponse.redirect(
      new URL(`/accounts?error=${encodeURIComponent(e.message)}`, baseUrl)
    );
  }
}
