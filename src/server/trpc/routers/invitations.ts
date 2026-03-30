import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { TRPCError } from "@trpc/server";
import { logAudit } from "@/server/services/audit";
import { randomBytes, createHash } from "crypto";
import { sendInviteEmail, sendWelcomeEmail, getEmailConfig } from "@/lib/email";

const roleSchema = z.enum([
  "super_admin", "agency_admin", "agency_editor",
  "brand_owner", "brand_editor", "brand_viewer",
]);

export const invitationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    let query = db
      .from("invitations")
      .select("*")
      .eq("org_id", profile.org_id)
      .order("created_at", { ascending: false });

    if (profile.role === "brand_owner") {
      query = query.eq("brand_id", profile.brand_id);
    }

    const { data, error } = await query;
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    return data || [];
  }),

  // Check if email service is configured (for UI fallback banner)
  emailStatus: protectedProcedure.query(async () => {
    const config = await getEmailConfig();
    return { configured: config.configured };
  }),

  send: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: roleSchema,
        brandId: z.string().uuid().optional(),
        name: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Permission checks
      const canInvite = checkInvitePermission(profile.role, input.role);
      if (!canInvite) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Your role (${profile.role}) cannot invite ${input.role} users`,
        });
      }

      if (["brand_owner", "brand_editor", "brand_viewer"].includes(input.role) && !input.brandId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Brand ID required for brand-level roles" });
      }

      if (profile.role === "brand_owner" && input.brandId !== profile.brand_id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only invite users to your own brand" });
      }

      // Check for existing pending invitation
      const { data: existing } = await db
        .from("invitations")
        .select("id")
        .eq("email", input.email)
        .eq("org_id", profile.org_id)
        .eq("status", "pending")
        .single();

      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "An invitation is already pending for this email" });
      }

      // Generate invite token
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");

      const isAgencyRole = ["agency_admin", "agency_editor"].includes(input.role);
      const method = isAgencyRole ? "direct_add" : "email_invite";
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
      const inviteLink = `${appUrl}/signup?invite=${token}`;

      // Save invitation to DB
      const { data: invitation, error: invError } = await db
        .from("invitations")
        .insert({
          org_id: profile.org_id,
          email: input.email,
          role: input.role,
          brand_id: input.brandId || null,
          invited_by: profile.id,
          token_hash: tokenHash,
          method,
          status: "pending",
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (invError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: invError.message });

      // Get brand name for the email
      let brandName: string | undefined;
      if (input.brandId) {
        const { data: brand } = await db.from("brands").select("name").eq("id", input.brandId).single();
        brandName = brand?.name;
      }

      // Try sending email via Resend
      let emailSent = false;
      if (isAgencyRole) {
        // Direct add — send welcome email with signup link
        const result = await sendWelcomeEmail({
          to: input.email,
          name: input.name || input.email.split("@")[0],
          role: input.role,
          inviteLink,
          orgId: profile.org_id,
        });
        emailSent = result.success;
        if (!result.success) {
          console.warn("[invite] Welcome email failed:", result.error);
        }
      } else {
        // Email invite — send invite email with signup link
        const result = await sendInviteEmail({
          to: input.email,
          inviterName: profile.name || profile.email,
          role: input.role,
          brandName,
          inviteLink,
          orgId: profile.org_id,
        });
        emailSent = result.success;
        if (!result.success) {
          console.warn("[invite] Invite email failed:", result.error);
        }
      }

      logAudit({
        orgId: profile.org_id,
        userId: profile.id,
        action: "invitation.send",
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: { email: input.email, role: input.role, method, emailSent },
      });

      return {
        id: invitation.id,
        method,
        inviteLink,
        emailSent,
      };
    }),

  cancel: protectedProcedure
    .input(z.object({ invitationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { error } = await db
        .from("invitations")
        .update({ status: "cancelled" })
        .eq("id", input.invitationId)
        .eq("org_id", profile.org_id)
        .eq("status", "pending");

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),
});

function checkInvitePermission(inviterRole: string, targetRole: string): boolean {
  switch (inviterRole) {
    case "super_admin":
      return ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor", "brand_viewer"].includes(targetRole);
    case "agency_admin":
      return ["agency_editor", "brand_owner", "brand_editor", "brand_viewer"].includes(targetRole);
    case "brand_owner":
      return ["brand_editor", "brand_viewer"].includes(targetRole);
    default:
      return false;
  }
}
