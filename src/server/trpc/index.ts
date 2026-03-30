import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { type createTRPCContext } from "./router";

const t = initTRPC.context<Awaited<ReturnType<typeof createTRPCContext>>>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Middleware: require authenticated user
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.profile) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      user: ctx.user,
      profile: ctx.profile,
    },
  });
});

export const protectedProcedure = t.procedure.use(isAuthed);

// Middleware: require specific roles
export function requireRole(...roles: string[]) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.user || !ctx.profile) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    if (!roles.includes(ctx.profile.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Required role: ${roles.join(" or ")}`,
      });
    }
    return next({
      ctx: {
        user: ctx.user,
        profile: ctx.profile,
      },
    });
  });
}

export const superAdminProcedure = t.procedure.use(
  requireRole("super_admin")
);

export const adminProcedure = t.procedure.use(
  requireRole("super_admin", "agency_admin")
);

// Helper to verify user has access to a brand
export function assertBrandAccess(
  profile: { role: string; brand_id: string | null; org_id: string; assigned_brands?: string[] },
  brandId: string
) {
  // super_admin and agency_admin can access any brand in their org
  if (["super_admin", "agency_admin"].includes(profile.role)) return;
  // agency_editor can access assigned brands
  if (profile.role === "agency_editor") {
    if ((profile.assigned_brands || []).includes(brandId)) return;
    throw new TRPCError({ code: "FORBIDDEN", message: "You don't have access to this brand" });
  }
  // brand-level roles: must match brand_id
  if (profile.brand_id === brandId) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "You don't have access to this brand" });
}
