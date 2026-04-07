import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Server-side uses SUPABASE_INTERNAL_URL (Docker internal) if available, falls back to NEXT_PUBLIC_SUPABASE_URL
const serverSupabaseUrl = process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    serverSupabaseUrl,
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
    }
  );
}

// Singleton service role client — bypasses RLS
let _serviceClient: ReturnType<typeof createClient> | null = null;

export function createServiceRoleClient() {
  if (!_serviceClient) {
    _serviceClient = createClient(
      serverSupabaseUrl,
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
