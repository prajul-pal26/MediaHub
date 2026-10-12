import { fetchFacebookMediaGrid, type FacebookMediaType } from "@/server/services/facebook/media-grid";
import { fetchFacebookMediaProfile } from "@/server/services/facebook/media-profile";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure } from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import {
  fetchFacebookPageViaBrowser,
  FbBrowserAuthError,
  FbBrowserRateLimitError,
  type FbBrowserPage,
} from "@/server/services/facebook/browser-fetcher";
import { establishGraphqlSession } from "@/server/services/facebook/graphql-scraper";
import type { getDb } from "@/lib/supabase/db";
import { FbScrapeAuthError } from "@/server/services/facebook/scraper-types";
import { facebookCommentJobs, MediaCommentJobError } from "@/server/services/facebook/comment-jobs";
import { mediaExportDestinations, saveMediaSheet, saveMediaSheetInput } from "@/server/services/facebook/media-drive-export";
import { createMediaSheetCompletion, validateSheetJobItems } from "@/server/services/facebook/media-sheet-job";
import { fetchFacebookMediaPreviews } from "@/server/services/facebook/media-previews";
import { fetchFacebookVideoDetails } from "@/server/services/facebook/video-download";

function commentJobError(error: unknown): never {
  if (error instanceof MediaCommentJobError) throw new TRPCError({ code: error.code, message: error.message });
  throw error;
}

export interface FbFetchResult {
  query: string;
  ok: boolean;
  page?: FbBrowserPage;
  error?: string;
}

export async function fetchSelectedMedia(query: string, cookies: string, input: {
  contentTypes?: FacebookMediaType[];
  contentType?: FacebookMediaType;
  postLimit: number;
  photoLimit?: number;
  reelLimit?: number;
  bypassCache: boolean;
  knownIds?: Partial<Record<FacebookMediaType, string[]>>;
}): Promise<{ results: FbFetchResult[]; authError?: string }> {
  const types = [...new Set(input.contentTypes ?? (input.contentType ? [input.contentType] : []))];
  // One owner lookup per request, shared by both collections and cached by session.
  const profilePromise = fetchFacebookMediaProfile(query, cookies, input.bypassCache).catch(() => null);
  // At most two isolated contexts share the browser: a failure in one collection
  // must not discard a successful result from the other.
  const outcomes = await Promise.allSettled(types.map((contentType) => fetchFacebookMediaGrid(query, cookies, {
    contentType,
    postLimit: (contentType === "posts" ? input.photoLimit : input.reelLimit) ?? input.postLimit,
    bypassCache: input.bypassCache,
    knownIds: input.knownIds?.[contentType],
  })));
  const profile = await profilePromise;
  let authError: string | undefined;
  const results = outcomes.map((outcome, index): FbFetchResult => {
    if (outcome.status === "fulfilled") return { query, ok: true, page: { ...outcome.value, ...(profile ?? {}) } };
    const error: unknown = outcome.reason;
    if (error instanceof FbBrowserAuthError || error instanceof FbScrapeAuthError) authError = error.message;
    return { query: `${query} (${types[index] === "posts" ? "Photos" : "Reels"})`, ok: false, error: error instanceof Error ? error.message : "Fetch failed" };
  });
  return { results, authError };
}

/**
 * Resolve the newest active session. Protected Studio calls must stay within
 * their organization; the anonymous public demo has no organization context.
 */
export async function resolveActiveFbCookies(
  db: ReturnType<typeof getDb>,
  orgId?: string,
): Promise<{ id: string; cookies: string } | null> {
  let query = db
    .from("fb_sessions")
    .select("id, cookie_encrypted")
    .eq("status", "active");
  if (orgId) query = query.eq("org_id", orgId);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.cookie_encrypted) return null;
  try {
    return { id: data.id, cookies: decrypt(data.cookie_encrypted) };
  } catch {
    return null;
  }
}

async function markFbDead(db: ReturnType<typeof getDb>, id: string, error: string) {
  await db
    .from("fb_sessions")
    .update({ status: "dead", last_error: error, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}
async function markFbChecked(db: ReturnType<typeof getDb>, id: string) {
  await db
    .from("fb_sessions")
    .update({ status: "active", last_error: null, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}

// Crude global rate limit for the public demo (Chromium is heavy).
const fbHits: number[] = [];
function allowFbDemo(): boolean {
  const now = Date.now();
  while (fbHits.length && fbHits[0] < now - 60_000) fbHits.shift();
  if (fbHits.length >= 12) return false;
  fbHits.push(now);
  return true;
}

/** Row shape returned to the settings UI — never includes the encrypted cookies. */
export interface FbSessionRow {
  id: string;
  label: string | null;
  c_user: string | null;
  status: "active" | "dead";
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
}

export const fbSessionRouter = router({
  // Paste a public Facebook video/reel/watch link → resolve direct MP4 stream(s)
  // for preview + download. Mirrors instaFetcher.downloadVideo.
  downloadVideo: publicProcedure
    .input(z.object({ url: z.string().min(1, "Facebook link is required") }))
    .mutation(async ({ ctx, input }) => {
      let cookies: string | undefined;
      try {
        const session = await resolveActiveFbCookies(ctx.db, ctx.profile?.org_id);
        if (session?.cookies) cookies = session.cookies;
      } catch {}

      const res = await fetchFacebookVideoDetails(input.url, cookies);
      if (!res.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: res.error || "Failed to retrieve the Facebook video." });
      }
      return res;
    }),

  exportDestinations: protectedProcedure.query(({ ctx }) => mediaExportDestinations(ctx.profile)),

  saveMediaSheet: protectedProcedure.input(saveMediaSheetInput).mutation(({ ctx, input }) =>
    saveMediaSheet(ctx.profile, { ...input, pages: input.pages as FbBrowserPage[] })),

  /** Media returns first; this protected job enriches those exact IDs afterwards. */
  startMediaComments: protectedProcedure
    .input(z.object({
      items: z.array(z.object({
        postId: z.string().regex(/^\d{1,40}$/),
        url: z.string().url().max(2048),
        contentType: z.enum(["posts", "reels"]),
      })).min(1).max(2000),
      limit: z.number().int().min(0).max(5000).default(25),
      withReplies: z.boolean().default(true),
      includeComments: z.boolean().default(true),
      includeReactions: z.boolean().default(false),
      includeMetadata: z.boolean().default(true),
      /** Bound to this rendered browser page; expiry releases abandoned jobs. */
      ownerLeaseId: z.string().uuid().optional(),
      sheetExport: saveMediaSheetInput.optional(),
    }).refine((input) => input.includeComments || input.includeReactions || input.includeMetadata, {
      message: "Select comments, reactions or metadata to retrieve media details.",
    }))
    .mutation(async ({ ctx, input }) => {
      const owner = { orgId: ctx.profile!.org_id, userId: ctx.profile!.id };
      if (!owner.orgId || !owner.userId) throw new TRPCError({ code: "FORBIDDEN", message: "An organization is required to retrieve media details." });
      const session = await resolveActiveFbCookies(ctx.db, owner.orgId);
      if (!session) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active Facebook session is configured. Add one in Settings → Facebook." });
      const sheetExport = input.sheetExport;
      if (sheetExport) {
        validateSheetJobItems(sheetExport.pages as FbBrowserPage[], input.items);
        const destinations = await mediaExportDestinations(ctx.profile!);
        if (!destinations.some((destination) => destination.brandId === sheetExport.brandId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Choose a connected Google Drive brand you can access for this run." });
        }
      }
      try {
        return facebookCommentJobs.start(owner, session.cookies, input, {
          ...(sheetExport ? { onComplete: createMediaSheetCompletion(ctx.profile!, { ...sheetExport, pages: sheetExport.pages as FbBrowserPage[] }) } : {}),
          onAuthenticationFailure: async () => {
            const { data } = await ctx.db.from('fb_sessions').select('cookie_encrypted').eq('id',session.id).eq('org_id',owner.orgId).maybeSingle();
            // An older job must not invalidate cookies already refreshed by Chrome.
            if (!data?.cookie_encrypted || decrypt(data.cookie_encrypted) !== session.cookies) return;
            await ctx.db.from('fb_sessions').update({ status:'dead', last_error:'Facebook requires a session refresh.',last_checked_at:new Date().toISOString() })
              .eq('id',session.id).eq('org_id',owner.orgId).eq('cookie_encrypted',data.cookie_encrypted);
          },
        });
      } catch (error) { return commentJobError(error); }
    }),

  mediaCommentsProgress: protectedProcedure
    .input(z.object({ jobId: z.string().uuid(), includeItems: z.boolean().optional().default(true), ownerLeaseId: z.string().uuid().optional() }))
    .query(({ ctx, input }) => {
      try {
        return facebookCommentJobs.progress({ orgId: ctx.profile!.org_id, userId: ctx.profile!.id }, input.jobId, { includeItems: input.includeItems, ownerLeaseId: input.ownerLeaseId });
      } catch (error) { return commentJobError(error); }
    }),

  cancelMediaComments: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      try {
        return facebookCommentJobs.cancel({ orgId: ctx.profile!.org_id, userId: ctx.profile!.id }, input.jobId);
      } catch (error) { return commentJobError(error); }
    }),

  /** A fresh fetch replaces only this user's in-flight detail work. The store
   * performs the same handoff again when the new details job starts, making
   * concurrent tabs safe without relying on client-side cancellation. */
  supersedeMediaComments: protectedProcedure
    .mutation(({ ctx }) => {
      try {
        return facebookCommentJobs.supersede({ orgId: ctx.profile!.org_id, userId: ctx.profile!.id });
      } catch (error) { return commentJobError(error); }
    }),

  /** Reconnect a details-progress panel after an ordinary route remount. */
  activeMediaComments: protectedProcedure
    .query(({ ctx }) => {
      try {
        return facebookCommentJobs.currentForOwner({ orgId: ctx.profile!.org_id, userId: ctx.profile!.id });
      } catch (error) { return commentJobError(error); }
    }),

  /** Restore thumbnails for a bounded group of visible saved cards. */
  recoverMediaPreviews: protectedProcedure
    .input(z.object({ items: z.array(z.object({ postId: z.string().regex(/^\d{1,40}$/), url: z.string().url().max(2048), contentType: z.enum(["posts", "reels"]) })).min(1).max(48) }))
    .query(async ({ ctx, input }) => {
      const owner = { orgId: ctx.profile!.org_id, userId: ctx.profile!.id };
      if (facebookCommentJobs.hasActive(owner)) throw new TRPCError({ code: "CONFLICT", message: "A media details run is active. Wait for it to finish before restoring previews." });
      const session = await resolveActiveFbCookies(ctx.db, owner.orgId);
      if (!session) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active Facebook session is configured. Refresh it in Settings before restoring previews." });
      return fetchFacebookMediaPreviews(input.items, session.cookies);
    }),

  listFbSessions: protectedProcedure.query(async ({ ctx }): Promise<FbSessionRow[]> => {
    const { data } = await ctx.db
      .from("fb_sessions")
      .select("id, label, c_user, status, last_error, last_checked_at, created_at")
      .eq("org_id", ctx.profile!.org_id)
      .order("created_at", { ascending: false });
    return (data ?? []) as FbSessionRow[];
  }),

  saveFbSession: protectedProcedure
    .input(z.object({ cookies: z.string().min(1), label: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const raw = input.cookies.trim();
      if (!/c_user=\d+/.test(raw) || !/xs=/.test(raw)) {
        throw new Error("Cookies must include c_user and xs (copy them from facebook.com in DevTools).");
      }
      const cUser = /c_user=(\d+)/.exec(raw)?.[1] ?? null;
      const { data, error } = await ctx.db
        .from("fb_sessions")
        .insert({
          org_id: ctx.profile!.org_id,
          user_id: ctx.profile!.id,
          label: input.label?.trim() || (cUser ? `fb-${cUser}` : "Facebook session"),
          cookie_encrypted: encrypt(raw),
          c_user: cUser,
          status: "active",
        })
        .select("id, label, status, created_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }),

  deleteFbSession: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.from("fb_sessions").delete().eq("id", input.id).eq("org_id", ctx.profile!.org_id);
      return { ok: true };
    }),

  /**
   * Live health probe. Facebook cookies rotate and get checkpointed silently,
   * so a session sitting at "active" proves nothing until it is exercised.
   * Harvesting an fb_dtsg token is the cheapest call that genuinely requires a
   * logged-in session (no Chromium, no page render).
   */
  checkFbSession: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { data } = await ctx.db
        .from("fb_sessions")
        .select("id, cookie_encrypted")
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id)
        .maybeSingle();
      if (!data?.cookie_encrypted) throw new Error("Session not found");

      let cookies: string;
      try {
        cookies = decrypt(data.cookie_encrypted);
      } catch {
        await ctx.db
          .from("fb_sessions")
          .update({
            status: "dead",
            last_error: "Stored cookies could not be decrypted",
            last_checked_at: new Date().toISOString(),
          })
          .eq("id", input.id);
        return { ok: false as const, message: "Stored cookies could not be decrypted — re-add the session." };
      }

      try {
        const session = await establishGraphqlSession(cookies);
        await ctx.db
          .from("fb_sessions")
          .update({ status: "active", last_error: null, last_checked_at: new Date().toISOString() })
          .eq("id", input.id);
        return { ok: true as const, cUser: session.userId, message: `Session is live (user ${session.userId})` };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Session check failed";
        await ctx.db
          .from("fb_sessions")
          .update({ status: "dead", last_error: message, last_checked_at: new Date().toISOString() })
          .eq("id", input.id);
        return { ok: false as const, message };
      }
    }),

  /** Re-label a saved session without re-pasting the cookie bundle. */
  renameFbSession: protectedProcedure
    .input(z.object({ id: z.string().uuid(), label: z.string().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("fb_sessions")
        .update({ label: input.label.trim() })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }),

  /**
   * Replace the cookie bundle on an existing row. Refreshing a checkpointed
   * session in place keeps its history rather than orphaning scrape runs that
   * reference it.
   */
  refreshFbSession: protectedProcedure
    .input(z.object({ id: z.string().uuid(), cookies: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const raw = input.cookies.trim();
      if (!/c_user=\d+/.test(raw) || !/xs=/.test(raw)) {
        throw new Error("Cookies must include c_user and xs (copy them from facebook.com in DevTools).");
      }
      const { error } = await ctx.db
        .from("fb_sessions")
        .update({
          cookie_encrypted: encrypt(raw),
          c_user: /c_user=(\d+)/.exec(raw)?.[1] ?? null,
          status: "active",
          last_error: null,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }),

  /**
   * PUBLIC demo — renders each Facebook page with the platform's active session
   * via headless Chromium and returns the scraped data. Capped + rate-limited
   * (Chromium is heavy). Runs sequentially (each page ~3–6s).
   */
  fbDemoFetch: publicProcedure
    .input(
      z.object({
        pages: z.array(z.string().min(1)).min(1).max(5),
        postLimit: z.number().int().min(1).max(50).default(12),
        contentType: z.enum(["posts", "reels"]).optional(),
        contentTypes: z.array(z.enum(["posts", "reels"])).min(1).max(2).optional(),
        photoLimit: z.number().int().min(1).max(50).optional(),
        reelLimit: z.number().int().min(1).max(50).optional(),
        includeComments: z.boolean().default(true),
        commentsLimit: z.number().min(1).max(100).default(25),
        includeReactors: z.boolean().default(false),
        reactorsLimit: z.number().min(1).max(100).default(50),
        bypassCache: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!allowFbDemo()) {
        throw new Error("The Facebook demo is busy right now — try again in a minute.");
      }
      const session = await resolveActiveFbCookies(ctx.db);
      if (!session) {
        return {
          results: input.pages.map((query) => ({
            query,
            ok: false,
            error: "No active Facebook session configured. Add one in the studio to enable this.",
          })),
          hasSession: false,
        };
      }

      const seen = new Set<string>();
      const targets = input.pages
        .map((p) => p.trim())
        .filter((p) => p && !seen.has(p) && (seen.add(p), true));

      const results: FbFetchResult[] = [];
      let sessionDead = false;
      for (const query of targets) {
        if (sessionDead) {
          results.push({ query, ok: false, error: "Session expired — add a fresh one." });
          continue;
        }
        if (input.contentTypes || input.contentType) {
          const media = await fetchSelectedMedia(query, session.cookies, input);
          results.push(...media.results);
          if (media.authError) {
            sessionDead = true;
            await markFbDead(ctx.db, session.id, media.authError);
          } else if (media.results.some((result) => result.ok)) await markFbChecked(ctx.db, session.id);
          continue;
        }
        try {
          const page: FbBrowserPage = await fetchFacebookPageViaBrowser(query, session.cookies, {
            postLimit: input.postLimit,
            includeComments: input.includeComments,
            commentsLimit: input.commentsLimit,
            includeReactors: input.includeReactors,
            reactorsLimit: input.reactorsLimit,
            bypassCache: input.bypassCache,
          });
          results.push({ query, ok: true, page });
          await markFbChecked(ctx.db, session.id);
        } catch (err: unknown) {
          if (err instanceof FbBrowserAuthError || err instanceof FbScrapeAuthError) {
            sessionDead = true;
            await markFbDead(ctx.db, session.id, err.message);
            results.push({ query, ok: false, error: "Facebook session expired/blocked — add a fresh one in Settings." });
          } else if (err instanceof FbBrowserRateLimitError) {
            results.push({ query, ok: false, error: err.message });
          } else {
            results.push({ query, ok: false, error: err instanceof Error ? err.message : "Fetch failed" });
          }
        }
      }
      return {
        results,
        hasSession: true,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
    }),

  fetchFbPages: protectedProcedure
    .input(
      z.object({
        pages: z.array(z.string().min(1)).min(1).max(20),
        postLimit: z.number().int().min(1).max(1000).default(20),
        contentType: z.enum(["posts", "reels"]).optional(),
        contentTypes: z.array(z.enum(["posts", "reels"])).min(1).max(2).optional(),
        photoLimit: z.number().int().min(1).max(1000).optional(),
        reelLimit: z.number().int().min(1).max(1000).optional(),
        includeComments: z.boolean().default(true),
        commentsLimit: z.number().min(1).max(500).default(50),
        includeReactors: z.boolean().default(false),
        reactorsLimit: z.number().min(1).max(1000).default(50),
        bypassCache: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = await resolveActiveFbCookies(ctx.db, ctx.profile!.org_id);
      if (!session) {
        throw new Error("No active Facebook session configured. Add one in Settings → Facebook.");
      }

      const seen = new Set<string>();
      const targets = input.pages
        .map((p) => p.trim())
        .filter((p) => p && !seen.has(p) && (seen.add(p), true));

      const results: FbFetchResult[] = [];
      let sessionDead = false;
      for (const query of targets) {
        if (sessionDead) {
          results.push({ query, ok: false, error: "Session expired — refresh the saved session before fetching the remaining profiles." });
          continue;
        }
        if (input.contentTypes || input.contentType) {
          const media = await fetchSelectedMedia(query, session.cookies, input);
          results.push(...media.results);
          if (media.authError) {
            sessionDead = true;
            await markFbDead(ctx.db, session.id, media.authError);
          }
          else if (media.results.some((result) => result.ok)) await markFbChecked(ctx.db, session.id);
          continue;
        }
        try {
          const page: FbBrowserPage = await fetchFacebookPageViaBrowser(query, session.cookies, {
            postLimit: input.postLimit,
            includeComments: input.includeComments,
            commentsLimit: input.commentsLimit,
            includeReactors: input.includeReactors,
            reactorsLimit: input.reactorsLimit,
            bypassCache: input.bypassCache,
          });
          results.push({ query, ok: true, page });
          await markFbChecked(ctx.db, session.id);
        } catch (err: unknown) {
          if (err instanceof FbBrowserAuthError || err instanceof FbScrapeAuthError) {
            sessionDead = true;
            await markFbDead(ctx.db, session.id, err.message);
            results.push({ query, ok: false, error: "Facebook session expired/blocked." });
          } else if (err instanceof FbBrowserRateLimitError) {
            results.push({ query, ok: false, error: err.message });
          } else {
            results.push({ query, ok: false, error: err instanceof Error ? err.message : "Fetch failed" });
          }
        }
      }
      return {
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
    }),
});
