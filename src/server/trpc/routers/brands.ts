import { z } from "zod";
import { router, protectedProcedure, adminProcedure, superAdminProcedure } from "../index";
import { TRPCError } from "@trpc/server";
import { logAudit } from "@/server/services/audit";
export const brandsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { profile, db } = ctx;

    let query = db
      .from("brands")
      .select("*")
      .eq("org_id", profile.org_id)
      .order("created_at", { ascending: false });

    // Agency editors only see assigned brands
    if (profile.role === "agency_editor") {
      query = query.in("id", profile.assigned_brands || []);
    }

    // Brand-level users see only their brand
    if (["brand_owner", "brand_editor", "brand_viewer"].includes(profile.role)) {
      query = query.eq("id", profile.brand_id);
    }

    const { data, error } = await query;
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

    return data || [];
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("brands")
        .select("*, social_accounts(*), drive_connections(*)")
        .eq("id", input.id)
        .eq("org_id", profile.org_id)
        .single();

      if (error) throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });
      return data;
    }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        logo_url: z.string().url().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("brands")
        .insert({
          org_id: profile.org_id,
          name: input.name,
          logo_url: input.logo_url || null,
          settings: input.settings || {},
          setup_status: "incomplete",
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      logAudit({ orgId: profile.org_id, userId: profile.id, action: "brand.create", resourceType: "brand", resourceId: data.id });
      return data;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        logo_url: z.string().url().nullable().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        setup_status: z.enum(["incomplete", "active"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const { id, ...updates } = input;

      const { data, error } = await db
        .from("brands")
        .update(updates)
        .eq("id", id)
        .eq("org_id", profile.org_id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  getTeamCount: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Brand-level users: directly assigned to this brand
      const { data: brandUsers } = await db
        .from("users")
        .select("role")
        .eq("org_id", profile.org_id)
        .eq("brand_id", input.brandId)
        .in("role", ["brand_owner", "brand_editor", "brand_viewer"]);

      // Agency editors with this brand in assigned_brands
      const { data: agencyEditors } = await db
        .from("users")
        .select("role, assigned_brands")
        .eq("org_id", profile.org_id)
        .eq("role", "agency_editor");

      const assignedEditors = (agencyEditors || []).filter(
        (u: any) => (u.assigned_brands || []).includes(input.brandId)
      );

      const byRole: Record<string, number> = {};
      for (const u of brandUsers || []) {
        byRole[u.role] = (byRole[u.role] || 0) + 1;
      }
      for (const _u of assignedEditors) {
        byRole["agency_editor"] = (byRole["agency_editor"] || 0) + 1;
      }

      return {
        total: (brandUsers?.length || 0) + assignedEditors.length,
        byRole,
      };
    }),

  delete: superAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get brand-level users to delete their auth accounts too
      const { data: brandUsers } = await db
        .from("users")
        .select("id")
        .eq("brand_id", input.id)
        .eq("org_id", profile.org_id)
        .in("role", ["brand_owner", "brand_editor", "brand_viewer"]);

      // Delete from users table
      await db
        .from("users")
        .delete()
        .eq("brand_id", input.id)
        .eq("org_id", profile.org_id)
        .in("role", ["brand_owner", "brand_editor", "brand_viewer"]);

      // Delete their auth accounts so they can't log in
      if (brandUsers?.length) {
        try {
          const { createClient } = require("@supabase/supabase-js");
          const authAdmin = createClient(
            process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
          );
          for (const u of brandUsers) {
            await authAdmin.auth.admin.deleteUser(u.id);
          }
        } catch (e: any) {
          console.warn("[brand.delete] Failed to delete auth users:", e.message);
        }
      }

      // Remove this brand from agency_editors' assigned_brands arrays
      const { data: editors } = await db
        .from("users")
        .select("id, assigned_brands")
        .eq("org_id", profile.org_id)
        .eq("role", "agency_editor");

      for (const editor of editors || []) {
        const brands = (editor.assigned_brands || []).filter((id: string) => id !== input.id);
        await db.from("users").update({ assigned_brands: brands }).eq("id", editor.id);
      }

      // Delete the brand (cascades: social_accounts, drive_connections, media_groups, media_assets, content_posts, publish_jobs, invitations)
      const { error } = await db
        .from("brands")
        .delete()
        .eq("id", input.id)
        .eq("org_id", profile.org_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      logAudit({ orgId: profile.org_id, userId: profile.id, action: "brand.delete", resourceType: "brand", resourceId: input.id });
      return { success: true };
    }),
});
