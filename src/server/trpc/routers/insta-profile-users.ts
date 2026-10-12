import { z } from "zod";
import { decrypt, encrypt } from "@/lib/encryption";
import { syncInstagramProfileUsersSheet } from "@/server/services/instagram/profile-users-sheet";
import { router, superAdminProcedure } from "../index";

const statusSchema = z.enum(["pending", "done"]);

const importRowSchema = z.object({
  sourceRowNumber: z.number().int().positive(),
  district: z.string().trim().max(200).optional(),
  instaName: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: z.string().min(1).max(500),
  status: statusSchema.optional(),
});

function visibleRow(row: any) {
  try {
    return {
      id: row.id,
      district: row.district,
      instaName: row.insta_name,
      email: decrypt(row.email_encrypted),
      password: decrypt(row.password_encrypted),
      status: row.status as "pending" | "done",
      facebookStatus: (row.facebook_status ?? "pending") as "pending" | "done",
      sourceRowNumber: row.source_row_number,
      updatedAt: row.updated_at,
    };
  } catch {
    // A corrupted encrypted value is never sent to the browser.
    return null;
  }
}

/**
 * The imported Google Sheet is an account directory, not a credential store that
 * browser users may read directly. Only a super-admin can request a decrypted row
 * for the local one-time Chrome fill action, and status changes are user-initiated.
 */
export const instaProfileUsersRouter = router({
  // A credential-safe view used by the Accounts page to show which directory
  // profiles still need to be connected. It intentionally excludes email and
  // password values.
  connectionRoster: superAdminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db.rpc("get_insta_profile_connection_roster", {
      p_org_id: ctx.profile!.org_id,
    });

    if (error) throw new Error("Could not load the Instagram connection roster.");

    return (data ?? []).map((row: any) => ({
      id: row.id,
      district: row.district,
      instaName: row.insta_name,
      status: row.status as "pending" | "done",
    }));
  }),

  list: superAdminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from("insta_profile_users")
      .select("id, district, insta_name, email_encrypted, password_encrypted, status, facebook_status, source_row_number, updated_at")
      .eq("org_id", ctx.profile!.org_id)
      .order("district", { ascending: true })
      .order("insta_name", { ascending: true });
    if (error) throw new Error("Could not load Instagram profile users.");
    return (data ?? []).map(visibleRow).filter(Boolean);
  }),

  importRows: superAdminProcedure
    .input(z.object({
      sourceSheetId: z.string().min(1).max(200),
      rows: z.array(importRowSchema).min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const sourceRows = input.rows.map((row) => row.sourceRowNumber);
      const { data: existing, error: existingError } = await ctx.db
        .from("insta_profile_users")
        .select("source_row_number, status")
        .eq("org_id", ctx.profile!.org_id)
        .eq("source_sheet_id", input.sourceSheetId)
        .in("source_row_number", sourceRows);
      if (existingError) throw new Error("Could not inspect existing Instagram profile users.");
      const existingStatus = new Map((existing ?? []).map((row: any) => [row.source_row_number, row.status]));

      const rows = input.rows.map((row) => ({
        org_id: ctx.profile!.org_id,
        source_sheet_id: input.sourceSheetId,
        source_row_number: row.sourceRowNumber,
        district: row.district || null,
        insta_name: row.instaName,
        email_encrypted: encrypt(row.email),
        password_encrypted: encrypt(row.password),
        // An automated re-import may update credentials but can never alter a
        // person-controlled status that was already set in MediaHub.
        status: existingStatus.get(row.sourceRowNumber) ?? row.status ?? "pending",
        updated_at: new Date().toISOString(),
      }));
      const { error } = await ctx.db
        .from("insta_profile_users")
        .upsert(rows, { onConflict: "org_id,source_sheet_id,source_row_number" });
      if (error) throw new Error("Could not import Instagram profile users.");
      return { imported: rows.length };
    }),

  create: superAdminProcedure
    .input(z.object({
      district: z.string().trim().max(200).optional(),
      instaName: z.string().trim().min(1).max(200),
      email: z.string().trim().email(),
      password: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const sourceSheetId = "manual";
      const { data: latest, error: latestError } = await ctx.db
        .from("insta_profile_users")
        .select("source_row_number")
        .eq("org_id", ctx.profile!.org_id)
        .eq("source_sheet_id", sourceSheetId)
        .order("source_row_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestError) throw new Error("Could not prepare a new Instagram profile row.");
      const { data, error } = await ctx.db
        .from("insta_profile_users")
        .insert({
          org_id: ctx.profile!.org_id,
          source_sheet_id: sourceSheetId,
          source_row_number: (latest?.source_row_number ?? 0) + 1,
          district: input.district || null,
          insta_name: input.instaName,
          email_encrypted: encrypt(input.email),
          password_encrypted: encrypt(input.password),
          status: "pending",
        })
        .select("id, district, insta_name, email_encrypted, password_encrypted, status, facebook_status, source_row_number, updated_at")
        .single();
      if (error || !data) throw new Error("Could not create the Instagram profile.");
      const profile = visibleRow(data);
      if (!profile) throw new Error("The new Instagram profile could not be read safely.");
      return profile;
    }),

  setStatus: superAdminProcedure
    .input(z.object({ id: z.string().uuid(), status: statusSchema }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("insta_profile_users")
        .update({ status: input.status, updated_at: new Date().toISOString() })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error("Could not update profile status.");
      return { ok: true };
    }),

  // Facebook progress is tracked independently of Instagram's status.
  setFacebookStatus: superAdminProcedure
    .input(z.object({ id: z.string().uuid(), status: statusSchema }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("insta_profile_users")
        .update({ facebook_status: input.status, updated_at: new Date().toISOString() })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error("Could not update Facebook profile status.");
      return { ok: true };
    }),

  syncSheet: superAdminProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => syncInstagramProfileUsersSheet({ orgId: ctx.profile!.org_id, db: ctx.db }, input.brandId)),
});
