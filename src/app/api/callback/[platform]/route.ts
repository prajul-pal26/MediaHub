import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/supabase/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { verifyState } from "@/server/trpc/routers/social-accounts";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  console.log(`[social-callback] Platform: ${platform}, code: ${code ? "yes" : "no"}, error: ${error}`);

  if (error) {
    return NextResponse.redirect(
      new URL(`/accounts?error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(
      new URL("/accounts?error=missing_code_or_state", request.url)
    );
  }

  let state: { brandId: string; orgId: string };
  try {
    state = verifyState(stateParam);
  } catch {
    return NextResponse.redirect(
      new URL("/accounts?error=invalid_state", request.url)
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
        new URL(`/accounts?error=credentials_not_configured_for_${platform}`, request.url)
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
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, request.url)
        );
      }

      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token || null;
      if (tokenData.expires_in) {
        expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      }

      // Get channel info
      const channelRes = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const channelData = await channelRes.json();
      const channel = channelData.items?.[0];
      platformUserId = channel?.id || "";
      platformUsername = channel?.snippet?.title || "";
      platformMetadata = { channel_id: channel?.id };

      console.log("[social-callback] YouTube connected:", platformUsername);
    }

    // ─── Instagram ───
    else if (platform === "instagram") {
      const tokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`
      );
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        console.error("[social-callback] Instagram token error:", tokenData);
        return NextResponse.redirect(
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error?.message || "Instagram auth failed")}`, request.url)
        );
      }

      accessToken = tokenData.access_token;

      // Get pages
      const pagesRes = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`
      );
      const pagesData = await pagesRes.json();
      const page = pagesData.data?.[0];

      if (page) {
        const pageToken = page.access_token;
        const igRes = await fetch(
          `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${pageToken}`
        );
        const igData = await igRes.json();
        platformUserId = igData.instagram_business_account?.id || page.id;
        platformUsername = page.name || "";
        platformMetadata = { page_id: page.id, page_access_token_encrypted: encrypt(pageToken) };
        accessToken = pageToken;
      } else {
        return NextResponse.redirect(
          new URL("/accounts?error=No+Facebook+Page+found.+Instagram+requires+a+Business/Creator+account+connected+to+a+Facebook+Page.", request.url)
        );
      }

      console.log("[social-callback] Instagram connected:", platformUsername);
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
          new URL(`/accounts?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`, request.url)
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

    else {
      return NextResponse.redirect(
        new URL(`/accounts?error=unsupported_platform_${platform}`, request.url)
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
      return NextResponse.redirect(
        new URL(`/accounts?connected=${platform}&updated=true`, request.url)
      );
    }

    // Save new account
    const { error: insertError } = await db.from("social_accounts").insert({
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
    });

    if (insertError) {
      console.error("[social-callback] DB insert error:", insertError);
      return NextResponse.redirect(
        new URL(`/accounts?error=${encodeURIComponent(insertError.message)}`, request.url)
      );
    }

    return NextResponse.redirect(
      new URL(`/accounts?connected=${platform}`, request.url)
    );
  } catch (e: any) {
    console.error("[social-callback] Error:", e.message);
    return NextResponse.redirect(
      new URL(`/accounts?error=${encodeURIComponent(e.message)}`, request.url)
    );
  }
}
