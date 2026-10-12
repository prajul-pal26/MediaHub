import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { availableParallelism } from "node:os";
import { router, protectedProcedure, publicProcedure } from "../index";
import { encrypt, decrypt } from "@/lib/encryption";
import {
  fetchInstagramProfile,
  fetchInstagramProfileFromSearch,
  fetchUserFriends,
  fetchUserFeed,
  fetchHashtagMedia,
  fetchInstagramVideoDetails,
  normalizeSession,
  loginInstagram,
  extractInstagramUsername,
  shortcodeToMediaId,
  InstaAuthError,
  InstaRateLimitError,
  type InstaProfile,
  type InstaFriend,
  type InstaMediaItem,
  type InstaVideoDownloadInfo,
} from "@/server/services/instagram/fetcher";
import { fetchBrowserProfileFeed } from "@/server/services/instagram/browser-discovery";
import { fetchMediaComments } from "@/server/services/instagram/comments";

export interface AudienceQuality {
  sampled: number;
  verifiedPct: number;
  privatePct: number;
  noPhotoPct: number;
  /** 0–100, higher = healthier / more-real audience */
  qualityScore: number;
  flags: string[];
}

export interface InstaFetchStats {
  totalPosts: number;
  scrapedPosts: number;
  totalFollowers: number;
  scrapedFollowers: number;
  totalFollowing: number;
  scrapedFollowing: number;
  totalCommentsScraped: number;
  totalLikesScraped: number;
  totalViewsScraped: number;
  calculatedEngagementRate: number | null;
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
  /** Number of latest post/reel links checkpointed in the local workspace. */
  linksSaved?: number;
  stats?: InstaFetchStats;
  error?: string;
  /** Comments are queued after durable link discovery, never fetched inside
   * this request where a large profile would time out. */
  commentsDeferred?: boolean;
}

/** Keep content discovery durable. Comment harvesting is intentionally handled
 * by the separate insta-comments worker after these links have been saved. */
async function persistDiscoveredMedia(
  db: any,
  orgId: string,
  username: string,
  content: InstaMediaItem[] | undefined,
) {
  const rows = (content ?? [])
    .filter((post) => post.id)
    .map((post) => ({
      org_id: orgId,
      target_username: username,
      media_id: post.id,
      shortcode: post.shortcode || null,
      media_url: post.url || null,
      media_kind: post.kind || null,
      likes_count: Number.isFinite(post.likes) ? post.likes : null,
      comments_count_reported: Number.isFinite(post.comments) ? post.comments : null,
    }));
  if (!rows.length) return 0;
  const { error } = await db
    .from("insta_comment_media")
    .upsert(rows, { onConflict: "org_id,target_username,media_id" });
  if (error) throw new Error(`Could not save Instagram media links: ${error.message}`);
  return rows.length;
}

function computeStats(
  profile?: InstaProfile,
  followers?: InstaFriend[],
  following?: InstaFriend[],
  content?: InstaMediaItem[],
): InstaFetchStats {
  const totalPosts = profile?.postsCount ?? 0;
  const posts = content ?? (profile?.recentPosts as InstaMediaItem[] | undefined) ?? [];
  const scrapedPosts = posts.length;
  const totalFollowers = profile?.followers ?? 0;
  const scrapedFollowers = followers?.length ?? 0;
  const totalFollowing = profile?.following ?? 0;
  const scrapedFollowing = following?.length ?? 0;

  let totalCommentsScraped = 0;
  let totalLikesScraped = 0;
  let totalViewsScraped = 0;

  for (const p of posts) {
    totalLikesScraped += p.likes || 0;
    totalViewsScraped += p.views || 0;
    if (Array.isArray(p.commentsData)) {
      totalCommentsScraped += p.commentsData.length;
    } else {
      totalCommentsScraped += p.comments || 0;
    }
  }

  let calculatedEngagementRate = profile?.engagementRate ?? null;
  if (totalFollowers > 0 && scrapedPosts > 0) {
    const totalEng = posts.reduce((sum, p) => sum + (p.likes || 0) + (p.comments || 0), 0);
    calculatedEngagementRate = Math.round((totalEng / scrapedPosts / totalFollowers) * 10000) / 100;
  }

  return {
    totalPosts,
    scrapedPosts,
    totalFollowers,
    scrapedFollowers,
    totalFollowing,
    scrapedFollowing,
    totalCommentsScraped,
    totalLikesScraped,
    totalViewsScraped,
    calculatedEngagementRate,
  };
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
function configuredCommentConcurrency(fallback: number): number {
  const value = Number(process.env.SOCIAL_COMMENT_CONCURRENCY ?? Math.min(availableParallelism(), 12));
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), 12)) : fallback;
}
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
        friendsLimit: z.number().min(1).max(500).default(60),
        includeContent: z.boolean().default(false),
        contentLimit: z.number().min(1).max(50).default(12),
        includeComments: z.boolean().default(false),
        commentsLimit: z.number().min(1).max(100).default(25),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!allowDemo()) {
        throw new Error("The live demo is busy right now — please try again in a minute.");
      }
      const wantsSession = input.includeFriends || input.includeContent || input.includeComments;
      const sessionId = wantsSession ? (await resolveAnyActiveSession(ctx.db) ?? undefined) : undefined;

      const seen = new Set<string>();
      const targets = input.usernames
        .map((u) => extractInstagramUsername(u))
        .filter((u): u is string => Boolean(u) && !seen.has(u) && (seen.add(u), true));

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
                    fetchUserFriends(profile.id, "followers", sessionId, input.friendsLimit || 60)
                      .then((f) => {
                        entry.followers = f.users;
                        entry.friendsTruncated = f.truncated;
                        entry.followersQuality = analyzeAudience(f.users);
                      })
                      .catch((e) => {
                        entry.friendsError = profile.isPrivate ? "Private account." : e?.message;
                      }),
                    fetchUserFriends(profile.id, "following", sessionId, input.friendsLimit || 60)
                      .then((f) => {
                        entry.following = f.users;
                      })
                      .catch(() => {}),
                  ])
                : Promise.resolve(),
              input.includeContent
                ? fetchUserFeed(profile.id, sessionId, input.contentLimit || 12)
                    .then((c) => {
                      entry.content = c.items;
                      entry.contentTruncated = c.truncated;
                    })
                    .catch((e) => {
                      entry.contentError = profile.isPrivate ? "Private account." : e?.message;
                    })
                : Promise.resolve(),
            ]);

            // Harvest comments if requested
            if (input.includeComments && sessionId) {
              const postsToHarvest = entry.content?.length
                ? entry.content
                : (entry.profile?.recentPosts as InstaMediaItem[] | undefined) || [];
              const commentLimit = input.commentsLimit || 25;
              const batchSize = Math.min(configuredCommentConcurrency(8), 3);
              for (let bi = 0; bi < postsToHarvest.length; bi += batchSize) {
                const batch = postsToHarvest.slice(bi, bi + batchSize);
                await Promise.all(
                  batch.map(async (post) => {
                    try {
                      const mediaId = post.id || (post.shortcode ? shortcodeToMediaId(post.shortcode) : "");
                      if (!mediaId) return;
                      const commentRes = await fetchMediaComments(mediaId, sessionId, {
                        max: commentLimit,
                        includeReplies: true,
                        delayMs: 250,
                      });
                      post.commentsData = commentRes.comments;
                    } catch (ce: any) {
                      post.commentsError = ce?.message ?? "Comments fetch failed";
                    }
                  }),
                );
              }
            }
          } else if (wantsSession) {
            const m = "Deep data is available in the full studio — sign in to unlock.";
            if (input.includeFriends) entry.friendsError = m;
            if (input.includeContent) entry.contentError = m;
            if (input.includeComments) {
              for (const p of entry.content || entry.profile?.recentPosts || []) {
                (p as InstaMediaItem).commentsError = m;
              }
            }
          }

          entry.stats = computeStats(entry.profile, entry.followers, entry.following, entry.content);
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

  /**
   * Fetch Instagram Reel or Post video details & download links from a URL/shortcode.
   */
  downloadVideo: publicProcedure
    .input(
      z.object({
        url: z.string().min(1, "Instagram link or shortcode is required"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let sessionRaw: string | null = null;
      if (ctx.profile?.org_id) {
        try {
          const { data } = await ctx.db
            .from("insta_sessions")
            .select("session_id_encrypted")
            .eq("org_id", ctx.profile.org_id)
            .eq("status", "active")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (data?.session_id_encrypted) {
            sessionRaw = decrypt(data.session_id_encrypted);
          }
        } catch {}
      }

      if (!sessionRaw) {
        sessionRaw = await resolveAnyActiveSession(ctx.db);
      }

      let cookie = "";
      let csrftoken = "";
      if (sessionRaw) {
        try {
          const s = normalizeSession(sessionRaw);
          cookie = s.cookie;
          csrftoken = s.csrftoken || "";
        } catch {}
      }

      const res = await fetchInstagramVideoDetails(input.url, cookie, csrftoken);
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: res.error || "Failed to retrieve video details from Instagram.",
        });
      }
      if (!res.videoUrl) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No video stream found for this Instagram post.",
        });
      }
      return res;
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
      // Accept either the bare sessionid or a complete Cookie header. A complete
      // browser cookie header is preferred because it retains the csrftoken and
      // companion account cookies that Instagram expects on authenticated web
      // requests. Locate sessionid anywhere in that header before validating it.
      const savedSession = /(?:^|;\s*)sessionid=([^;]+)/i.exec(raw)?.[1] ?? raw;
      // A real Instagram sessionid starts with the numeric user id + a colon
      // (often URL-encoded as %3A), e.g. "52099132579:AbCd...". A 32-char value
      // with no colon is almost certainly the csrftoken pasted by mistake.
      const looksLikeSessionId =
        /^\d{5,}(:|%3A)/i.test(savedSession);
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
        contentLimit: z.number().min(1).max(1000).default(24),
        includeComments: z.boolean().default(false),
        commentsLimit: z.number().min(1).max(500).default(25),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Rotating pool of the org's active sessions (auto-failover on dead ones).
      const pool = new SessionPool(ctx.db);
      await pool.load(ctx.profile!.org_id, input.sessionDbId);

      const seen = new Set<string>();
      const targets = input.usernames
        .map((u) => extractInstagramUsername(u))
        .filter((u) => u && !seen.has(u) && (seen.add(u), true));

      const results: InstaFetchResult[] = [];

      for (let i = 0; i < targets.length; i++) {
        const username = targets[i];
        try {
          // `web_profile_info` is an old private endpoint and can be rejected
          // while Instagram's own current browser lookup still works. Resolve
          // through browser-compatible search in that specific case, then use
          // the browser's Profile Posts GraphQL response for link discovery.
          let browserDiscovery = false;
          const profile = pool.hasAny
            ? await pool
                .run((sid) => fetchInstagramProfile(username, sid))
                .catch(async (error) => {
                  if (error instanceof InstaRateLimitError) {
                    browserDiscovery = true;
                    return pool.run((sid) => fetchInstagramProfileFromSearch(username, sid));
                  }
                  return fetchInstagramProfile(username);
                })
            : await fetchInstagramProfile(username);
          const entry: InstaFetchResult = { username, ok: true, profile };

          const wantsDeep =
            (input.includeFriends || input.includeContent || input.includeComments) &&
            Boolean(profile.id);

          if (wantsDeep && !pool.hasAny) {
            const m = "No active session — add one in Settings → Instagram.";
            if (input.includeFriends) entry.friendsError = m;
            if (input.includeContent) entry.contentError = m;
            if (input.includeComments) {
              for (const p of entry.content || entry.profile?.recentPosts || []) {
                (p as InstaMediaItem).commentsError = m;
              }
            }
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
            // A comment request always needs the durable post/reel links first.
            // Fetch that compact media grid here, then hand comments to BullMQ.
            if (input.includeContent || input.includeComments) {
              jobs.push(
                pool
                  .run(async (sid) => {
                    if (browserDiscovery) {
                      return fetchBrowserProfileFeed(profile.username, sid, input.contentLimit);
                    }
                    const apiResult = await fetchUserFeed(profile.id, sid, input.contentLimit);
                    // Instagram sometimes answers the legacy feed endpoint with
                    // an empty 200 response. The browser response is the
                    // reliable fallback, not a retry loop against that route.
                    return apiResult.items.length
                      ? apiResult
                      : fetchBrowserProfileFeed(profile.username, sid, input.contentLimit);
                  })
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

            // Persist all post/reel links and visible metrics before any
            // optional comment action. This is the durable handoff to the
            // dedicated Instagram comment pipeline.
            if (entry.content?.length) {
              try {
                entry.linksSaved = await persistDiscoveredMedia(
                  ctx.db,
                  ctx.profile!.org_id,
                  profile.username,
                  entry.content,
                );
              } catch (persistError: any) {
                entry.contentError = entry.contentError ?? persistError?.message ?? "Could not save discovered media";
              }
            }

            if (input.includeComments && entry.content?.length) entry.commentsDeferred = true;
          }

          entry.stats = computeStats(entry.profile, entry.followers, entry.following, entry.content);
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
