import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import {
  fetchInstagramProfile,
  fetchUserFriends,
  fetchUserFeed,
  fetchHashtagMedia,
  loginInstagram,
  InstaAuthError,
  type InstaProfile,
  type InstaFriend,
  type InstaMediaItem,
} from "@/server/services/instagram/fetcher";

export interface AudienceQuality {
  sampled: number;
  verifiedPct: number;
  privatePct: number;
  noPhotoPct: number;
  /** 0–100, higher = healthier / more-real audience */
  qualityScore: number;
  flags: string[];
}

export interface InstaFetchResult {
  username: string;
  ok: boolean;
  profile?: InstaProfile;
  followers?: InstaFriend[];
  following?: InstaFriend[];
  friendsTruncated?: boolean;
  friendsError?: string;
  followersQuality?: AudienceQuality;
  content?: InstaMediaItem[];
  contentTruncated?: boolean;
  contentError?: string;
  error?: string;
}

/**
 * Neutral audience-health metrics from a sampled follower list. A high share of
 * no-photo / no-name accounts is the classic low-quality / bot-heavy signature.
 * (Adapted from modi_script's bot heuristics — reframed as audience quality.)
 */
function analyzeAudience(users: InstaFriend[]): AudienceQuality {
  const n = users.length;
  if (!n) return { sampled: 0, verifiedPct: 0, privatePct: 0, noPhotoPct: 0, qualityScore: 0, flags: [] };
  const pct = (c: number) => Math.round((c / n) * 1000) / 10;
  const verifiedPct = pct(users.filter((u) => u.isVerified).length);
  const privatePct = pct(users.filter((u) => u.isPrivate).length);
  const noPhotoPct = pct(users.filter((u) => !u.profilePic).length);
  const noNamePct = pct(users.filter((u) => !u.fullName?.trim()).length);

  let score = 100;
  score -= Math.min(40, noPhotoPct * 0.6); // no avatar → likely throwaway/bot
  score -= Math.min(25, noNamePct * 0.4); // no display name
  score -= Math.min(15, Math.max(0, privatePct - 45) * 0.3); // extreme private skew
  score += Math.min(10, verifiedPct * 2); // verified followers = healthy
  const qualityScore = Math.max(0, Math.min(100, Math.round(score)));

  const flags: string[] = [];
  if (noPhotoPct > 30) flags.push(`${noPhotoPct}% no photo`);
  if (noNamePct > 45) flags.push(`${noNamePct}% no name`);
  if (verifiedPct >= 1) flags.push(`${verifiedPct}% verified`);
  return { sampled: n, verifiedPct, privatePct, noPhotoPct, qualityScore, flags };
}

/**
 * A rotating pool of the org's active Instagram sessions. Spreads requests
 * across sessions (fewer rate-limits) and, when Instagram kills a session,
 * marks it dead and automatically retries with the next live one — so a single
 * expired/checkpointed session no longer breaks a fetch.
 * (This is modi_script's token-rotation reliability trick, on our own sessions.)
 */
class SessionPool {
  private entries: { rowId: string; sessionId: string; dead: boolean }[] = [];
  private cursor = 0;
  anyKilled = false;
  constructor(private db: any) {}

  async load(orgId: string, preferId?: string) {
    const { data } = await this.db
      .from("insta_sessions")
      .select("id, session_id_encrypted, created_at")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    const rows = (data || []) as any[];
    // Try an explicitly-requested session first, then the rest.
    rows.sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
    for (const row of rows) {
      try {
        this.entries.push({ rowId: row.id, sessionId: decrypt(row.session_id_encrypted), dead: false });
      } catch {}
    }
  }

  get hasAny() {
    return this.entries.some((e) => !e.dead);
  }
  get size() {
    return this.entries.filter((e) => !e.dead).length;
  }

  /** All live session strings — passed to fetchers that rotate mid-pagination. */
  liveSessions(): string[] {
    return this.entries.filter((e) => !e.dead).map((e) => e.sessionId);
  }

  /** Mark a session dead by its value (used by the fetcher's rotation callback). */
  markDeadBySession(sessionId: string, reason = "Session invalidated") {
    const entry = this.entries.find((e) => e.sessionId === sessionId && !e.dead);
    if (!entry) return;
    entry.dead = true;
    this.anyKilled = true;
    markSessionDead(this.db, entry.rowId, reason).catch(() => {});
  }

  /** Run fn with a live session; on auth failure kill it and rotate to the next. */
  async run<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let guard = 0; guard < this.entries.length; guard++) {
      const alive = this.entries.filter((e) => !e.dead);
      if (!alive.length) break;
      const entry = alive[this.cursor % alive.length];
      this.cursor++;
      try {
        const out = await fn(entry.sessionId);
        markSessionChecked(this.db, entry.rowId).catch(() => {});
        return out;
      } catch (e: any) {
        if (e instanceof InstaAuthError) {
          entry.dead = true;
          this.anyKilled = true;
          markSessionDead(this.db, entry.rowId, e?.message || "Session invalidated").catch(() => {});
          lastErr = e;
          continue; // rotate to the next live session
        }
        throw e; // rate-limit / private / other → don't kill the session
      }
    }
    throw lastErr || new InstaAuthError("No active Instagram session available");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Load + decrypt an active session by id, scoped to the caller's org. */
async function loadSession(db: any, orgId: string, id: string) {
  const { data } = await db
    .from("insta_sessions")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return null;
  try {
    return { row: data, sessionId: decrypt(data.session_id_encrypted) };
  } catch {
    return null;
  }
}

async function markSessionDead(db: any, id: string, error: string) {
  await db
    .from("insta_sessions")
    .update({ status: "dead", last_error: error, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}

async function markSessionChecked(db: any, id: string) {
  // A successful fetch self-heals the session back to active.
  await db
    .from("insta_sessions")
    .update({ status: "active", last_checked_at: new Date().toISOString(), last_error: null })
    .eq("id", id);
}

/** Resolve the caller org's most recent active session (id + decrypted value). */
async function resolveLatestOrgSession(
  db: any,
  orgId: string,
): Promise<{ sessionId: string; rowId: string } | null> {
  const { data } = await db
    .from("insta_sessions")
    .select("id, session_id_encrypted")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.session_id_encrypted) return null;
  try {
    return { sessionId: decrypt(data.session_id_encrypted), rowId: data.id };
  } catch {
    return null;
  }
}

/** Resolve any active session server-side (org-agnostic) for the public demo. */
async function resolveAnyActiveSession(db: any): Promise<string | null> {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.session_id_encrypted) return null;
  try {
    return decrypt(data.session_id_encrypted);
  } catch {
    return null;
  }
}

// Crude global rate limit for the unauthenticated public demo (protects the
// shared session from abuse). Resets per server instance.
const demoHits: number[] = [];
function allowDemo(): boolean {
  const now = Date.now();
  while (demoHits.length && demoHits[0] < now - 60_000) demoHits.shift();
  if (demoHits.length >= 40) return false;
  demoHits.push(now);
  return true;
}

export const instaFetcherRouter = router({
  /**
   * PUBLIC demo endpoint (no auth) for the landing page.
   * Auto-uses the platform's active session server-side; visitors never see it.
   * Capped inputs + global rate limit to prevent abuse of the shared session.
   */
  demoFetch: publicProcedure
    .input(
      z.object({
        usernames: z.array(z.string().min(1)).min(1).max(3),
        includeFriends: z.boolean().default(false),
        includeContent: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!allowDemo()) {
        throw new Error("The live demo is busy right now — please try again in a minute.");
      }
      const wantsSession = input.includeFriends || input.includeContent;
      const sessionId = wantsSession ? await resolveAnyActiveSession(ctx.db) : undefined;

      const seen = new Set<string>();
      const targets = input.usernames
        .map((u) => u.trim().replace(/^@/, "").toLowerCase())
        .filter((u) => u && !seen.has(u) && (seen.add(u), true));

      const results: InstaFetchResult[] = [];
      for (let i = 0; i < targets.length; i++) {
        const username = targets[i];
        try {
          const profile = await fetchInstagramProfile(username, sessionId);
          const entry: InstaFetchResult = { username, ok: true, profile };
          if (sessionId && profile.id) {
            await Promise.all([
              input.includeFriends
                ? Promise.all([
                    fetchUserFriends(profile.id, "followers", sessionId, 60)
                      .then((f) => {
                        entry.followers = f.users;
                        entry.friendsTruncated = f.truncated;
                      })
                      .catch((e) => {
                        entry.friendsError = profile.isPrivate ? "Private account." : e?.message;
                      }),
                    fetchUserFriends(profile.id, "following", sessionId, 60)
                      .then((f) => {
                        entry.following = f.users;
                      })
                      .catch(() => {}),
                  ])
                : Promise.resolve(),
              input.includeContent
                ? fetchUserFeed(profile.id, sessionId, 12)
                    .then((c) => {
                      entry.content = c.items;
                      entry.contentTruncated = c.truncated;
                    })
                    .catch((e) => {
                      entry.contentError = profile.isPrivate ? "Private account." : e?.message;
                    })
                : Promise.resolve(),
            ]);
          } else if (wantsSession) {
            const m = "Deep data is available in the full studio — sign in to unlock.";
            if (input.includeFriends) entry.friendsError = m;
            if (input.includeContent) entry.contentError = m;
          }
          results.push(entry);
        } catch (err: any) {
          results.push({ username, ok: false, error: err?.message ?? "Fetch failed" });
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 700));
      }

      return { results, hasSession: Boolean(sessionId) };
    }),

  /**
   * PUBLIC — trending discovery by hashtag. Returns the TOP media for each tag
   * (reels + posts) with views/likes/comments so the client can rank by "most
   * viral". Uses the platform's active session.
   */
  hashtagFetch: publicProcedure
    .input(
      z.object({
        tags: z.array(z.string().min(1)).min(1).max(5),
        limit: z.number().min(1).max(60).default(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sessionId = await resolveAnyActiveSession(ctx.db);
      if (!sessionId) {
        return {
          results: input.tags.map((tag) => ({
            tag: tag.replace(/^#/, ""),
            ok: false as const,
            error: "No active Instagram session configured.",
          })),
          hasSession: false,
        };
      }
      const seen = new Set<string>();
      const tags = input.tags
        .map((t) => t.trim().replace(/^#/, "").toLowerCase())
        .filter((t) => t && !seen.has(t) && (seen.add(t), true));

      const results: {
        tag: string;
        ok: boolean;
        mediaCount?: number | null;
        items?: InstaMediaItem[];
        error?: string;
      }[] = [];
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        try {
          const r = await fetchHashtagMedia(tag, sessionId, input.limit);
          results.push({ tag, ok: true, mediaCount: r.mediaCount, items: r.items });
        } catch (err: any) {
          results.push({ tag, ok: false, error: err?.message ?? "Fetch failed" });
        }
        if (i < tags.length - 1) await new Promise((r) => setTimeout(r, 700));
      }
      return { results, hasSession: true };
    }),

  // ─── Session management (persisted in Supabase, encrypted) ───

  listSessions: protectedProcedure.query(async ({ ctx }) => {
    const { data } = await ctx.db
      .from("insta_sessions")
      .select("id, label, status, last_checked_at, last_error, created_at")
      .eq("org_id", ctx.profile!.org_id)
      .order("created_at", { ascending: false });
    return data ?? [];
  }),

  saveSession: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), label: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const raw = input.sessionId.trim();
      // A real Instagram sessionid starts with the numeric user id + a colon
      // (often URL-encoded as %3A), e.g. "52099132579:AbCd...". A 32-char value
      // with no colon is almost certainly the csrftoken pasted by mistake.
      const looksLikeSessionId =
        /^\d{5,}(:|%3A)/i.test(raw) || /sessionid=\d{5,}(:|%3A)/i.test(raw);
      if (!looksLikeSessionId) {
        throw new Error(
          "That doesn't look like a sessionid. It should start with your numeric ID and contain colons (e.g. 52099132579:AbCd...). You may have copied the 'csrftoken' cookie by mistake — copy the 'sessionid' cookie value instead.",
        );
      }
      const encrypted = encrypt(raw);
      const { data, error } = await ctx.db
        .from("insta_sessions")
        .insert({
          org_id: ctx.profile!.org_id,
          user_id: ctx.profile!.id,
          label: input.label?.trim() || null,
          session_id_encrypted: encrypted,
          status: "active",
        })
        .select("id, label, status, created_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }),

  deleteSession: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .from("insta_sessions")
        .delete()
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      return { ok: true };
    }),

  /**
   * Log into Instagram; on success the session is saved to Supabase (encrypted).
   * NOTE: Instagram now blocks most scripted logins (AuthPlatformAntiScriptingException);
   * pasting a browser session id is far more reliable.
   */
  login: protectedProcedure
    .input(z.object({ username: z.string().min(1), password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await loginInstagram(input.username, input.password);
      if (result.ok && result.sessionId) {
        await ctx.db.from("insta_sessions").insert({
          org_id: ctx.profile!.org_id,
          user_id: ctx.profile!.id,
          label: result.username ?? input.username,
          session_id_encrypted: encrypt(result.sessionId),
          status: "active",
        });
      }
      return result;
    }),

  // ─── Fetching ───

  fetchProfiles: protectedProcedure
    .input(
      z.object({
        usernames: z.array(z.string().min(1)).min(1).max(20),
        sessionDbId: z.string().uuid().optional(),
        includeFriends: z.boolean().default(false),
        friendsLimit: z.number().min(1).max(5000).default(200),
        includeContent: z.boolean().default(false),
        contentLimit: z.number().min(1).max(200).default(24),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Rotating pool of the org's active sessions (auto-failover on dead ones).
      const pool = new SessionPool(ctx.db);
      await pool.load(ctx.profile!.org_id, input.sessionDbId);

      const seen = new Set<string>();
      const targets = input.usernames
        .map((u) => u.trim().replace(/^@/, "").toLowerCase())
        .filter((u) => u && !seen.has(u) && (seen.add(u), true));

      const results: InstaFetchResult[] = [];

      for (let i = 0; i < targets.length; i++) {
        const username = targets[i];
        try {
          // Public profile works without a session; use one when we have it (self-heals).
          const profile = pool.hasAny
            ? await pool
                .run((sid) => fetchInstagramProfile(username, sid))
                .catch(() => fetchInstagramProfile(username))
            : await fetchInstagramProfile(username);
          const entry: InstaFetchResult = { username, ok: true, profile };

          const wantsDeep = (input.includeFriends || input.includeContent) && Boolean(profile.id);

          if (wantsDeep && !pool.hasAny) {
            const m = "No active session — add one in Settings → Instagram.";
            if (input.includeFriends) entry.friendsError = m;
            if (input.includeContent) entry.contentError = m;
          } else if (wantsDeep) {
            const friendErr = (fe: any): string => {
              if (fe instanceof InstaAuthError)
                return "All saved sessions are dead — add a fresh one in Settings → Instagram.";
              if (profile.isPrivate) return "Private account — not accessible.";
              return fe?.message ?? "Fetch failed";
            };

            // Followers, following & content run concurrently — the pool spreads
            // them across different sessions when more than one is available.
            const jobs: Promise<void>[] = [];
            if (input.includeFriends) {
              // Pass the whole live pool so the fetcher rotates + resumes on throttle.
              const onDead = (s: string) => pool.markDeadBySession(s);
              jobs.push(
                fetchUserFriends(profile.id, "followers", pool.liveSessions(), input.friendsLimit, onDead)
                  .then((f) => {
                    entry.followers = f.users;
                    entry.friendsTruncated = entry.friendsTruncated || f.truncated;
                    entry.followersQuality = analyzeAudience(f.users);
                  })
                  .catch((fe) => {
                    entry.friendsError = friendErr(fe);
                  }),
                fetchUserFriends(profile.id, "following", pool.liveSessions(), input.friendsLimit, onDead)
                  .then((f) => {
                    entry.following = f.users;
                    entry.friendsTruncated = entry.friendsTruncated || f.truncated;
                  })
                  .catch((fe) => {
                    if (!entry.friendsError) entry.friendsError = friendErr(fe);
                  }),
              );
            }
            if (input.includeContent) {
              jobs.push(
                pool
                  .run((sid) => fetchUserFeed(profile.id, sid, input.contentLimit))
                  .then((c) => {
                    entry.content = c.items;
                    entry.contentTruncated = c.truncated;
                  })
                  .catch((fe) => {
                    entry.contentError = friendErr(fe);
                  }),
              );
            }
            await Promise.all(jobs);
          }

          results.push(entry);
        } catch (err: any) {
          results.push({ username, ok: false, error: err?.message ?? "Fetch failed" });
        }
        if (i < targets.length - 1) await sleep(800);
      }

      return {
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        sessionKilled: pool.anyKilled,
        sessionsLive: pool.size,
      };
    }),
});
