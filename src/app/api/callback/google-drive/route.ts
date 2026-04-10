import { NextRequest, NextResponse } from "next/server";
import { connectDrive } from "@/server/services/drive/client";
import { verifyState } from "@/server/trpc/routers/social-accounts";
import { getDb } from "@/lib/supabase/db";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const error = searchParams.get("error");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.url;

  console.log("[google-drive callback] code:", code ? "yes" : "no", "state:", stateParam ? "yes" : "no", "error:", error);

  if (error) {
    console.log("[google-drive callback] OAuth error:", error);
    return NextResponse.redirect(
      new URL(`/accounts?drive_error=${encodeURIComponent(error)}`, baseUrl)
    );
  }

  if (!code || !stateParam) {
    console.log("[google-drive callback] Missing code or state");
    return NextResponse.redirect(
      new URL("/accounts?drive_error=missing_params", baseUrl)
    );
  }

  let state: { brandId: string; orgId: string; from?: string };
  try {
    state = verifyState(stateParam) as any;
  } catch {
    console.log("[google-drive callback] Invalid state signature");
    return NextResponse.redirect(
      new URL("/accounts?drive_error=invalid_state", baseUrl)
    );
  }

  console.log("[google-drive callback] Connecting drive for brand:", state.brandId);

  try {
    const result = await connectDrive(state.brandId, state.orgId, code);
    console.log("[google-drive callback] Success! Email:", result.email);

    // Update brand setup_status to active now that Drive is connected
    const db = getDb();
    await db
      .from("brands")
      .update({ setup_status: "active" })
      .eq("id", state.brandId)
      .eq("org_id", state.orgId);
    console.log("[google-drive callback] Brand setup_status set to active");

    // Redirect based on where the user came from
    if (state.from === "brand-setup") {
      return NextResponse.redirect(
        new URL(
          `/brands/new?step=2&brandId=${state.brandId}&drive_connected=true`,
          baseUrl
        )
      );
    }

    // Default: redirect to accounts page
    return NextResponse.redirect(
      new URL(`/accounts?drive_connected=true&brand=${state.brandId}`, baseUrl)
    );
  } catch (e: any) {
    console.error("[google-drive callback] Error:", e.message);

    if (state.from === "brand-setup") {
      return NextResponse.redirect(
        new URL(
          `/brands/new?step=2&brandId=${state.brandId}&drive_error=${encodeURIComponent(e.message)}`,
          baseUrl
        )
      );
    }

    return NextResponse.redirect(
      new URL(`/accounts?drive_error=${encodeURIComponent(e.message)}`, baseUrl)
    );
  }
}
