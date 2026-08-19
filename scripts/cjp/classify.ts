/**
 * Relevance + geography scoring for harvested rows.
 *
 * Three independent questions, deliberately kept separate:
 *   1. Is this about the CJP *School Theek Karo* campaign specifically?
 *   2. Is it about Uttar Pradesh?
 *   3. Is it inside the campaign window?
 *
 * (1) needs tiering, learned the hard way: matching a bare "CJP" pulled in the
 * July Jantar Mantar exam-leak protest and even an unrelated viral "teacher
 * dances" clip that merely carried a #cjp tag. So an org mention alone is not
 * enough — it must co-occur with genuine school context and not look like
 * entertainment. (2) matters because the campaign is nationwide; most of its
 * content is Maharashtra or Bihar, not UP.
 *
 * Every row carries the evidence behind its verdict so the filter is auditable
 * rather than trusted.
 */
import {
  CAMPAIGN_CORE,
  CAMPAIGN_ORG,
  ENTERTAINMENT_NOISE,
  EXCLUDE_TERMS,
  OTHER_STATES,
  RECENCY_DAYS,
  SCHOOL_CONTEXT,
  UP_DISTRICTS,
  UP_POLICY_TERMS,
  UP_PROTEST_EVENTS,
  UP_STRONG,
} from "./config";

/**
 * `up_protest` covers the Gen Alpha UP student protests (Hamirpur, Fatehpur)
 * that CJP amplified but did not organise — coverage of those often never names
 * CJP, yet it is the actual viral UP story the user is after.
 */
export type CampaignTier = "core" | "org_school" | "up_protest" | "org_only" | "none";

export interface Classification {
  campaignTier: CampaignTier;
  isCampaign: boolean;
  campaignEvidence: string[];
  schoolEvidence: string[];
  noiseEvidence: string[];
  isUp: boolean;
  upConfidence: "strong" | "district" | "policy" | "none";
  upEvidence: string[];
  otherStateEvidence: string[];
  isRecent: boolean;
  ageDays: number | null;
  score: number;
}

function matches(patterns: RegExp[], text: string): string[] {
  const hits: string[] = [];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) hits.push(m[0].trim());
  }
  return [...new Set(hits)];
}

function ageInDays(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

export function classify(
  text: string,
  publishedIso: string | null | undefined,
  engagement: { views?: number | null; likes?: number | null; comments?: number | null } = {},
  now = Date.now(),
): Classification {
  const blob = (text || "").replace(/\s+/g, " ");

  const core = matches(CAMPAIGN_CORE, blob);
  const org = matches(CAMPAIGN_ORG, blob);
  const school = matches(SCHOOL_CONTEXT, blob);
  const noise = matches(ENTERTAINMENT_NOISE, blob);
  const excluded = matches(EXCLUDE_TERMS, blob);
  const upEvent = matches(UP_PROTEST_EVENTS, blob);

  let campaignTier: CampaignTier = "none";
  if (excluded.length && !core.length) {
    // Name-collision material (UP govt's School Chalo Abhiyan, or the unrelated
    // Citizens for Justice and Peace) — never campaign content.
    campaignTier = "none";
  } else if (core.length) campaignTier = "core";
  else if (org.length && school.length && !noise.length) campaignTier = "org_school";
  else if (upEvent.length && school.length && !noise.length) campaignTier = "up_protest";
  else if (org.length) campaignTier = "org_only";

  const upStrong = matches(UP_STRONG, blob);
  const upDistricts = matches(UP_DISTRICTS, blob);
  const upPolicy = matches(UP_POLICY_TERMS, blob);
  const otherStateEvidence = matches(OTHER_STATES, blob);

  let upConfidence: Classification["upConfidence"] = "none";
  if (upStrong.length) upConfidence = "strong";
  else if (upDistricts.length) upConfidence = "district";
  else if (upPolicy.length) upConfidence = "policy";

  const ageDays = ageInDays(publishedIso, now);
  const isRecent = ageDays == null ? false : ageDays <= RECENCY_DAYS;

  // A district-only hit alongside another state's name is unreliable — e.g. a
  // Bihar bulletin that mentions Lucknow in passing.
  const upContested = upConfidence === "district" && otherStateEvidence.length > 0;
  const isUp = upConfidence === "strong" || (upConfidence === "district" && !upContested);

  const views = engagement.views ?? 0;
  const viralPoints = views > 0 ? Math.min(28, Math.log10(views + 1) * 4.2) : 0;
  const engagementPoints = Math.min(
    8,
    Math.log10((engagement.likes ?? 0) + (engagement.comments ?? 0) + 1) * 2.4,
  );

  let score = 0;
  if (campaignTier === "core") score += 34;
  else if (campaignTier === "org_school") score += 20;
  else if (campaignTier === "up_protest") score += 24;
  else if (campaignTier === "org_only") score += 6;
  if (isUp) score += upConfidence === "strong" ? 18 : 11;
  if (isRecent) score += 6;
  if (ageDays != null && ageDays <= 5) score += 6;
  score += viralPoints + engagementPoints;
  if (noise.length && campaignTier !== "core") score -= 15;

  return {
    campaignTier,
    isCampaign:
      campaignTier === "core" || campaignTier === "org_school" || campaignTier === "up_protest",
    campaignEvidence: [...core, ...org, ...upEvent],
    schoolEvidence: school,
    noiseEvidence: [...noise, ...excluded],
    isUp,
    upConfidence,
    upEvidence: [...upStrong, ...upDistricts, ...upPolicy],
    otherStateEvidence,
    isRecent,
    ageDays: ageDays == null ? null : Math.round(ageDays * 10) / 10,
    score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
  };
}

/** Strict deliverable filter: genuinely on-campaign AND Uttar Pradesh AND recent. */
export function passesStrict(c: Classification): boolean {
  return c.isCampaign && c.isUp && c.isRecent;
}
