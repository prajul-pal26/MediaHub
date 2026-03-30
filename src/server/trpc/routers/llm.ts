import { z } from "zod";
import {
  router,
  protectedProcedure,
  superAdminProcedure,
} from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import { TRPCError } from "@trpc/server";

// ─── Zod Schemas ───

const providerSchema = z.enum([
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "custom",
]);

const scopeSchema = z.enum(["org", "brand", "user"]);

// ─── Router ───

export const llmRouter = router({
  // ━━━ Config Management ━━━

  /** List configs — admins see all org configs, users see only their own */
  listConfigs: protectedProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;
    const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);

    let query = db
      .from("llm_configurations")
      .select("*")
      .eq("org_id", profile.org_id);

    if (!isAdmin) {
      query = query.eq("user_id", profile.id);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });
    if (error)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message,
      });

    return (data || []).map((c: any) => ({
      id: c.id,
      scope: c.scope,
      org_id: c.org_id,
      brand_id: c.brand_id,
      user_id: c.user_id,
      provider: c.provider,
      label: c.label,
      base_url: c.base_url,
      default_model: c.default_model,
      is_active: c.is_active,
      created_at: c.created_at,
      updated_at: c.updated_at,
      // Never expose the raw key — only a masked version
      api_key_masked: c.api_key_encrypted
        ? "••••••••" + decrypt(c.api_key_encrypted).slice(-4)
        : "",
    }));
  }),

  /** Create or update a config */
  upsertConfig: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(), // pass to update
        scope: scopeSchema,
        provider: providerSchema,
        label: z.string().min(1).max(100).default("Default"),
        api_key: z.string().min(1),
        base_url: z.string().url().optional().or(z.literal("")),
        default_model: z.string().optional(),
        brand_id: z.string().uuid().optional(),
        is_active: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);

      // Scope validation
      if (input.scope === "org" && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can manage org-level LLM configs",
        });
      }
      if (input.scope === "brand" && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can manage brand-level LLM configs",
        });
      }

      const row: Record<string, unknown> = {
        org_id: profile.org_id,
        scope: input.scope,
        provider: input.provider,
        label: input.label,
        api_key_encrypted: encrypt(input.api_key),
        base_url: input.base_url || null,
        default_model: input.default_model || null,
        is_active: input.is_active,
        updated_at: new Date().toISOString(),
      };

      if (input.scope === "user") {
        row.user_id = profile.id;
        row.brand_id = null;
      } else if (input.scope === "brand") {
        if (!input.brand_id) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "brand_id required for brand-scope config",
          });
        }
        row.brand_id = input.brand_id;
        row.user_id = null;
      } else {
        // org scope
        row.brand_id = null;
        row.user_id = null;
      }

      let result;
      if (input.id) {
        // Update existing
        const { data, error } = await db
          .from("llm_configurations")
          .update(row)
          .eq("id", input.id)
          .eq("org_id", profile.org_id)
          .select()
          .single();
        if (error)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          });
        result = data;
      } else {
        // Insert new
        row.created_at = new Date().toISOString();
        const { data, error } = await db
          .from("llm_configurations")
          .upsert(row, {
            onConflict: "org_id,scope,brand_id,user_id,provider",
          })
          .select()
          .single();
        if (error)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          });
        result = data;
      }

      return result;
    }),

  /** Delete a config */
  deleteConfig: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);

      let query = db
        .from("llm_configurations")
        .delete()
        .eq("id", input.id)
        .eq("org_id", profile.org_id);

      // Non-admins can only delete their own personal config
      if (!isAdmin) {
        query = query.eq("user_id", profile.id);
      }

      const { error } = await query;
      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      return { success: true };
    }),

  /** Resolve the active config for the current user (user > brand > org) */
  getActiveConfig: protectedProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    // 1. Check user's personal config
    const { data: userConfig } = await db
      .from("llm_configurations")
      .select("*")
      .eq("user_id", profile.id)
      .eq("scope", "user")
      .eq("is_active", true)
      .single();
    if (userConfig) return { config: sanitizeConfig(userConfig), scope: "user" as const };

    // 2. Check brand access — uses the provider assigned to this brand
    if (profile.brand_id) {
      const { data: brandAccess } = await db
        .from("llm_brand_access")
        .select("*")
        .eq("brand_id", profile.brand_id)
        .eq("is_active", true)
        .single();
      if (brandAccess?.provider) {
        // Look up the actual credentials from platform_credentials
        const { data: cred } = await db
          .from("platform_credentials")
          .select("*")
          .eq("org_id", profile.org_id)
          .eq("platform", brandAccess.provider)
          .single();
        if (cred) {
          return {
            config: {
              provider: brandAccess.provider,
              api_key_masked: "••••••••" + decrypt(cred.client_id_encrypted).slice(-4),
              default_model: cred.metadata?.default_model || null,
              is_active: true,
            },
            scope: "brand" as const,
          };
        }
      }
    }

    // 3. Check if user is admin (always has org access)
    if (["super_admin", "agency_admin"].includes(profile.role)) {
      const { data: orgConfig } = await db
        .from("llm_configurations")
        .select("*")
        .eq("org_id", profile.org_id)
        .eq("scope", "org")
        .eq("is_active", true)
        .single();
      if (orgConfig) return { config: sanitizeConfig(orgConfig), scope: "org" as const };
    }

    return null; // No LLM access
  }),

  // ━━━ Brand Access ━━━

  /** List which brands have LLM access */
  listBrandAccess: superAdminProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    const { data, error } = await db
      .from("llm_brand_access")
      .select("id, org_id, brand_id, provider, granted_by, is_active, created_at")
      .eq("org_id", profile.org_id)
      .order("created_at", { ascending: false });

    if (error)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message,
      });

    return data || [];
  }),

  /** Grant a brand access to a specific LLM provider from platform_credentials */
  grantBrandAccess: superAdminProcedure
    .input(
      z.object({
        brand_id: z.string().uuid(),
        provider: z.string().min(1), // e.g. 'llm_openrouter', 'llm_anthropic'
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      console.log("[llm.grantBrandAccess] Input:", JSON.stringify(input));
      console.log("[llm.grantBrandAccess] Profile org_id:", profile.org_id, "user_id:", profile.id);

      // Verify the provider is configured in platform_credentials
      const { data: cred, error: credErr } = await db
        .from("platform_credentials")
        .select("id")
        .eq("org_id", profile.org_id)
        .eq("platform", input.provider)
        .single();

      console.log("[llm.grantBrandAccess] Cred lookup:", { cred, credErr: credErr?.message });

      if (!cred) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `LLM provider '${input.provider}' not configured in Platform Credentials`,
        });
      }

      // Check if brand already has an access record
      const { data: existing, error: existErr } = await db
        .from("llm_brand_access")
        .select("id")
        .eq("org_id", profile.org_id)
        .eq("brand_id", input.brand_id)
        .maybeSingle();

      console.log("[llm.grantBrandAccess] Existing:", { existing, existErr: existErr?.message });

      if (existing) {
        const { error } = await db
          .from("llm_brand_access")
          .update({
            provider: input.provider,
            granted_by: profile.id,
            is_active: true,
          })
          .eq("id", existing.id);

        if (error) {
          console.error("[llm.grantBrandAccess] Update error:", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
        }
      } else {
        const { error } = await db
          .from("llm_brand_access")
          .insert({
            org_id: profile.org_id,
            brand_id: input.brand_id,
            provider: input.provider,
            granted_by: profile.id,
            is_active: true,
          });

        if (error) {
          console.error("[llm.grantBrandAccess] Insert error:", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
        }
      }

      return { success: true };
    }),

  /** Revoke brand's LLM access */
  revokeBrandAccess: superAdminProcedure
    .input(z.object({ brand_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("llm_brand_access")
        .update({ is_active: false })
        .eq("org_id", profile.org_id)
        .eq("brand_id", input.brand_id)
        .select()
        .single();

      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      return data;
    }),

  // ━━━ Limits ━━━

  /** Get limits for a brand/user or self */
  getLimits: protectedProcedure
    .input(
      z
        .object({
          brand_id: z.string().uuid().optional(),
          user_id: z.string().uuid().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);

      let query = db
        .from("llm_limits")
        .select("*")
        .eq("org_id", profile.org_id)
        .eq("is_active", true);

      if (input?.brand_id && isAdmin) {
        query = query.eq("brand_id", input.brand_id);
      } else if (input?.user_id && isAdmin) {
        query = query.eq("user_id", input.user_id);
      } else if (!isAdmin) {
        // Non-admins: return their own limits (user-level or brand-level)
        query = query.or(
          `user_id.eq.${profile.id},brand_id.eq.${profile.brand_id || "00000000-0000-0000-0000-000000000000"}`
        );
      }

      const { data, error } = await query;
      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      return data || [];
    }),

  /** Set limits for a brand or user (super_admin only) */
  setLimits: superAdminProcedure
    .input(
      z.object({
        brand_id: z.string().uuid().optional(),
        user_id: z.string().uuid().optional(),
        daily_requests: z.number().int().min(0).default(100),
        monthly_requests: z.number().int().min(0).default(3000),
        max_tokens_per_request: z.number().int().min(0).default(4096),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      if (!input.brand_id && !input.user_id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Must specify brand_id or user_id",
        });
      }

      const row: Record<string, unknown> = {
        org_id: profile.org_id,
        brand_id: input.brand_id || null,
        user_id: input.user_id || null,
        daily_requests: input.daily_requests,
        monthly_requests: input.monthly_requests,
        max_tokens_per_request: input.max_tokens_per_request,
        is_active: true,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await db
        .from("llm_limits")
        .upsert(row, {
          onConflict: "org_id,brand_id,user_id",
        })
        .select()
        .single();

      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      return data;
    }),

  /** Usage summary — admins see per brand/user, users see own */
  getUsageSummary: protectedProcedure
    .input(
      z
        .object({
          brand_id: z.string().uuid().optional(),
          user_id: z.string().uuid().optional(),
          days: z.number().int().min(1).max(90).default(30),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const isAdmin = ["super_admin", "agency_admin"].includes(profile.role);
      const days = input?.days ?? 30;

      const since = new Date();
      since.setDate(since.getDate() - days);

      let query = db
        .from("llm_usage_logs")
        .select("*")
        .eq("org_id", profile.org_id)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false });

      if (!isAdmin) {
        query = query.eq("user_id", profile.id);
      } else {
        if (input?.brand_id) query = query.eq("brand_id", input.brand_id);
        if (input?.user_id) query = query.eq("user_id", input.user_id);
      }

      const { data, error } = await query;
      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      const logs = data || [];

      // Compute aggregates
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = new Date().toISOString().slice(0, 7); // YYYY-MM

      const dailyCount = logs.filter(
        (l: any) => l.created_at?.slice(0, 10) === today
      ).length;
      const monthlyCount = logs.filter(
        (l: any) => l.created_at?.slice(0, 7) === monthStart
      ).length;
      const totalTokens = logs.reduce(
        (sum: number, l: any) => sum + (l.total_tokens || 0),
        0
      );
      const totalCost = logs.reduce(
        (sum: number, l: any) => sum + parseFloat(l.cost_estimate || "0"),
        0
      );

      return {
        logs: logs.slice(0, 100), // return latest 100 entries
        summary: {
          daily_requests: dailyCount,
          monthly_requests: monthlyCount,
          total_tokens: totalTokens,
          total_cost: Math.round(totalCost * 1000000) / 1000000,
          period_days: days,
        },
      };
    }),

  // ━━━ Internal: Quota Check & Usage Logging ━━━

  /** Check if user/brand still has remaining quota */
  checkQuota: protectedProcedure
    .input(
      z.object({
        tokens_requested: z.number().int().optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Look up limits — user-level first, then brand-level
      let limits: any = null;

      const { data: userLimits } = await db
        .from("llm_limits")
        .select("*")
        .eq("org_id", profile.org_id)
        .eq("user_id", profile.id)
        .eq("is_active", true)
        .single();

      if (userLimits) {
        limits = userLimits;
      } else if (profile.brand_id) {
        const { data: brandLimits } = await db
          .from("llm_limits")
          .select("*")
          .eq("org_id", profile.org_id)
          .eq("brand_id", profile.brand_id)
          .eq("is_active", true)
          .single();
        if (brandLimits) limits = brandLimits;
      }

      // No limits set — allow by default
      if (!limits) {
        return {
          allowed: true,
          daily_remaining: null,
          monthly_remaining: null,
          max_tokens_per_request: null,
        };
      }

      // Count today's and this month's usage
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const { data: todayLogs } = await db
        .from("llm_usage_logs")
        .select("id")
        .eq("org_id", profile.org_id)
        .eq("user_id", profile.id)
        .gte("created_at", today + "T00:00:00.000Z");

      const { data: monthLogs } = await db
        .from("llm_usage_logs")
        .select("id")
        .eq("org_id", profile.org_id)
        .eq("user_id", profile.id)
        .gte("created_at", monthStart.toISOString());

      const dailyUsed = todayLogs?.length ?? 0;
      const monthlyUsed = monthLogs?.length ?? 0;
      const dailyRemaining = Math.max(0, limits.daily_requests - dailyUsed);
      const monthlyRemaining = Math.max(
        0,
        limits.monthly_requests - monthlyUsed
      );

      const tokensOk =
        !input?.tokens_requested ||
        input.tokens_requested <= limits.max_tokens_per_request;

      return {
        allowed: dailyRemaining > 0 && monthlyRemaining > 0 && tokensOk,
        daily_remaining: dailyRemaining,
        monthly_remaining: monthlyRemaining,
        max_tokens_per_request: limits.max_tokens_per_request,
      };
    }),

  /** Log a usage record after an LLM call */
  logUsage: protectedProcedure
    .input(
      z.object({
        config_id: z.string().uuid().optional(),
        scope_used: scopeSchema.optional(),
        provider: z.string(),
        model: z.string().optional(),
        input_tokens: z.number().int().default(0),
        output_tokens: z.number().int().default(0),
        total_tokens: z.number().int().default(0),
        cost_estimate: z.number().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { error } = await db.from("llm_usage_logs").insert({
        org_id: profile.org_id,
        brand_id: profile.brand_id || null,
        user_id: profile.id,
        config_id: input.config_id || null,
        scope_used: input.scope_used || null,
        provider: input.provider,
        model: input.model || null,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        total_tokens: input.total_tokens,
        cost_estimate: input.cost_estimate,
      });

      if (error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });

      return { success: true };
    }),
});

// ─── Helpers ───

function sanitizeConfig(config: any) {
  return {
    id: config.id,
    scope: config.scope,
    org_id: config.org_id,
    brand_id: config.brand_id,
    user_id: config.user_id,
    provider: config.provider,
    label: config.label,
    base_url: config.base_url,
    default_model: config.default_model,
    is_active: config.is_active,
  };
}
