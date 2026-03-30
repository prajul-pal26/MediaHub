import { NextRequest, NextResponse } from "next/server";
import { refreshExpiringDriveTokens } from "@/server/queue/cron/token-refresh";

export async function GET(request: NextRequest) {
  // Auth: require CRON_SECRET to prevent unauthorized cron triggers
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await refreshExpiringDriveTokens();
  return NextResponse.json(result);
}
