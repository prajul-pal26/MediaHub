import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { TRPCError } from "@trpc/server";
import {
  getOAuthUrl,
  verifyConnection,
  disconnectDrive,
  getDriveStatus,
} from "@/server/services/drive/client";

// Roles that can manage Drive connections
const DRIVE_MANAGE_ROLES = ["super_admin", "agency_admin", "brand_owner"];

export const driveRouter = router({
  connect: protectedProcedure
    .input(z.object({
      brandId: z.string().uuid(),
      from: z.string().optional(), // "brand-setup" or "accounts"
    }))
    .mutation(async ({ ctx, input }) => {
      const { profile, db } = ctx;

      if (!DRIVE_MANAGE_ROLES.includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to connect Drive" });
      }

      if (profile.role === "brand_owner" && profile.brand_id !== input.brandId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only connect Drive for your own brand" });
      }

      const { data: brand } = await db
        .from("brands")
        .select("id")
        .eq("id", input.brandId)
        .eq("org_id", profile.org_id)
        .single();

      if (!brand) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });
      }

      const url = await getOAuthUrl(profile.org_id, input.brandId, input.from);
      return { url };
    }),

  verify: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { profile, db } = ctx;
      const result = await verifyConnection(input.brandId, profile.org_id);

      if (result.success) {
        await db
          .from("brands")
          .update({ setup_status: "active" })
          .eq("id", input.brandId)
          .eq("org_id", profile.org_id);
      }

      return result;
    }),

  disconnect: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { profile, db } = ctx;

      if (!DRIVE_MANAGE_ROLES.includes(profile.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to disconnect Drive" });
      }

      if (profile.role === "brand_owner" && profile.brand_id !== input.brandId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only disconnect Drive for your own brand" });
      }

      const { data: brand } = await db
        .from("brands")
        .select("id")
        .eq("id", input.brandId)
        .eq("org_id", profile.org_id)
        .single();

      if (!brand) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });
      }

      await disconnectDrive(input.brandId);
      return { success: true };
    }),

  status: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ input }) => {
      return getDriveStatus(input.brandId);
    }),
});
