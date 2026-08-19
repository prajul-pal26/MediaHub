import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { decrypt } from "@/lib/encryption";
import {
  scrapeComments,
  scrapeGroup,
  scrapePosts,
  scrapeProfile,
  scrapeReactors,
  type FbMethod,
  type MethodAttempt,
} from "@/server/services/facebook/orchestrator";
import { graphqlConfigured } from "@/server/services/facebook/graphql-scraper";
import { fetchFacebookPage } from "@/server/services/facebook/fetcher";
import { FbScrapeAuthError, parseFacebookTarget } from "@/server/services/facebook/scraper-types";

const methodSchema = z.enum(["auto", "mbasic", "graphql", "browser"]).default("auto");

/**
 * Scraping is expensive and session-risky, so hold a per-org concurrency gate:
 * one run at a time per org, and a rolling cap on runs per minute.
 */
const inFlight = new Set<string>();
const recentRuns = new Map<string, number[]>();
const RUNS_PER_MINUTE = 10;

function reserveSlot(orgId: string): void {
  if (inFlight.has(orgId)) {
    throw new Error("A Facebook scrape is already running for your organization — wait for it to finish.");
  }
  const now = Date.now();
  const window = (recentRuns.get(orgId) ?? []).filter((t) => t > now - 60_000);
  if (window.length >= RUNS_PER_MINUTE) {
    throw new Error(`Rate limit: max ${RUNS_PER_MINUTE} Facebook scrapes per minute. Try again shortly.`);
  }
  window.push(now);
  recentRuns.set(orgId, window);
  inFlight.add(orgId);
}

function releaseSlot(orgId: string): void {
  inFlight.delete(orgId);
}

interface ResolvedSession {
  id: string;
  cookies: string;
}

/** Newest active session for the org. */
async function resolveSession(db: any, orgId: string): Promise<ResolvedSession> {
  const { data } = await db
    .from("fb_sessions")
    .select("id, cookie_encrypted")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.cookie_encrypted) {
    throw new Error(
      "No active Facebook session. Add your cookie bundle in Settings → Facebook before scraping.",
    );
  }
  try {
    return { id: data.id, cookies: decrypt(data.cookie_encrypted) };
  } catch {
    throw new Error("Stored Facebook session could not be decrypted — re-add it in Settings.");
  }
}

async function markSessionDead(db: any, sessionId: string, error: string): Promise<void> {
  await db
    .from("fb_sessions")
    .update({ status: "dead", last_error: error, last_checked_at: new Date().toISOString() })
    .eq("id", sessionId);
}

async function markSessionHealthy(db: any, sessionId: string): Promise<void> {
  await db
    .from("fb_sessions")
    .update({ status: "active", last_error: null, last_checked_at: new Date().toISOString() })
    .eq("id", sessionId);
}

interface RecordRunArgs {
  db: any;
  orgId: string;
  userId: string;
  sessionId: string | null;
  kind: "posts" | "comments" | "profile" | "group" | "reactors";
  target: string;
  method: FbMethod;
  status: "ok" | "partial" | "failed";
  source: string | null;
  itemCount: number;
  payload: unknown;
  attempts: MethodAttempt[];
  error?: string;
  durationMs: number;
}

/** Persist the run. Never let a logging failure break the actual scrape. */
async function recordRun(args: RecordRunArgs): Promise<string | null> {
  let targetKind: string | null = null;
  let targetHandle: string | null = null;
  try {
    const parsed = parseFacebookTarget(args.target);
    targetKind = parsed.kind;
    targetHandle = parsed.handle || null;
  } catch {
    /* an unparseable target is itself worth recording */
  }

  try {
    const { data } = await args.db
      .from("fb_scrape_runs")
      .insert({
        org_id: args.orgId,
        user_id: args.userId,
        session_id: args.sessionId,
        kind: args.kind,
        target: args.target,
        target_kind: targetKind,
        target_handle: targetHandle,
        method: args.method,
        status: args.status,
        source: args.source,
        item_count: args.itemCount,
        payload: args.payload ?? null,
        attempts: args.attempts,
        error: args.error ?? null,
        duration_ms: args.durationMs,
      })
      .select("id")
      .single();
    return data?.id ?? null;
  } catch (err) {
    console.error("Failed to record fb scrape run:", err);
    return null;
  }
}

/**
 * Shared wrapper: gate, resolve session, run, record, translate auth failures
 * into a dead-session marker so the next call fails fast with a clear message.
 */
async function runScrape<T>(
  ctx: any,
  kind: RecordRunArgs["kind"],
  target: string,
  method: FbMethod,
  fn: (cookies: string) => Promise<{ data: T; source: string | null; attempts: MethodAttempt[] }>,
  countOf: (data: T) => number,
) {
  const orgId = ctx.profile!.org_id as string;
  reserveSlot(orgId);
  const started = Date.now();
  let session: ResolvedSession | null = null;

  try {
    session = await resolveSession(ctx.db, orgId);
    const result = await fn(session.cookies);
    const count = countOf(result.data);

    if (count > 0) await markSessionHealthy(ctx.db, session.id);

    const runId = await recordRun({
      db: ctx.db,
      orgId,
      userId: ctx.profile!.id,
      sessionId: session.id,
      kind,
      target,
      method,
      status: count > 0 ? "ok" : "partial",
      source: result.source,
      itemCount: count,
      payload: result.data,
      attempts: result.attempts,
      durationMs: Date.now() - started,
    });

    return { ...result, count, runId, durationMs: Date.now() - started };
  } catch (err: any) {
    const message = err?.message ?? "Scrape failed";
    if (err instanceof FbScrapeAuthError && session) {
      await markSessionDead(ctx.db, session.id, message);
    }
    await recordRun({
      db: ctx.db,
      orgId,
      userId: ctx.profile!.id,
      sessionId: session?.id ?? null,
      kind,
      target,
      method,
      status: "failed",
      source: null,
      itemCount: 0,
      payload: null,
      attempts: [],
      error: message,
      durationMs: Date.now() - started,
    });
    throw new Error(
      err instanceof FbScrapeAuthError
        ? `${message} — add a fresh session in Settings → Facebook.`
        : message,
    );
  } finally {
    releaseSlot(orgId);
  }
}

export const fbScraperRouter = router({
  /** Which methods this deployment can actually run, for the UI to reflect. */
  capabilities: protectedProcedure.query(async ({ ctx }) => {
    const { count } = await ctx.db
      .from("fb_sessions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.profile!.org_id)
      .eq("status", "active");

    return {
      hasSession: (count ?? 0) > 0,
      activeSessions: count ?? 0,
      graphqlConfigured: graphqlConfigured(),
      browserConfigured: Boolean(process.env.CHROMIUM_PATH),
      chromiumPath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser",
    };
  }),

  /** Classify a pasted link without hitting Facebook — drives the UI's hints. */
  inspectTarget: protectedProcedure
    .input(z.object({ target: z.string().min(1) }))
    .query(({ input }) => {
      try {
        const parsed = parseFacebookTarget(input.target);
        return { ok: true as const, ...parsed };
      } catch (err: any) {
        return { ok: false as const, error: err?.message ?? "Unrecognized Facebook link" };
      }
    }),

  scrapePosts: protectedProcedure
    .input(
      z.object({
        target: z.string().min(1),
        method: methodSchema,
        pages: z.number().int().min(1).max(10).default(3),
        limit: z.number().int().min(1).max(200).default(30),
        withComments: z.boolean().default(false),
        commentsPerPost: z.number().int().min(1).max(100).default(20),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      runScrape(
        ctx,
        "posts",
        input.target,
        input.method,
        (cookies) =>
          scrapePosts({
            target: input.target,
            cookies,
            method: input.method,
            pages: input.pages,
            limit: input.limit,
            withComments: input.withComments,
            commentsPerPost: input.commentsPerPost,
          }),
        (posts) => posts.length,
      ),
    ),

  scrapeComments: protectedProcedure
    .input(
      z.object({
        postUrl: z.string().min(1),
        method: methodSchema,
        limit: z.number().int().min(1).max(500).default(50),
        withReplies: z.boolean().default(true),
        ordering: z.enum(["all", "newest", "relevant"]).default("all"),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      runScrape(
        ctx,
        "comments",
        input.postUrl,
        input.method,
        (cookies) =>
          scrapeComments({
            postUrl: input.postUrl,
            cookies,
            method: input.method,
            limit: input.limit,
            withReplies: input.withReplies,
            ordering: input.ordering,
          }),
        (comments) => comments.length,
      ),
    ),

  scrapeProfile: protectedProcedure
    .input(z.object({ target: z.string().min(1), method: methodSchema }))
    .mutation(async ({ ctx, input }) =>
      runScrape(
        ctx,
        "profile",
        input.target,
        input.method,
        (cookies) => scrapeProfile(input.target, cookies, input.method),
        (profile) => (profile ? 1 : 0),
      ),
    ),

  scrapeGroup: protectedProcedure
    .input(z.object({ target: z.string().min(1) }))
    .mutation(async ({ ctx, input }) =>
      runScrape(
        ctx,
        "group",
        input.target,
        "mbasic",
        (cookies) => scrapeGroup(input.target, cookies),
        (group) => (group ? 1 : 0),
      ),
    ),

  scrapeReactors: protectedProcedure
    .input(z.object({ postUrl: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) }))
    .mutation(async ({ ctx, input }) =>
      runScrape(
        ctx,
        "reactors",
        input.postUrl,
        "browser",
        (cookies) => scrapeReactors(input.postUrl, cookies, input.limit),
        (result) => result.reactors.length,
      ),
    ),

  /**
   * Official Graph API lookup — the only ToS-compliant path here, kept
   * alongside the scrapers so a page you actually own needs no cookies at all.
   * Reading Pages you don't own requires Meta's Page Public Content Access.
   */
  fetchViaGraph: protectedProcedure
    .input(
      z.object({
        pages: z.array(z.string().min(1)).min(1).max(20),
        accessToken: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let token = input.accessToken?.trim() || "";
      let tokenSource: "provided" | "app" | "none" = token ? "provided" : "none";

      if (!token && ctx.profile?.org_id) {
        const { data } = await ctx.db
          .from("platform_credentials")
          .select("client_id_encrypted, client_secret_encrypted")
          .eq("org_id", ctx.profile.org_id)
          .eq("platform", "facebook")
          .maybeSingle();
        if (data?.client_id_encrypted && data?.client_secret_encrypted) {
          try {
            const appId = decrypt(data.client_id_encrypted);
            const appSecret = decrypt(data.client_secret_encrypted);
            if (appId && appSecret) {
              token = `${appId}|${appSecret}`;
              tokenSource = "app";
            }
          } catch {
            /* fall through to the no-token response */
          }
        }
      }

      if (!token) {
        return {
          results: input.pages.map((query) => ({
            query,
            ok: false as const,
            error:
              "No Facebook access token — paste a Page/User token, or configure Facebook credentials in Settings → Platform Credentials.",
          })),
          succeeded: 0,
          failed: input.pages.length,
          tokenSource,
        };
      }

      const seen = new Set<string>();
      const targets = input.pages
        .map((p) => p.trim().replace(/^@/, ""))
        .map((p) => {
          // Accept full URLs here too — the raw Graph fetcher only strips "@".
          try {
            return parseFacebookTarget(p).handle || p;
          } catch {
            return p;
          }
        })
        .filter((p) => p && !seen.has(p) && (seen.add(p), true));

      const results: { query: string; ok: boolean; page?: unknown; error?: string }[] = [];
      for (let i = 0; i < targets.length; i++) {
        try {
          results.push({ query: targets[i], ok: true, page: await fetchFacebookPage(targets[i], token) });
        } catch (err: any) {
          results.push({ query: targets[i], ok: false, error: err?.message ?? "Fetch failed" });
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 500));
      }

      return {
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        tokenSource,
      };
    }),

  /** Run history — lets users re-export without re-hitting Facebook. */
  listRuns: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["posts", "comments", "profile", "group", "reactors"]).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      let query = ctx.db
        .from("fb_scrape_runs")
        .select("id, kind, target, target_kind, target_handle, method, status, source, item_count, error, duration_ms, created_at")
        .eq("org_id", ctx.profile!.org_id)
        .order("created_at", { ascending: false })
        .limit(input.limit);
      if (input.kind) query = query.eq("kind", input.kind);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data ?? [];
    }),

  getRun: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("fb_scrape_runs")
        .select("*")
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Scrape run not found");
      return data;
    }),

  deleteRun: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("fb_scrape_runs")
        .delete()
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }),
});
