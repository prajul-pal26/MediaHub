import { getDb } from "@/lib/supabase/db";

export async function logAudit(params: {
  orgId: string;
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  source?: "click" | "chat" | "api";
  metadata?: Record<string, unknown>;
}) {
  try {
    const db = getDb();
    await db.from("audit_log").insert({
      org_id: params.orgId,
      user_id: params.userId || null,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId || null,
      source: params.source || "click",
      metadata: params.metadata || {},
    });
  } catch {
    // Audit logging should never block the main operation
  }
}
