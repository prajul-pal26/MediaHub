import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    BROWSER_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
      global: { fetch: serverFetch },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  // Public marketing routes — reachable without authentication.
  // NOTE: use exact "/" (startsWith("/") would match everything).
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/instagram") ||
    pathname.startsWith("/facebook") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/videos") ||
    pathname.startsWith("/callback/auth");

  // OPEN-STUDIO MODE: instead of sending logged-out visitors to /login, route them
  // through the auto-login (/api/studio-enter), which signs them in as the local
  // admin and drops them straight into the studio. The login page + all auth code
  // are preserved (still reachable at /login) for when real auth is switched on later.
  if (!user && !isPublicRoute) {
    const dest = pathname + (request.nextUrl.search || "");
    const url = request.nextUrl.clone();
    url.pathname = "/api/studio-enter";
    url.search = "";
    url.searchParams.set("next", dest);
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from auth pages
  if (
    user &&
    (request.nextUrl.pathname.startsWith("/login") ||
      request.nextUrl.pathname.startsWith("/signup"))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/library";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
