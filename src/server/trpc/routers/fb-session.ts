import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import {
  fetchFacebookPageViaBrowser,
  FbBrowserAuthError,
  type FbBrowserPage,
} from "@/server/services/facebook/browser-fetcher";
import { establishGraphqlSession } from "@/server/services/facebook/graphql-scraper";
import { scrapeProfileViaMbasic } from "@/server/services/facebook/mbasic-scraper";
import { FbScrapeAuthError } from "@/server/services/facebook/scraper-types";

export interface FbFetchResult {
  query: string;
  ok: boolean;
  page?: FbBrowserPage;
  error?: string;
}

/** Resolve the latest active Facebook session cookie bundle (org-agnostic, for the public demo). */
async function resolveActiveFbCookies(db: any): Promise<{ id: string; cookies: string } | null> {
  const { data } = await db
    .from("fb_sessions")
    .select("id, cookie_encrypted")
    .eq("status", "active")
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

async function markFbDead(db: any, id: string, error: string) {
  await db
    .from("fb_sessions")
    .update({ status: "dead", last_error: error, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}
async function markFbChecked(db: any, id: string) {
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
      } catch (err: any) {
        const message = err?.message ?? "Session check failed";
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
    .input(z.object({ pages: z.array(z.string().min(1)).min(1).max(3) }))
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
        .map((p) => p.trim().replace(/^@/, ""))
        .filter((p) => p && !seen.has(p) && (seen.add(p), true));

      const results: FbFetchResult[] = [];
      let sessionDead = false;
      for (const query of targets) {
        if (sessionDead) {
          results.push({ query, ok: false, error: "Session expired — add a fresh one." });
          continue;
        }
        try {
          // mbasic.facebook.com has been retired by Meta — it now redirects to
          // m.facebook.com and every request fails, which used to surface as a
          // bogus "session expired" for perfectly good cookies. Render the page
          // in the browser instead; that is the only path that still works.
          const page: FbBrowserPage = await fetchFacebookPageViaBrowser(query, session.cookies);
          results.push({ query, ok: true, page });
          await markFbChecked(ctx.db, session.id);
        } catch (err: any) {
          if (err instanceof FbBrowserAuthError || err instanceof FbScrapeAuthError) {
            sessionDead = true;
            await markFbDead(ctx.db, session.id, err.message);
            results.push({ query, ok: false, error: "Facebook session expired/blocked — add a fresh one." });
          } else {
            results.push({ query, ok: false, error: err?.message ?? "Fetch failed" });
          }
        }
      }
      return { results, hasSession: true };
    }),
});
