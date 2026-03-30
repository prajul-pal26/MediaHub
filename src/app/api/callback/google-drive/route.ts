import { NextRequest, NextResponse } from "next/server";
import { connectDrive } from "@/server/services/drive/client";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const error = searchParams.get("error");

  console.log("[google-drive callback] code:", code ? "yes" : "no", "state:", stateParam ? "yes" : "no", "error:", error);

  if (error) {
    console.log("[google-drive callback] OAuth error:", error);
    return NextResponse.redirect(
      new URL(`/accounts?drive_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code || !stateParam) {
    console.log("[google-drive callback] Missing code or state");
    return NextResponse.redirect(
      new URL("/accounts?drive_error=missing_params", request.url)
    );
  }

  let state: { brandId: string; orgId: string; from?: string };
  try {
    state = JSON.parse(stateParam);
  } catch {
    console.log("[google-drive callback] Invalid state JSON");
    return NextResponse.redirect(
      new URL("/accounts?drive_error=invalid_state", request.url)
    );
  }

  console.log("[google-drive callback] Connecting drive for brand:", state.brandId);

  try {
    const result = await connectDrive(state.brandId, state.orgId, code);
    console.log("[google-drive callback] Success! Email:", result.email);

    // Redirect based on where the user came from
    if (state.from === "brand-setup") {
      return NextResponse.redirect(
        new URL(
          `/brands/new?step=2&brandId=${state.brandId}&drive_connected=true`,
          request.url
        )
      );
    }

    // Default: redirect to accounts page
    return NextResponse.redirect(
      new URL(`/accounts?drive_connected=true&brand=${state.brandId}`, request.url)
    );
  } catch (e: any) {
    console.error("[google-drive callback] Error:", e.message);

    if (state.from === "brand-setup") {
      return NextResponse.redirect(
        new URL(
          `/brands/new?step=2&brandId=${state.brandId}&drive_error=${encodeURIComponent(e.message)}`,
          request.url
        )
      );
    }

    return NextResponse.redirect(
      new URL(`/accounts?drive_error=${encodeURIComponent(e.message)}`, request.url)
    );
  }
}
