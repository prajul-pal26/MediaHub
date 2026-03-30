import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/supabase/db";
import { createHash } from "crypto";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ valid: false, error: "Missing token" }, { status: 400 });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const db = getDb();

  const { data: invitation } = await db
    .from("invitations")
    .select("id, email, role, status, expires_at")
    .eq("token_hash", tokenHash)
    .eq("status", "pending")
    .single();

  if (!invitation) {
    return NextResponse.json({ valid: false, error: "Invalid or expired invitation" });
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return NextResponse.json({ valid: false, error: "This invitation has expired" });
  }

  return NextResponse.json({
    valid: true,
    email: invitation.email,
    role: invitation.role,
  });
}
