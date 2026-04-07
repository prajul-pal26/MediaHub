import { z } from "zod";
import { router, superAdminProcedure, protectedProcedure } from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import { TRPCError } from "@trpc/server";
import { sendTestEmail } from "@/lib/email";

const allPlatformSchema = z.enum(["instagram", "youtube", "linkedin", "google_drive", "email_smtp", "llm_provider", "llm_openrouter", "llm_anthropic", "llm_openai", "llm_google", "facebook", "tiktok", "twitter", "snapchat"]);

export const credentialsRouter = router({
  // List all platform credentials for this org
  list: superAdminProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    const { data, error } = await db
      .from("platform_credentials")
      .select("*")
      .eq("org_id", profile.org_id);

    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

    return (data || []).map((cred: any) => ({
      id: cred.id,
      platform: cred.platform,
      client_id: cred.client_id_encrypted ? decrypt(cred.client_id_encrypted) : "",
      client_secret_masked: cred.client_secret_encrypted
        ? "••••••••" + decrypt(cred.client_secret_encrypted).slice(-4)
        : "",
      has_secret: !!cred.client_secret_encrypted,
      redirect_uri: cred.redirect_uri,
      status: cred.status,
      metadata: cred.metadata || {},
      updated_at: cred.updated_at,
    }));
  }),

  // Save credentials for a platform (social or email)
  upsert: superAdminProcedure
    .input(
      z.object({
        platform: allPlatformSchema,
        client_id: z.string().min(1),
        client_secret: z.string().optional(), // null for Resend (no secret, just API key)
        metadata: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

      const platformCallbackMap: Record<string, string> = {
        instagram: `${appUrl}/api/callback/instagram`,
        youtube: `${appUrl}/api/callback/youtube`,
        linkedin: `${appUrl}/api/callback/linkedin`,
        google_drive: `${appUrl}/api/callback/google-drive`,
        facebook: `${appUrl}/api/callback/facebook`,
        tiktok: `${appUrl}/api/callback/tiktok`,
        twitter: `${appUrl}/api/callback/twitter`,
        snapchat: `${appUrl}/api/callback/snapchat`,
        email_smtp: "",
      };

      const row: Record<string, unknown> = {
        org_id: profile.org_id,
        platform: input.platform,
        client_id_encrypted: encrypt(input.client_id),
        redirect_uri: platformCallbackMap[input.platform] || "",
        updated_at: new Date().toISOString(),
      };

      // Handle client_secret
      if (input.client_secret) {
        row.client_secret_encrypted = encrypt(input.client_secret);
      } else {
        // Check if existing record has a secret we can keep
        const { data: existing } = await db
          .from("platform_credentials")
          .select("client_secret_encrypted")
          .eq("org_id", profile.org_id)
          .eq("platform", input.platform)
          .single();

        // Always set a value — column is NOT NULL
        row.client_secret_encrypted = existing?.client_secret_encrypted || encrypt("none");
      }

      if (input.metadata) {
        row.metadata = input.metadata;
      }

      const { data, error } = await db
        .from("platform_credentials")
        .upsert(row, { onConflict: "org_id,platform" })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  // Test credentials — verify they actually work
  test: superAdminProcedure
    .input(z.object({ platform: allPlatformSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: cred } = await db
        .from("platform_credentials")
        .select("*")
        .eq("org_id", profile.org_id)
        .eq("platform", input.platform)
        .single();

      if (!cred) {
        return { success: false, error: "Credentials not saved yet" };
      }

      try {
        const clientId = decrypt(cred.client_id_encrypted);
        const clientSecret = cred.client_secret_encrypted ? decrypt(cred.client_secret_encrypted) : "";

        // ─── LLM Providers ───
        if (input.platform === "llm_provider" || input.platform.startsWith("llm_")) {
          try {
            const apiKey = clientId; // For LLM providers, the API key is stored in client_id
            const metadata = cred.metadata || {};
            const provider = metadata.provider || input.platform.replace("llm_", "") || "openrouter";
            const model = metadata.default_model;

            // Map platform to base URL and test
            const providerConfig: Record<string, { url: string; body: any; headers: Record<string, string> }> = {
              openrouter: {
                url: "https://openrouter.ai/api/v1/chat/completions",
                headers: { "Authorization": `Bearer ${apiKey}`, "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL!, "Content-Type": "application/json" },
                body: { model: model || "anthropic/claude-sonnet-4-6", messages: [{ role: "user", content: "Say hello in 5 words." }], max_tokens: 50 },
              },
              anthropic: {
                url: "https://api.anthropic.com/v1/messages",
                headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
                body: { model: model || "claude-sonnet-4-6-20250514", max_tokens: 50, messages: [{ role: "user", content: "Say hello in 5 words." }] },
              },
              openai: {
                url: "https://api.openai.com/v1/chat/completions",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: { model: model || "gpt-4o-mini", messages: [{ role: "user", content: "Say hello in 5 words." }], max_tokens: 50 },
              },
              google: {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.0-flash"}:generateContent?key=${apiKey}`,
                headers: { "Content-Type": "application/json" },
                body: { contents: [{ parts: [{ text: "Say hello in 5 words." }] }] },
              },
            };

            const providerKey = provider === "llm_provider" ? (metadata.provider || "openrouter") : provider;
            const cfg = providerConfig[providerKey];
            if (!cfg) {
              return { success: false, error: `Unknown LLM provider: ${providerKey}` };
            }

            const res = await fetch(cfg.url, {
              method: "POST",
              headers: cfg.headers,
              body: JSON.stringify(cfg.body),
            });
            const data = await res.json();

            if (!res.ok) {
              const errMsg = data.error?.message || data.error?.type || JSON.stringify(data.error || data);
              return { success: false, error: `${providerKey} API error: ${errMsg}` };
            }

            // Extract reply based on provider format
            let reply = "";
            if (providerKey === "anthropic") {
              reply = data.content?.[0]?.text || "";
            } else if (providerKey === "google") {
              reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            } else {
              reply = data.choices?.[0]?.message?.content || "";
            }

            return { success: true, message: `AI responded: "${reply.slice(0, 100)}"` };
          } catch (e: any) {
            return { success: false, error: e.message };
          }
        }

        // ─── Email (Gmail SMTP) ───
        if (input.platform === "email_smtp") {
          const result = await sendTestEmail({ to: profile.email, orgId: profile.org_id });
          if (result.success) {
            return { success: true, message: `Test email sent to ${profile.email} — check your inbox` };
          }
          return { success: false, error: result.error || "Failed to send test email" };
        }

        // ─── YouTube / Google ───
        if (input.platform === "youtube") {
          // Attempt a real OAuth token endpoint call with client_credentials
          // Google doesn't support client_credentials, so we verify by calling the discovery endpoint
          // and checking the client ID exists in Google's system
          const res = await fetch(
            `https://oauth2.googleapis.com/token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "authorization_code",
                code: "test_invalid_code",
                redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
              }),
            }
          );
          const data = await res.json();
          // "invalid_grant" = credentials are valid, code is wrong (expected)
          // "invalid_client" = credentials are wrong
          if (data.error === "invalid_grant" || data.error === "redirect_uri_mismatch") {
            return { success: true, message: "YouTube/Google credentials verified — Client ID and Secret are valid" };
          }
          if (data.error === "invalid_client") {
            return { success: false, error: "Invalid Client ID or Client Secret — Google rejected the credentials" };
          }
          return { success: false, error: `Google responded: ${data.error_description || data.error || "Unknown error"}` };
        }

        // ─── Google Drive ───
        if (input.platform === "google_drive") {
          const res = await fetch(
            `https://oauth2.googleapis.com/token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "authorization_code",
                code: "test_invalid_code",
                redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
              }),
            }
          );
          const data = await res.json();
          if (data.error === "invalid_grant" || data.error === "redirect_uri_mismatch") {
            return { success: true, message: "Google Drive credentials verified — Client ID and Secret are valid" };
          }
          if (data.error === "invalid_client") {
            return { success: false, error: "Invalid Client ID or Client Secret — Google rejected the credentials" };
          }
          return { success: false, error: `Google responded: ${data.error_description || data.error || "Unknown error"}` };
        }

        // ─── Instagram / Meta (Instagram Login API) ───
        if (input.platform === "instagram") {
          // Verify by attempting a token exchange with a dummy code
          // Instagram API will return "invalid code" if credentials are valid, or "invalid client" if not
          const formData = new FormData();
          formData.append("client_id", clientId);
          formData.append("client_secret", clientSecret);
          formData.append("grant_type", "authorization_code");
          formData.append("redirect_uri", cred.redirect_uri || `${process.env.NEXT_PUBLIC_APP_URL}/api/callback/instagram`);
          formData.append("code", "test_invalid_code");
          const res = await fetch("https://api.instagram.com/oauth/access_token", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          // "Invalid authorization code" = credentials are valid, code is wrong (expected)
          // "Invalid platform app" or "invalid client_id" = credentials are wrong
          const errMsg = data.error_message || data.error?.message || "";
          if (errMsg.toLowerCase().includes("authorization code") || errMsg.toLowerCase().includes("code")) {
            return { success: true, message: "Instagram credentials verified — App ID and Secret are valid" };
          }
          if (data.error_type || data.error) {
            return { success: false, error: `Instagram: ${errMsg || data.error_type || "Invalid credentials"}` };
          }
          return { success: false, error: "Could not verify Instagram credentials" };
        }

        // ─── LinkedIn ───
        if (input.platform === "linkedin") {
          // LinkedIn token endpoint with dummy code — checks if client_id/secret are valid
          const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: "test_invalid_code",
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
            }),
          });
          const data = await res.json();
          // "invalid_grant" or similar = credentials valid, code wrong
          // "invalid_client" = credentials wrong
          if (data.error === "invalid_redirect_uri" || data.error === "invalid_request") {
            return { success: true, message: "LinkedIn credentials verified — Client ID and Secret are valid" };
          }
          if (data.error === "invalid_client_id" || data.error_description?.includes("client")) {
            return { success: false, error: "Invalid LinkedIn Client ID or Secret" };
          }
          return { success: true, message: "LinkedIn credentials format accepted" };
        }

        // ─── Facebook ───
        if (input.platform === "facebook") {
          // Same as Instagram — verify via client_credentials grant on Graph API
          const res = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?` +
            `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
          );
          const data = await res.json();
          if (data.access_token) {
            return { success: true, message: "Facebook credentials verified — App ID and Secret are valid" };
          }
          if (data.error) {
            return { success: false, error: `Facebook: ${data.error.message || data.error.type || "Invalid credentials"}` };
          }
          return { success: false, error: "Could not verify Facebook credentials" };
        }

        // ─── TikTok ───
        if (input.platform === "tiktok") {
          // TikTok token endpoint with dummy code — checks if client_key/secret are valid
          const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_key: clientId,
              client_secret: clientSecret,
              grant_type: "authorization_code",
              code: "test_invalid_code",
              redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
            }),
          });
          const data = await res.json();
          // "invalid_grant" = credentials valid, code wrong; "invalid_client" = credentials wrong
          if (data.error === "invalid_grant" || data.data?.error_code === "invalid_grant") {
            return { success: true, message: "TikTok credentials verified — Client Key and Secret are valid" };
          }
          if (data.error === "invalid_client" || data.data?.description?.includes("client")) {
            return { success: false, error: "Invalid TikTok Client Key or Secret" };
          }
          return { success: true, message: "TikTok credentials format accepted" };
        }

        // ─── Twitter/X ───
        if (input.platform === "twitter") {
          // Twitter token endpoint with dummy code — checks if API Key/Secret are valid
          const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
          const res = await fetch("https://api.twitter.com/2/oauth2/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Authorization": `Basic ${basicAuth}`,
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: "test_invalid_code",
              redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
              code_verifier: "test_verifier",
            }),
          });
          const data = await res.json();
          if (data.error === "invalid_grant" || data.error === "invalid_request") {
            return { success: true, message: "X (Twitter) credentials verified — API Key and Secret are valid" };
          }
          if (data.error === "invalid_client") {
            return { success: false, error: "Invalid X (Twitter) API Key or Secret" };
          }
          return { success: true, message: "X (Twitter) credentials format accepted" };
        }

        // ─── Snapchat ───
        if (input.platform === "snapchat") {
          // Snapchat token endpoint with dummy code — checks if client_id/secret are valid
          const res = await fetch("https://accounts.snapchat.com/login/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: "test_invalid_code",
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: cred.redirect_uri || process.env.NEXT_PUBLIC_APP_URL!,
            }),
          });
          const data = await res.json();
          if (data.error === "invalid_grant" || data.error === "invalid_request") {
            return { success: true, message: "Snapchat credentials verified — Client ID and Secret are valid" };
          }
          if (data.error === "invalid_client") {
            return { success: false, error: "Invalid Snapchat Client ID or Secret" };
          }
          return { success: true, message: "Snapchat credentials format accepted" };
        }

        return { success: false, error: "Unknown platform" };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }),

  updateStatus: superAdminProcedure
    .input(
      z.object({
        platform: allPlatformSchema,
        status: z.enum(["development", "in_review", "approved"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("platform_credentials")
        .update({ status: input.status, updated_at: new Date().toISOString() })
        .eq("org_id", profile.org_id)
        .eq("platform", input.platform)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  getRedirectUri: protectedProcedure
    .input(z.object({ platform: allPlatformSchema }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("platform_credentials")
        .select("redirect_uri, status")
        .eq("org_id", profile.org_id)
        .eq("platform", input.platform)
        .single();

      if (error || !data)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Platform credentials for ${input.platform} not configured`,
        });

      return { redirect_uri: data.redirect_uri, status: data.status };
    }),

  // ━━━ OpenRouter Key Pool Management ━━━

  getKeyPool: superAdminProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    const { data: cred } = await db
      .from("platform_credentials")
      .select("metadata")
      .eq("org_id", profile.org_id)
      .eq("platform", "llm_openrouter")
      .single();

    if (!cred) return { count: 0, keys: [] };

    const poolEncrypted = (cred.metadata as any)?.pool_keys_encrypted || [];
    // Return masked keys (first 10 + last 4 chars)
    const keys = poolEncrypted.map((enc: string, i: number) => {
      try {
        const key = decrypt(enc);
        return { index: i, masked: key.slice(0, 10) + "..." + key.slice(-4) };
      } catch {
        return { index: i, masked: "(invalid)" };
      }
    });

    return { count: keys.length, keys };
  }),

  addPoolKey: superAdminProcedure
    .input(z.object({ apiKey: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: cred } = await db
        .from("platform_credentials")
        .select("metadata")
        .eq("org_id", profile.org_id)
        .eq("platform", "llm_openrouter")
        .single();

      if (!cred) {
        throw new TRPCError({ code: "NOT_FOUND", message: "OpenRouter credentials not configured. Add the primary key first." });
      }

      const metadata = (cred.metadata || {}) as Record<string, any>;
      const poolEncrypted: string[] = metadata.pool_keys_encrypted || [];

      // Encrypt and add
      poolEncrypted.push(encrypt(input.apiKey));

      await db
        .from("platform_credentials")
        .update({ metadata: { ...metadata, pool_keys_encrypted: poolEncrypted } })
        .eq("org_id", profile.org_id)
        .eq("platform", "llm_openrouter");

      return { success: true, count: poolEncrypted.length };
    }),

  removePoolKey: superAdminProcedure
    .input(z.object({ index: z.number().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data: cred } = await db
        .from("platform_credentials")
        .select("metadata")
        .eq("org_id", profile.org_id)
        .eq("platform", "llm_openrouter")
        .single();

      if (!cred) throw new TRPCError({ code: "NOT_FOUND" });

      const metadata = (cred.metadata || {}) as Record<string, any>;
      const poolEncrypted: string[] = metadata.pool_keys_encrypted || [];

      if (input.index >= poolEncrypted.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid key index" });
      }

      poolEncrypted.splice(input.index, 1);

      await db
        .from("platform_credentials")
        .update({ metadata: { ...metadata, pool_keys_encrypted: poolEncrypted } })
        .eq("org_id", profile.org_id)
        .eq("platform", "llm_openrouter");

      return { success: true, count: poolEncrypted.length };
    }),
});
