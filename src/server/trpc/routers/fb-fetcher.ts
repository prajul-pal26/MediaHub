import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { decrypt } from "@/lib/encryption";
import { fetchFacebookPage, type FbPage } from "@/server/services/facebook/fetcher";

export interface FbFetchResult {
  query: string;
  ok: boolean;
  page?: FbPage;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build an app access token ("{app_id}|{app_secret}") from the org's stored FB credentials. */
async function getAppAccessToken(db: any, orgId: string): Promise<string | null> {
  const { data } = await db
    .from("platform_credentials")
    .select("client_id_encrypted, client_secret_encrypted")
    .eq("org_id", orgId)
    .eq("platform", "facebook")
    .maybeSingle();
  if (!data?.client_id_encrypted || !data?.client_secret_encrypted) return null;
  try {
    const appId = decrypt(data.client_id_encrypted);
    const appSecret = decrypt(data.client_secret_encrypted);
    if (!appId || !appSecret) return null;
    return `${appId}|${appSecret}`;
  } catch {
    return null;
  }
}

export const fbFetcherRouter = router({
  fetchPages: protectedProcedure
    .input(
      z.object({
        pages: z.array(z.string().min(1)).min(1).max(20),
        accessToken: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // token: user-provided wins, else the org's configured FB app token
      let token = input.accessToken?.trim() || "";
      let tokenSource: "provided" | "app" | "none" = token ? "provided" : "none";
      if (!token && ctx.profile?.org_id) {
        const appToken = await getAppAccessToken(ctx.db, ctx.profile.org_id);
        if (appToken) {
          token = appToken;
          tokenSource = "app";
        }
      }

      if (!token) {
        return {
          results: input.pages.map((query) => ({
            query,
            ok: false,
            error:
              "No Facebook access token — paste a Page/User token, or configure Facebook credentials in Settings.",
          })),
          succeeded: 0,
          failed: input.pages.length,
          tokenSource,
        };
      }

      const seen = new Set<string>();
      const targets = input.pages
        .map((p) => p.trim().replace(/^@/, ""))
        .filter((p) => p && !seen.has(p) && (seen.add(p), true));

      const results: FbFetchResult[] = [];
      for (let i = 0; i < targets.length; i++) {
        const query = targets[i];
        try {
          const page = await fetchFacebookPage(query, token);
          results.push({ query, ok: true, page });
        } catch (err: any) {
          results.push({ query, ok: false, error: err?.message ?? "Fetch failed" });
        }
        if (i < targets.length - 1) await sleep(500);
      }

      return {
        results,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        tokenSource,
      };
    }),
});
