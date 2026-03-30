import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * This route handles ONLY Supabase auth callbacks (Google SSO, magic links, password reset).
 * Social platform OAuth callbacks (YouTube, Instagram, LinkedIn) go to /api/callback/[platform]
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");

  // Supabase auth callback (Google SSO, magic link, password reset)
  if (platform === "auth") {
    const supabase = await createServerSupabaseClient();
    if (code) await supabase.auth.exchangeCodeForSession(code);
    return NextResponse.redirect(new URL("/library", request.url));
  }

  // Any other platform hitting this old route → redirect to the correct API route
  const queryString = request.nextUrl.search;
  return NextResponse.redirect(
    new URL(`/api/callback/${platform}${queryString}`, request.url)
  );
}
