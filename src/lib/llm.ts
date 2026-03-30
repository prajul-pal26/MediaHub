import { getDb } from "@/lib/supabase/db";
import { decrypt } from "@/lib/encryption";

// ─── Provider Registry ───

interface LLMProvider {
  key: string;
  label: string;
  baseUrl: string;
  headers: (apiKey: string) => Record<string, string>;
  defaultModel: string;
  models: { id: string; label: string }[];
}

export const LLM_PROVIDERS: Record<string, LLMProvider> = {
  openrouter: {
    key: "openrouter",
    label: "OpenRouter (300+ models)",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: (apiKey) => ({
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "",
      "X-Title": "MediaHub Chat",
    }),
    defaultModel: "anthropic/claude-sonnet-4-6",
    models: [
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
      { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest Claude)" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "deepseek/deepseek-chat-v3", label: "DeepSeek V3 (cheapest)" },
      { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (open source)" },
    ],
  },
  anthropic: {
    key: "anthropic",
    label: "Anthropic (Claude direct)",
    baseUrl: "https://api.anthropic.com/v1",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    defaultModel: "claude-sonnet-4-6-20250514",
    models: [
      { id: "claude-sonnet-4-6-20250514", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  openai: {
    key: "openai",
    label: "OpenAI (GPT)",
    baseUrl: "https://api.openai.com/v1",
    headers: (apiKey) => ({
      "Authorization": `Bearer ${apiKey}`,
    }),
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini (cheapest)" },
    ],
  },
  groq: {
    key: "groq",
    label: "Groq (fast inference)",
    baseUrl: "https://api.groq.com/openai/v1",
    headers: (apiKey) => ({
      "Authorization": `Bearer ${apiKey}`,
    }),
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
    ],
  },
  custom: {
    key: "custom",
    label: "Custom (any OpenAI-compatible API)",
    baseUrl: "",
    headers: (apiKey) => ({
      "Authorization": `Bearer ${apiKey}`,
    }),
    defaultModel: "",
    models: [],
  },
};

// ─── Config ───

export interface LLMConfig {
  configured: boolean;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  /** ID of the llm_configurations row used (if multi-level) */
  configId?: string;
  /** Which scope was resolved: org, brand, or user */
  resolvedScope?: "org" | "brand" | "user";
}

/**
 * Resolve LLM config using the multi-level hierarchy: user > brand > org.
 * Returns null if no config is found through the new system.
 */
export async function resolveLlmConfig(
  userId: string,
  orgId: string,
  brandId?: string | null
): Promise<LLMConfig | null> {
  const db = getDb();

  // 1. Check user's personal config
  const { data: userConfig } = await db
    .from("llm_configurations")
    .select("*")
    .eq("user_id", userId)
    .eq("scope", "user")
    .eq("is_active", true)
    .single();

  if (userConfig) {
    return configRowToLLMConfig(userConfig, "user");
  }

  // 2. Check brand access — uses the provider assigned to this brand via platform_credentials
  if (brandId) {
    const { data: brandAccess } = await db
      .from("llm_brand_access")
      .select("*")
      .eq("brand_id", brandId)
      .eq("is_active", true)
      .single();

    if (brandAccess?.provider) {
      const { data: cred } = await db
        .from("platform_credentials")
        .select("*")
        .eq("org_id", orgId)
        .eq("platform", brandAccess.provider)
        .single();

      if (cred) {
        const apiKey = decrypt(cred.client_id_encrypted);
        const providerKey = cred.metadata?.provider || brandAccess.provider.replace("llm_", "") || "openrouter";
        const provider = LLM_PROVIDERS[providerKey] || LLM_PROVIDERS.openrouter;
        return {
          configured: true,
          provider: providerKey,
          apiKey,
          model: cred.metadata?.default_model || provider.defaultModel,
          baseUrl: cred.metadata?.custom_base_url || provider.baseUrl,
          headers: provider.headers(apiKey),
          resolvedScope: "brand" as const,
        };
      }
    }
  }

  // 3. No brand or brand has no access — check for org-level (admins would call getLLMConfig directly)
  const { data: orgConfig } = await db
    .from("llm_configurations")
    .select("*")
    .eq("org_id", orgId)
    .eq("scope", "org")
    .eq("is_active", true)
    .single();

  if (orgConfig) {
    return configRowToLLMConfig(orgConfig, "org");
  }

  return null;
}

function configRowToLLMConfig(
  row: any,
  scope: "org" | "brand" | "user"
): LLMConfig {
  const apiKey = decrypt(row.api_key_encrypted);
  const providerKey = row.provider || "openrouter";
  const provider = LLM_PROVIDERS[providerKey] || LLM_PROVIDERS.openrouter;
  const baseUrl = row.base_url || provider.baseUrl;

  return {
    configured: true,
    provider: providerKey,
    apiKey,
    model: row.default_model || provider.defaultModel,
    baseUrl,
    headers: provider.headers(apiKey),
    configId: row.id,
    resolvedScope: scope,
  };
}

/**
 * Log LLM usage to the llm_usage_logs table.
 */
export async function logLlmUsage(params: {
  orgId: string;
  brandId?: string | null;
  userId: string;
  configId?: string;
  scopeUsed?: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costEstimate?: number;
}): Promise<void> {
  try {
    const db = getDb();
    await db.from("llm_usage_logs").insert({
      org_id: params.orgId,
      brand_id: params.brandId || null,
      user_id: params.userId,
      config_id: params.configId || null,
      scope_used: params.scopeUsed || null,
      provider: params.provider,
      model: params.model || null,
      input_tokens: params.inputTokens || 0,
      output_tokens: params.outputTokens || 0,
      total_tokens: params.totalTokens || 0,
      cost_estimate: params.costEstimate || 0,
    });
  } catch {
    // Usage logging should never break the main flow
    console.error("Failed to log LLM usage");
  }
}

/**
 * Check whether a user still has remaining quota.
 * Returns { allowed: true } if no limits are set.
 */
export async function checkLlmQuota(
  orgId: string,
  userId: string,
  brandId?: string | null
): Promise<{ allowed: boolean; reason?: string }> {
  const db = getDb();

  // Find the most specific limit: user > brand
  let limits: any = null;

  const { data: userLimits } = await db
    .from("llm_limits")
    .select("*")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .single();

  if (userLimits) {
    limits = userLimits;
  } else if (brandId) {
    const { data: brandLimits } = await db
      .from("llm_limits")
      .select("*")
      .eq("org_id", orgId)
      .eq("brand_id", brandId)
      .eq("is_active", true)
      .single();
    if (brandLimits) limits = brandLimits;
  }

  if (!limits) return { allowed: true };

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: todayLogs } = await db
    .from("llm_usage_logs")
    .select("id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .gte("created_at", today + "T00:00:00.000Z");

  const { data: monthLogs } = await db
    .from("llm_usage_logs")
    .select("id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .gte("created_at", monthStart.toISOString());

  const dailyUsed = todayLogs?.length ?? 0;
  const monthlyUsed = monthLogs?.length ?? 0;

  if (dailyUsed >= limits.daily_requests) {
    return { allowed: false, reason: "Daily request limit reached" };
  }
  if (monthlyUsed >= limits.monthly_requests) {
    return { allowed: false, reason: "Monthly request limit reached" };
  }

  return { allowed: true };
}

export async function getLLMConfig(orgId?: string): Promise<LLMConfig> {
  const fallback: LLMConfig = {
    configured: false,
    provider: "openrouter",
    apiKey: "",
    model: "anthropic/claude-sonnet-4-6",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: {},
  };

  // Check env fallback
  if (process.env.OPENROUTER_API_KEY) {
    const provider = LLM_PROVIDERS.openrouter;
    return {
      configured: true,
      provider: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || provider.defaultModel,
      baseUrl: provider.baseUrl,
      headers: provider.headers(process.env.OPENROUTER_API_KEY),
    };
  }

  try {
    const db = getDb();
    let query = db.from("platform_credentials").select("client_id_encrypted, metadata").eq("platform", "llm_provider");
    if (orgId) query = query.eq("org_id", orgId);
    const { data } = await query.limit(1).single();

    if (data?.client_id_encrypted) {
      const apiKey = decrypt(data.client_id_encrypted);
      if (apiKey && apiKey !== "none") {
        const meta = (data.metadata || {}) as Record<string, string>;
        const providerKey = meta.provider || "openrouter";
        const provider = LLM_PROVIDERS[providerKey] || LLM_PROVIDERS.openrouter;
        const baseUrl = meta.custom_base_url || provider.baseUrl;

        return {
          configured: true,
          provider: providerKey,
          apiKey,
          model: meta.default_model || provider.defaultModel,
          baseUrl,
          headers: provider.headers(apiKey),
        };
      }
    }
  } catch {}

  return fallback;
}

// ─── Unified Chat Completion ───

export async function chatCompletion(params: {
  systemPrompt: string;
  messages: Array<any>;
  tools?: Array<any>;
  orgId?: string;
  /** When provided, use multi-level config resolution (user > brand > org) */
  userId?: string;
  brandId?: string | null;
  /** Override config entirely (skips resolution) */
  configOverride?: LLMConfig;
}): Promise<any> {
  let config: LLMConfig;

  if (params.configOverride) {
    config = params.configOverride;
  } else if (params.userId && params.orgId) {
    // New multi-level path: try llm_configurations first, fall back to platform_credentials
    const resolved = await resolveLlmConfig(
      params.userId,
      params.orgId,
      params.brandId
    );
    config = resolved || (await getLLMConfig(params.orgId));
  } else {
    // Legacy path: platform_credentials only
    config = await getLLMConfig(params.orgId);
  }

  if (!config.configured) {
    throw new Error("LLM not configured. Ask your admin to set up AI Chat in Settings → Platform Credentials.");
  }

  // Quota check when using multi-level path
  if (params.userId && params.orgId) {
    const quota = await checkLlmQuota(
      params.orgId,
      params.userId,
      params.brandId
    );
    if (!quota.allowed) {
      throw new Error(quota.reason || "LLM usage limit reached");
    }
  }

  // Anthropic uses a different API format
  let result: any;
  if (config.provider === "anthropic") {
    result = await callAnthropic(config, params);
  } else {
    // OpenAI-compatible (OpenRouter, OpenAI, Groq, custom)
    result = await callOpenAICompatible(config, params);
  }

  // Log usage (non-blocking)
  if (params.userId && params.orgId) {
    const usage = result.usage || {};
    logLlmUsage({
      orgId: params.orgId,
      brandId: params.brandId || undefined,
      userId: params.userId,
      configId: config.configId,
      scopeUsed: config.resolvedScope,
      provider: config.provider,
      model: config.model,
      inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
      outputTokens: usage.output_tokens || usage.completion_tokens || 0,
      totalTokens:
        usage.total_tokens ||
        (usage.input_tokens || usage.prompt_tokens || 0) +
          (usage.output_tokens || usage.completion_tokens || 0),
      costEstimate: 0, // Cost estimation could be added later per-model
    }).catch(() => {}); // fire and forget
  }

  return result;
}

// ─── OpenAI-compatible call (OpenRouter, OpenAI, Groq, custom) ───

async function callOpenAICompatible(config: LLMConfig, params: any): Promise<any> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: params.systemPrompt },
        ...params.messages,
      ],
      tools: params.tools?.length ? params.tools : undefined,
      tool_choice: params.tools?.length ? "auto" : undefined,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`LLM error (${config.provider}): ${err.error?.message || response.statusText}`);
  }

  return response.json();
}

// ─── Anthropic native call (converts to/from OpenAI format) ───

async function callAnthropic(config: LLMConfig, params: any): Promise<any> {
  // Convert OpenAI messages to Anthropic format
  const anthropicMessages = params.messages.map((m: any) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      };
    }
    if (m.tool_calls) {
      return {
        role: "assistant",
        content: m.tool_calls.map((tc: any) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        })),
      };
    }
    return { role: m.role, content: m.content };
  });

  // Convert OpenAI tools to Anthropic format
  const anthropicTools = (params.tools || []).map((t: any) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: params.systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length ? anthropicTools : undefined,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic error: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();

  // Convert Anthropic response to OpenAI format (so chat-service works with both)
  const toolCalls = data.content
    ?.filter((c: any) => c.type === "tool_use")
    .map((c: any, i: number) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.input) },
    }));

  const textContent = data.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";

  return {
    choices: [{
      message: {
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls?.length ? toolCalls : undefined,
      },
      finish_reason: toolCalls?.length ? "tool_calls" : "stop",
    }],
    model: data.model,
    usage: data.usage,
  };
}
