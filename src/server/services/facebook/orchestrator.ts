/**
 * The single entry point every caller should use.
 *
 * Three scraping methods exist, each with a different failure mode:
 *
 *   mbasic   — fastest (~300ms), richest post fields, but Facebook is steadily
 *              retiring the surface, so it can return nothing without erroring.
 *   graphql  — clean JSON comments with real cursors, but the persisted-query
 *              doc_ids rotate per Facebook deploy and must be kept current.
 *   browser  — slowest (~3–10s) and heaviest, but works whenever a human could
 *              load the page.
 *
 * Rather than making the caller choose, this tries them cheapest-first and
 * falls through on thin or failed results, reporting which method actually
 * produced the data so the UI can show it.
 */
import {
  scrapeCommentsViaBrowser,
  scrapePostsViaBrowser,
  scrapeReactorsViaBrowser,
} from "./browser-scraper";
import { graphqlConfigured, scrapeCommentsViaGraphql } from "./graphql-scraper";
import {
  scrapeCommentsViaMbasic,
  scrapeGroupViaMbasic,
  scrapePostsViaMbasic,
  scrapeProfileViaMbasic,
} from "./mbasic-scraper";
import { fetchFacebookPageViaBrowser } from "./browser-fetcher";
import {
  FbScrapeAuthError,
  parseFacebookTarget,
  type FbScrapedComment,
  type FbScrapedGroup,
  type FbScrapedPost,
  type FbScrapedProfile,
  type FbScrapedReactor,
  type FbScrapeSource,
} from "./scraper-types";

export type FbMethod = "auto" | "mbasic" | "graphql" | "browser";

/** One line per method tried — surfaced in the UI so failures are diagnosable. */
export interface MethodAttempt {
  method: Exclude<FbMethod, "auto">;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface ScrapeOutcome<T> {
  data: T;
  source: FbScrapeSource | null;
  attempts: MethodAttempt[];
}

async function attempt<T>(
  method: Exclude<FbMethod, "auto">,
  attempts: MethodAttempt[],
  size: (value: T) => number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await fn();
    attempts.push({ method, ok: true, count: size(value), ms: Date.now() - started });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    attempts.push({ method, ok: false, count: 0, ms: Date.now() - started, error: message });
    // A dead session will fail identically on every method — stop early.
    if (err instanceof FbScrapeAuthError) throw err;
    return null;
  }
}

export interface ScrapePostsInput {
  target: string;
  cookies: string;
  method?: FbMethod;
  pages?: number;
  limit?: number;
  withComments?: boolean;
  commentsPerPost?: number;
}

/** Scrape a page/profile/group timeline. */
export async function scrapePosts(input: ScrapePostsInput): Promise<ScrapeOutcome<FbScrapedPost[]>> {
  const { cookies, method = "auto", pages = 3, limit = 30, withComments = false, commentsPerPost = 20 } = input;
  const parsed = parseFacebookTarget(input.target);
  const attempts: MethodAttempt[] = [];
  const size = (posts: FbScrapedPost[]) => posts.length;

  const mbasicPath =
    parsed.kind === "group" ? `groups/${parsed.handle}` : parsed.handle || parsed.url;

  if (method === "mbasic" || method === "auto") {
    const result = await attempt<FbScrapedPost[]>("mbasic", attempts, size, async () => {
      const { posts } = await scrapePostsViaMbasic(mbasicPath, cookies, {
        pages,
        limit,
        withComments,
        commentsPerPost,
      });
      return posts;
    });
    if (result?.length) return { data: result, source: "mbasic", attempts };
    if (method === "mbasic") return { data: result ?? [], source: result ? "mbasic" : null, attempts };
  }

  if (method === "browser" || method === "auto") {
    const result = await attempt<FbScrapedPost[]>("browser", attempts, size, () =>
      scrapePostsViaBrowser(parsed.url, cookies, { limit, scrolls: Math.max(2, pages + 1) }),
    );
    if (result?.length) {
      if (withComments) {
        for (const post of result.slice(0, 10)) {
          if (!post.postUrl) continue;
          try {
            post.commentsFull = await scrapeCommentsViaBrowser(post.postUrl, cookies, {
              limit: commentsPerPost,
            });
          } catch {
            post.commentsFull = [];
          }
        }
      }
      return { data: result, source: "browser", attempts };
    }
  }

  return { data: [], source: null, attempts };
}

export interface ScrapeCommentsInput {
  postUrl: string;
  cookies: string;
  method?: FbMethod;
  limit?: number;
  withReplies?: boolean;
  ordering?: "all" | "newest" | "relevant";
}

/** Scrape a single post's comment thread. */
export async function scrapeComments(
  input: ScrapeCommentsInput,
): Promise<ScrapeOutcome<FbScrapedComment[]>> {
  const { cookies, method = "auto", limit = 50, withReplies = true, ordering = "all" } = input;
  const parsed = parseFacebookTarget(input.postUrl);
  if (parsed.kind !== "post") {
    throw new Error(
      "That link points at a page, not a post — paste a post permalink (it contains /posts/, /videos/, /reel/, or story_fbid).",
    );
  }
  const attempts: MethodAttempt[] = [];
  const size = (comments: FbScrapedComment[]) => comments.length;

  if ((method === "graphql" || method === "auto") && parsed.postId && graphqlConfigured()) {
    const result = await attempt<FbScrapedComment[]>("graphql", attempts, size, () =>
      scrapeCommentsViaGraphql(parsed.postId!, cookies, { limit, withReplies }),
    );
    if (result?.length) return { data: result, source: "graphql", attempts };
    if (method === "graphql") return { data: result ?? [], source: result ? "graphql" : null, attempts };
  } else if (method === "graphql") {
    throw new Error("GraphQL method needs FB_GRAPHQL_COMMENTS_DOC_ID set and a resolvable post id.");
  }

  if (method === "mbasic" || method === "auto") {
    const result = await attempt<FbScrapedComment[]>("mbasic", attempts, size, () =>
      scrapeCommentsViaMbasic(parsed.url, cookies, { limit, withReplies }),
    );
    if (result?.length) return { data: result, source: "mbasic", attempts };
    if (method === "mbasic") return { data: result ?? [], source: result ? "mbasic" : null, attempts };
  }

  if (method === "browser" || method === "auto") {
    const result = await attempt<FbScrapedComment[]>("browser", attempts, size, () =>
      scrapeCommentsViaBrowser(parsed.url, cookies, { limit, withReplies, ordering }),
    );
    if (result) return { data: result, source: result.length ? "browser" : null, attempts };
  }

  return { data: [], source: null, attempts };
}

/** Scrape a page/profile's About surfaces, enriched with live header stats. */
export async function scrapeProfile(
  target: string,
  cookies: string,
  method: FbMethod = "auto",
): Promise<ScrapeOutcome<FbScrapedProfile | null>> {
  const parsed = parseFacebookTarget(target);
  const attempts: MethodAttempt[] = [];
  const size = (profile: FbScrapedProfile | null) => (profile ? 1 : 0);

  let profile: FbScrapedProfile | null = null;
  let source: FbScrapeSource | null = null;

  if (method === "mbasic" || method === "auto") {
    profile = await attempt<FbScrapedProfile>("mbasic", attempts, size, () =>
      scrapeProfileViaMbasic(parsed.handle, cookies),
    );
    if (profile) source = "mbasic";
  }

  // mbasic is strong on About fields but weak on follower counts; the rendered
  // header fills those in. Merge rather than pick.
  const thin = !profile || (profile.followers == null && profile.likes == null);
  if (thin && (method === "browser" || method === "auto")) {
    const rendered = await attempt<Awaited<ReturnType<typeof fetchFacebookPageViaBrowser>>>(
      "browser",
      attempts,
      (p) => (p ? 1 : 0),
      () => fetchFacebookPageViaBrowser(parsed.handle, cookies),
    );
    if (rendered) {
      source = profile ? source : "browser";
      profile = {
        id: profile?.id ?? null,
        name: rendered.name || profile?.name || parsed.handle,
        username: profile?.username ?? rendered.handle,
        url: rendered.url,
        profilePic: rendered.profilePic ?? profile?.profilePic ?? null,
        coverPhoto: profile?.coverPhoto ?? null,
        about: profile?.about ?? rendered.about ?? null,
        category: rendered.category ?? profile?.category ?? null,
        verified: rendered.verified || Boolean(profile?.verified),
        followers: rendered.followers ?? profile?.followers ?? null,
        likes: rendered.likes ?? profile?.likes ?? null,
        friendCount: profile?.friendCount ?? null,
        work: profile?.work ?? [],
        education: profile?.education ?? [],
        placesLived: profile?.placesLived ?? [],
        contactInfo: profile?.contactInfo ?? {},
        websites: profile?.websites ?? [],
        fetchedAt: new Date().toISOString(),
        source: profile ? "mbasic" : "browser",
      };
    }
  }

  return { data: profile, source, attempts };
}

/** Group metadata (mbasic only — the rendered group header is unreliable). */
export async function scrapeGroup(
  target: string,
  cookies: string,
): Promise<ScrapeOutcome<FbScrapedGroup | null>> {
  const parsed = parseFacebookTarget(target);
  if (parsed.kind !== "group") throw new Error("That link is not a Facebook group URL.");
  const attempts: MethodAttempt[] = [];
  const group = await attempt<FbScrapedGroup>("mbasic", attempts, (g) => (g ? 1 : 0), () =>
    scrapeGroupViaMbasic(parsed.handle, cookies),
  );
  return { data: group, source: group ? "mbasic" : null, attempts };
}

/** Reactor list + per-reaction breakdown for a post (browser only). */
export async function scrapeReactors(
  postUrl: string,
  cookies: string,
  limit = 100,
): Promise<ScrapeOutcome<{ reactors: FbScrapedReactor[]; breakdown: Record<string, number>; total: number }>> {
  const parsed = parseFacebookTarget(postUrl);
  if (parsed.kind !== "post") throw new Error("Reactors need a post permalink.");
  const attempts: MethodAttempt[] = [];
  const result = await attempt("browser", attempts, (r: any) => r?.reactors?.length ?? 0, () =>
    scrapeReactorsViaBrowser(parsed.url, cookies, { limit }),
  );
  return {
    data: result ?? { reactors: [], breakdown: {}, total: 0 },
    source: result ? "browser" : null,
    attempts,
  };
}
