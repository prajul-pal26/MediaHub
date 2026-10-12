import { z } from "zod";
import { router, protectedProcedure } from "../index";
import {
  getDistrictProfiles,
  getPhotoPayload,
  recordPhotoSyncSuccess,
  syncLogosFromGoogleDrive,
  deleteDistrictLogo,
  updateSafariSessionStatus,
} from "@/server/services/instagram/profile-photo-service";

export const instaProfilePhotoRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getDistrictProfiles(ctx.db, ctx.profile?.org_id);
  }),

  getPhoto: protectedProcedure
    .input(z.object({ username: z.string().min(1) }))
    .query(async ({ input }) => {
      return getPhotoPayload(input.username);
    }),

  setStatus: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(["pending", "synced"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return recordPhotoSyncSuccess(input.id, input.status, ctx.profile?.org_id, ctx.db);
    }),

  setSafariSession: protectedProcedure
    .input(
      z.object({
        district: z.string(),
        username: z.string(),
        hasSession: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      return updateSafariSessionStatus(input.district, input.username, input.hasSession);
    }),

  syncFromDrive: protectedProcedure.mutation(async ({ ctx }) => {
    return syncLogosFromGoogleDrive(ctx.profile?.org_id, ctx.db);
  }),

  deleteLogo: protectedProcedure
    .input(z.object({ username: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return deleteDistrictLogo(input.username);
    }),

  triggerSafariSync: protectedProcedure
    .input(
      z.object({
        district: z.string().optional(),
        username: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const port = process.env.SAFARI_BRIDGE_PORT || "3012";
      const endpoints = [
        `http://host.docker.internal:${port}/sync-photo`,
        `http://127.0.0.1:${port}/sync-photo`,
        `http://localhost:${port}/sync-photo`,
      ];
      let lastErr: any = null;
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(300000),
          });
          const data = (await res.json()) as {
            success: boolean;
            district?: string;
            username?: string;
            message?: string;
          };
          if (data.success && (input.district || input.username)) {
            updateSafariSessionStatus(input.district || "", input.username || "", true);
          }
          return data;
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(`Safari bridge unreachable on port ${port}: ${lastErr?.message || "connection refused"}`);
    }),

  scanSessions: protectedProcedure.mutation(async () => {
    const port = process.env.SAFARI_BRIDGE_PORT || "3012";
    const endpoints = [
      `http://host.docker.internal:${port}/scan-sessions`,
      `http://127.0.0.1:${port}/scan-sessions`,
      `http://localhost:${port}/scan-sessions`,
    ];
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        const data = (await res.json()) as { status: string; detected?: string[] };
        return data;
      } catch {}
    }
    return { status: "offline", detected: [] };
  }),
});

