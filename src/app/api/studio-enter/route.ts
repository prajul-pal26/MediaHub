import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

// LOCAL DEMO CONVENIENCE: "Enter the studio" signs the visitor straight into the
// dashboard as the local admin — no login screen. For a hosted deploy, replace
// this with a real sign-in flow (or gate it behind an env flag).
const BROWSER_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const INTERNAL_SUPABASE_URL = process.env.SUPABASE_URL || BROWSER_SUPABASE_URL;

const serverFetch: typeof globalThis.fetch =
  INTERNAL_SUPABASE_URL !== BROWSER_SUPABASE_URL
    ? (input, init) => {
        const url =
          typeof input === "string"
            ? input.replace(BROWSER_SUPABASE_URL, INTERNAL_SUPABASE_URL)
            : input instanceof URL
              ? new URL(input.toString().replace(BROWSER_SUPABASE_URL, INTERNAL_SUPABASE_URL))
              : input;
        return globalThis.fetch(url, init);
      }
    : globalThis.fetch;

// A RELATIVE Location — the browser resolves it against its own address
// (localhost:3010), avoiding the container's internal 0.0.0.0:3000 host and
// keeping the auth cookie on the right origin.
function redirectTo(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function GET(request: NextRequest) {
  // Land on the originally-requested page (?next=/settings…), falling back to /library.
  const nextParam = request.nextUrl.searchParams.get("next");
  const dest =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/library";
  const response = redirectTo(dest);

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
            response.cookies.set(name, value, options),
          );
        },
      },
      global: { fetch: serverFetch },
    },
  );

  const email = process.env.DEMO_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "admin@mediahub.local";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (serviceRoleKey) {
    const admin = createClient(INTERNAL_SUPABASE_URL, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: serverFetch },
    });
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

    const tokenHash = data?.properties?.hashed_token;
    if (!error && tokenHash) {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        type: "magiclink",
        token_hash: tokenHash,
      });
      if (!verifyError) return response;
    }
  }

  const password = process.env.DEMO_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin123";
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return redirectTo("/login");

  return response;
}
