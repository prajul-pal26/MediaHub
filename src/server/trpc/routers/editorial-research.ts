import { z } from "zod";
import { decrypt } from "@/lib/encryption";
import { router, protectedProcedure } from "../index";

const sourceSchema = z.enum(["news", "social_post", "manual"]);
const evidenceSchema = z.enum(["needs_review", "supported", "needs_context", "rejected"]);
const relevanceSchema = z.enum(["unreviewed", "relevant", "not_relevant"]);

type ExternalSource = {
  externalKey: string;
  sourceType: "news" | "social_post";
  sourceName: string;
  sourceUrl: string;
  headline: string;
  summary: string | null;
  district: string | null;
  topic: string | null;
  publishedAt: string | null;
};

async function loadExternalSources(baseUrl: string, apiKey: string): Promise<ExternalSource[]> {
  const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  const base = baseUrl.replace(/\/$/, "");
  const [newsResponse, postsResponse] = await Promise.all([
    fetch(`${base}/rest/v1/NEWS%20ARTICLE?select=id,source,news_link,heading,description,district,gov_category,published_ist,date&order=date.desc,id.desc&limit=100`, { headers, cache: "no-store" }),
    fetch(`${base}/rest/v1/v_tweet_feed?select=id,author,text,english_translation,created_at,district,url&order=created_at.desc&limit=100`, { headers, cache: "no-store" }),
  ]);
  if (!newsResponse.ok || !postsResponse.ok) throw new Error("The connected news source could not be read.");
  const [newsRows, postRows] = await Promise.all([newsResponse.json(), postsResponse.json()]) as [any[], any[]];
  return [
    ...newsRows.filter((row) => row.id && row.news_link && row.heading).map((row) => ({
      externalKey: `news:${row.id}`,
      sourceType: "news" as const,
      sourceName: String(row.source || "News source"),
      sourceUrl: String(row.news_link),
      headline: String(row.heading),
      summary: row.description ? String(row.description) : null,
      district: row.district ? String(row.district) : null,
      topic: row.gov_category ? String(row.gov_category) : null,
      publishedAt: row.published_ist ? String(row.published_ist) : row.date ? `${String(row.date)}T12:00:00.000Z` : null,
    })),
    ...postRows.filter((row) => row.id && row.url && (row.english_translation || row.text)).map((row) => ({
      externalKey: `social:${row.id}`,
      sourceType: "social_post" as const,
      sourceName: row.author ? `@${String(row.author)}` : "Social post",
      sourceUrl: String(row.url),
      headline: String(row.english_translation || row.text).slice(0, 500),
      summary: row.text ? String(row.text) : null,
      district: row.district ? String(row.district) : null,
      topic: null,
      publishedAt: row.created_at ? String(row.created_at) : null,
    })),
  ];
}

export const editorialResearchRouter = router({
  list: protectedProcedure
    .input(z.object({
      district: z.string().trim().optional(),
      status: evidenceSchema.optional(),
      publishedFrom: z.string().date().optional(),
      publishedTo: z.string().date().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      let query = ctx.db
        .from("editorial_research_items")
        .select("id,source_type,source_name,source_url,headline,summary,district,topic,published_at,evidence_status,relevance,reviewer_note,reviewed_at,created_at")
        .eq("org_id", ctx.profile!.org_id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (input?.district) query = query.eq("district", input.district);
      if (input?.status) query = query.eq("evidence_status", input.status);
      if (input?.publishedFrom) query = query.gte("published_at", `${input.publishedFrom}T00:00:00.000Z`);
      if (input?.publishedTo) {
        const endExclusive = new Date(`${input.publishedTo}T00:00:00.000Z`);
        endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
        query = query.lt("published_at", endExclusive.toISOString());
      }
      const { data, error } = await query;
      if (error) throw new Error("Could not load the editorial review queue.");
      return data ?? [];
    }),

  summary: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from("editorial_research_items")
      .select("district,evidence_status,relevance")
      .eq("org_id", ctx.profile!.org_id);
    if (error) throw new Error("Could not load editorial review counts.");
    const items = data ?? [];
    return {
      total: items.length,
      awaitingReview: items.filter((item: any) => item.evidence_status === "needs_review").length,
      supported: items.filter((item: any) => item.evidence_status === "supported").length,
      districts: new Set(items.map((item: any) => item.district).filter(Boolean)).size,
    };
  }),

  connectionStatus: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from("editorial_source_connections")
      .select("source_name,active,last_synced_at,last_sync_count")
      .eq("org_id", ctx.profile!.org_id)
      .maybeSingle();
    if (error) throw new Error("Could not load the source connection status.");
    return data ?? { source_name: null, active: false, last_synced_at: null, last_sync_count: 0 };
  }),

  syncExternal: protectedProcedure.mutation(async ({ ctx }) => {
    const { data: connection, error: connectionError } = await ctx.db
      .from("editorial_source_connections")
      .select("source_name,base_url,anon_key_encrypted,active")
      .eq("org_id", ctx.profile!.org_id)
      .eq("active", true)
      .maybeSingle();
    if (connectionError || !connection) throw new Error("No active editorial source connection is configured.");
    const fetched = await loadExternalSources(connection.base_url, decrypt(connection.anon_key_encrypted));
    const keys = fetched.map((item) => item.externalKey);
    const { data: existing, error: existingError } = keys.length
      ? await ctx.db.from("editorial_research_items").select("external_source_key").eq("org_id", ctx.profile!.org_id).in("external_source_key", keys)
      : { data: [], error: null };
    if (existingError) throw new Error("Could not check the existing editorial pool.");
    const existingKeys = new Set((existing ?? []).map((item: any) => item.external_source_key));
    const newItems = fetched.filter((item) => !existingKeys.has(item.externalKey));
    if (newItems.length) {
      const { error: insertError } = await ctx.db.from("editorial_research_items").insert(newItems.map((item) => ({
        org_id: ctx.profile!.org_id,
        external_source_key: item.externalKey,
        source_type: item.sourceType,
        source_name: item.sourceName,
        source_url: item.sourceUrl,
        headline: item.headline,
        summary: item.summary,
        district: item.district,
        topic: item.topic,
        published_at: item.publishedAt,
      })));
      if (insertError) throw new Error("Could not add sources to the editorial pool.");
    }
    await ctx.db.from("editorial_source_connections").update({ last_synced_at: new Date().toISOString(), last_sync_count: newItems.length, updated_at: new Date().toISOString() }).eq("org_id", ctx.profile!.org_id);
    return { fetched: fetched.length, added: newItems.length, sourceName: connection.source_name };
  }),

  add: protectedProcedure
    .input(z.object({
      sourceType: sourceSchema,
      sourceName: z.string().trim().min(1).max(200),
      sourceUrl: z.string().url().max(2000),
      headline: z.string().trim().min(1).max(500),
      summary: z.string().trim().max(5000).optional(),
      district: z.string().trim().max(200).optional(),
      topic: z.string().trim().max(200).optional(),
      publishedAt: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db.from("editorial_research_items").insert({
        org_id: ctx.profile!.org_id,
        source_type: input.sourceType,
        source_name: input.sourceName,
        source_url: input.sourceUrl,
        headline: input.headline,
        summary: input.summary || null,
        district: input.district || null,
        topic: input.topic || null,
        published_at: input.publishedAt || null,
      });
      if (error) throw new Error("Could not add the source to the editorial review queue.");
      return { ok: true };
    }),

  review: protectedProcedure
    .input(z.object({ id: z.string().uuid(), evidenceStatus: evidenceSchema, relevance: relevanceSchema, reviewerNote: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db
        .from("editorial_research_items")
        .update({ evidence_status: input.evidenceStatus, relevance: input.relevance, reviewer_note: input.reviewerNote || null, reviewed_by: ctx.user!.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", input.id)
        .eq("org_id", ctx.profile!.org_id);
      if (error) throw new Error("Could not save the editorial review.");
      return { ok: true };
    }),
});
