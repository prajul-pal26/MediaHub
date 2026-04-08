import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Browser-facing URL (used for cookie name consistency — must match client.ts)
const BROWSER_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// Internal URL for actual HTTP requests (Docker: kong:8000, local: same as browser)
const INTERNAL_SUPABASE_URL = process.env.SUPABASE_URL || BROWSER_SUPABASE_URL;

// Custom fetch that rewrites browser URL → internal Docker URL for server-side requests
const serverFetch: typeof globalThis.fetch = INTERNAL_SUPABASE_URL !== BROWSER_SUPABASE_URL
  ? (input, init) => {
      const url = typeof input === "string"
        ? input.replace(BROWSER_SUPABASE_URL, INTERNAL_SUPABASE_URL)
        : input instanceof URL
          ? new URL(input.toString().replace(BROWSER_SUPABASE_URL, INTERNAL_SUPABASE_URL))
          : input;
      return globalThis.fetch(url, init);
    }
  : globalThis.fetch;

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    BROWSER_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as CookieOptions)
            );
          } catch {
            // Ignore errors in Server Components where cookies can't be set
          }
        },
      },
      global: { fetch: serverFetch },
    }
  );
}

// Singleton service role client — bypasses RLS, no cookies needed
let _serviceClient: ReturnType<typeof createClient> | null = null;

export function createServiceRoleClient() {
  if (!_serviceClient) {
    _serviceClient = createClient(
      INTERNAL_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return _serviceClient;
}
