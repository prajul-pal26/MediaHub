/**
 * Centralized configuration — single source for all environment-dependent values.
 *
 * In production (NODE_ENV === "production"), missing required vars throw immediately.
 * In development, sensible localhost defaults are used.
 */

const isProd = process.env.NODE_ENV === "production";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (isProd) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    console.warn(`[config] ${name} not set — using development default`);
  }
  return value || "";
}

/** Require in production, return fallback in development */
function env(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return devDefault;
}

// ─── Exported Config ───

export const config = {
  /** The public-facing app URL (e.g., https://app.mediahub.io or https://localhost:3443) */
  appUrl: env("NEXT_PUBLIC_APP_URL", "https://localhost:3443"),

  /** Supabase PostgreSQL URL */
  supabaseUrl: env("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321"),

  /** Supabase anon key (public, safe for client) */
  supabaseAnonKey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY", ""),

  /** Supabase service role key (server-only, bypasses RLS) */
  supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY", ""),

  /** Redis connection string */
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),

  /** AES-256 encryption key for tokens (hex) */
  encryptionKey: required("TOKEN_ENCRYPTION_KEY"),

  /** Cron endpoint secret */
  cronSecret: process.env.CRON_SECRET || "",

  /** Whether we're in production */
  isProd,
};
