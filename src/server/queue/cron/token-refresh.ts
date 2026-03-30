import { getDb } from "@/lib/supabase/db";
import { refreshTokenIfNeeded } from "@/server/services/drive/client";

const REFRESH_THRESHOLD_HOURS = 48;

/**
 * Proactively refresh Drive tokens that expire within 48 hours.
 * Run this on a cron schedule (e.g., every 6 hours via BullMQ or external cron).
 */
export async function refreshExpiringDriveTokens(): Promise<{
  checked: number;
  refreshed: number;
  failed: string[];
}> {
  const db = getDb();
  const thresholdDate = new Date(
    Date.now() + REFRESH_THRESHOLD_HOURS * 60 * 60 * 1000
  ).toISOString();

  // Find active connections with tokens expiring within threshold
  const { data: connections, error } = await db
    .from("drive_connections")
    .select("brand_id, token_expires_at, google_account_email")
    .eq("is_active", true)
    .not("refresh_token_encrypted", "is", null)
    .lt("token_expires_at", thresholdDate);

  if (error || !connections) {
    console.error("Failed to query expiring drive tokens:", error?.message);
    return { checked: 0, refreshed: 0, failed: [] };
  }

  const result = { checked: connections.length, refreshed: 0, failed: [] as string[] };

  for (const conn of connections) {
    const { data: brandData } = await db
      .from("brands")
      .select("org_id")
      .eq("id", conn.brand_id)
      .single();

    if (!brandData) {
      result.failed.push(`Brand ${conn.brand_id} not found`);
      continue;
    }

    const success = await refreshTokenIfNeeded(conn.brand_id, brandData.org_id);

    if (success) {
      result.refreshed++;
    } else {
      result.failed.push(`${conn.google_account_email} (brand: ${conn.brand_id})`);
    }
  }

  return result;
}
