import { z } from "zod";
import { router, publicProcedure, protectedProcedure, adminProcedure, superAdminProcedure } from "../index";
import { TRPCError } from "@trpc/server";
import { logAudit } from "@/server/services/audit";

const roleSchema = z.enum([
  "super_admin",
  "agency_admin",
  "agency_editor",
  "brand_owner",
  "brand_editor",
  "brand_viewer",
]);

export const usersRouter = router({
  me: publicProcedure.query(async ({ ctx }) => {
    return ctx.profile ?? null;
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;

    // Only users who can manage others should see the user list
    if (!["super_admin", "agency_admin", "brand_owner"].includes(profile.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to view users" });
    }

    if (profile.role === "brand_owner") {
      // Brand owner sees: super_admin (read-only) + users assigned to their brand
      const { data, error } = await db
        .from("users")
        .select("*")
        .eq("org_id", profile.org_id)
        .or(`brand_id.eq.${profile.brand_id},role.eq.super_admin`)
        .order("created_at", { ascending: false });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data || [];
    }

    let query = db
      .from("users")
      .select("*")
      .eq("org_id", profile.org_id)
      .order("created_at", { ascending: false });

    // agency_admin cannot see super_admins
    if (profile.role === "agency_admin") {
      query = query.neq("role", "super_admin");
    }

    const { data, error } = await query;
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

    return data;
  }),

  updateRole: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        role: roleSchema,
        brand_id: z.string().uuid().nullable().optional(),
        assigned_brands: z.array(z.string().uuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      if (!["super_admin", "agency_admin", "brand_owner"].includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to update roles" });
      }

      // Prevent self-role change
      if (input.userId === profile.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot change your own role" });
      }

      // brand_owner can only assign brand_editor or brand_viewer within their brand
      if (profile.role === "brand_owner") {
        if (!["brand_editor", "brand_viewer"].includes(input.role)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only assign editor or viewer roles" });
        }
        // Verify target user belongs to this brand
        const { data: target } = await db.from("users").select("brand_id").eq("id", input.userId).eq("org_id", profile.org_id).single();
        if (!target || target.brand_id !== profile.brand_id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only manage users in your brand" });
        }
      }

      // agency_admin cannot promote to super_admin or agency_admin
      if (
        profile.role === "agency_admin" &&
        ["super_admin", "agency_admin"].includes(input.role)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot assign super_admin or agency_admin roles",
        });
      }

      const updates: Record<string, unknown> = { role: input.role };
      if (input.brand_id !== undefined) updates.brand_id = input.brand_id;
      if (input.assigned_brands) updates.assigned_brands = input.assigned_brands;

      const { data, error } = await db
        .from("users")
        .update(updates)
        .eq("id", input.userId)
        .eq("org_id", profile.org_id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  remove: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      if (!["super_admin", "agency_admin", "brand_owner"].includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to remove users" });
      }

      if (input.userId === profile.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot remove yourself" });
      }

      // Check the target user's role and brand
      const { data: targetUser } = await db
        .from("users")
        .select("role, brand_id")
        .eq("id", input.userId)
        .eq("org_id", profile.org_id)
        .single();

      if (!targetUser) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // Only super_admin can delete another super_admin
      if (targetUser.role === "super_admin" && profile.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super_admin can remove another super_admin" });
      }

      // agency_admin cannot delete super_admin or other agency_admins
      if (profile.role === "agency_admin" && ["super_admin", "agency_admin"].includes(targetUser.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot remove this user" });
      }

      // brand_owner can only remove brand_editor/brand_viewer in their own brand
      if (profile.role === "brand_owner") {
        if (!["brand_editor", "brand_viewer"].includes(targetUser.role)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only remove editors and viewers" });
        }
        if (targetUser.brand_id !== profile.brand_id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only remove users in your brand" });
        }
      }

      // Delete from users table
      const { error } = await db
        .from("users")
        .delete()
        .eq("id", input.userId)
        .eq("org_id", profile.org_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Delete from auth.users so they can't log in anymore
      try {
        const { createClient } = require("@supabase/supabase-js");
        const authAdmin = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false } }
        );
        await authAdmin.auth.admin.deleteUser(input.userId);
      } catch (e: any) {
        // Non-fatal — profile is already deleted, auth cleanup is best-effort
        console.warn("[user.remove] Failed to delete auth user:", e.message);
      }

      logAudit({ orgId: profile.org_id, userId: profile.id, action: "user.remove", resourceType: "user", resourceId: input.userId });
      return { success: true };
    }),

  // Get organization info
  getOrg: adminProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;
    const { data, error } = await db
      .from("organizations")
      .select("*")
      .eq("id", profile.org_id)
      .single();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    return data;
  }),

  // Update organization
  updateOrg: superAdminProcedure
    .input(z.object({
      name: z.string().min(1).max(200).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const updates: Record<string, unknown> = {};
      if (input.name) updates.name = input.name;
      if (input.settings) updates.settings = input.settings;

      const { data, error } = await db
        .from("organizations")
        .update(updates)
        .eq("id", profile.org_id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  // Delete organization (super_admin only, cascades everything)
  deleteOrg: superAdminProcedure.mutation(async ({ ctx }) => {
    const { db, profile } = ctx;

    // Delete all brands first (cascades media, posts, jobs, accounts)
    await db.from("brands").delete().eq("org_id", profile.org_id);
    // Delete all users
    await db.from("users").delete().eq("org_id", profile.org_id);
    // Delete org
    const { error } = await db.from("organizations").delete().eq("id", profile.org_id);

    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    return { success: true };
  }),

  // ━━━ Audit Log ━━━

  getAuditLog: superAdminProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(50),
      action: z.string().optional(),
      resourceType: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const offset = (input.page - 1) * input.limit;

      let query = db
        .from("audit_log")
        .select("*, users(name, email, role)", { count: "exact" })
        .eq("org_id", profile.org_id)
        .order("created_at", { ascending: false })
        .range(offset, offset + input.limit - 1);

      if (input.action) query = query.eq("action", input.action);
      if (input.resourceType) query = query.eq("resource_type", input.resourceType);

      const { data, error, count } = await query;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      return {
        logs: data || [],
        total: count || 0,
        page: input.page,
        totalPages: Math.ceil((count || 0) / input.limit),
      };
    }),
});
