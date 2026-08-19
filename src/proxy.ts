import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Exclude `/api/*` — API routes authenticate themselves (via getUser), and
  // running the session middleware on body-carrying POSTs (e.g. /api/upload
  // multipart) corrupts the request body → "Failed to parse body as FormData".
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
