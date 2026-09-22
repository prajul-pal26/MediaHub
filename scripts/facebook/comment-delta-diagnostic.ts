/**
 * Read-only live diagnostic for Facebook comment gaps.
 *
 * It selects one Photo and one Reel from every non-empty delta bucket in a
 * managed Sheet, runs the real comment collector, and prints only aggregate
 * results. It never writes Supabase or Google Sheets. Run with a single shared
 * browser and serial contexts so the diagnostic itself cannot exhaust memory.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { ensureFacebookPageCallbackRuntime, fetchFacebookMediaComments, selectCommentView } from "../../src/server/services/facebook/media-comments";
import { createFacebookContext, resetSharedBrowser } from "../../src/server/services/facebook/browser-pool";
import { flattenFbComments } from "../../src/lib/fb-export";
import { mergeSavedComments } from "../../src/server/services/facebook/media-drive-export";
import { enrichMediaSheetPages } from "../../src/server/services/facebook/media-sheet-job";
import type { MediaCommentProgress } from "../../src/server/services/facebook/comment-jobs";
import { summarizeFbComments, type FbBrowserComment, type FbBrowserPage } from "../../src/server/services/facebook/browser-fetcher";

const SHEET_ID = "1c_5B7dex_dX0ZKfqci960zVNR0bGe1gLpX4nx32YKPY";
const BUCKETS = [
  { label: "0-9", min: 0, max: 9 }, { label: "10-19", min: 10, max: 19 },
  { label: "20-29", min: 20, max: 29 }, { label: "30-39", min: 30, max: 39 },
  { label: "40-49", min: 40, max: 49 }, { label: "50-59", min: 50, max: 59 },
  { label: "60-69", min: 60, max: 69 }, { label: "70-79", min: 70, max: 79 },
  { label: "80-89", min: 80, max: 89 }, { label: "90-99", min: 90, max: 99 },
  { label: "100+", min: 100, max: Number.POSITIVE_INFINITY },
] as const;
type ContentType = "posts" | "reels";
type Candidate = { collection: "Photos" | "Reels"; contentType: ContentType; bucket: string; id: string; reported: number; saved: number; savedJsonCount: number; savedComments: FbBrowserComment[]; delta: number; url: string };
type WorkspacePost = {
  postId?: string;
  url?: string;
  commentsReportedCount?: number | string | null;
  commentsData?: FbBrowserComment[];
};
type WorkspacePage = { contentType?: ContentType; posts?: WorkspacePost[] };

function count(value: unknown): number | null {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function sheetAccessToken() {
  const stored = JSON.parse(readFileSync("/Users/pranjul/workspace/governance_report/credentials/token.json", "utf8"));
  const clientId = stored.client_id ?? stored.clientId ?? stored.web?.client_id;
  const clientSecret = stored.client_secret ?? stored.clientSecret ?? stored.web?.client_secret;
  const refreshToken = stored.refresh_token ?? stored.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("The verified local Sheets credential is incomplete.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Google authorization refresh failed (${response.status}).`);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google authorization refresh returned no access token.");
  return body.access_token;
}

/** Read the candidate's mutable local snapshot after retries. This is distinct
 * from the final Google Sheet report, which intentionally remains unchanged
 * until the user presses Sync to Google Sheet. */
async function workspaceCandidates(): Promise<Candidate[]> {
  const profileUrl = process.env.DIAGNOSTIC_PROFILE_URL;
  const requestedPostId = process.env.DIAGNOSTIC_POST_ID?.trim();
  if (!profileUrl) throw new Error("DIAGNOSTIC_PROFILE_URL is required when inspecting the local workspace.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await db.from("fb_profile_workspaces").select("pages").eq("profile_url", profileUrl).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !Array.isArray(data?.pages)) throw new Error("The selected candidate workspace could not be read.");

  const selected: Candidate[] = [];
  for (const page of data.pages as WorkspacePage[]) {
    if (page.contentType !== "posts" && page.contentType !== "reels") continue;
    const collection: Candidate["collection"] = page.contentType === "reels" ? "Reels" : "Photos";
    const matches = (page.posts ?? []).flatMap((post) => {
      const id = String(post.postId ?? "").trim();
      const reported = count(post.commentsReportedCount);
      const savedComments = Array.isArray(post.commentsData) ? post.commentsData : [];
      const saved = flattenFbComments(savedComments).length;
      if (!/^\d{1,40}$/.test(id) || reported == null) return [];
      if (requestedPostId && id !== requestedPostId) return [];
      return [{ id, reported, saved, savedJsonCount: saved, savedComments, delta: Math.max(0, reported - saved), url: post.url || (page.contentType === "reels" ? `https://www.facebook.com/reel/${id}/` : `https://www.facebook.com/photo.php?fbid=${id}`) }];
    });
    for (const bucket of BUCKETS) {
      const inBucket = matches.filter((candidate) => candidate.delta >= bucket.min && candidate.delta <= bucket.max)
        .sort((left, right) => right.delta - left.delta || right.reported - left.reported);
      const samples = process.env.DIAGNOSTIC_ALL === "1" ? inBucket : inBucket.slice(0, 1);
      selected.push(...samples.map((sample) => ({ collection, contentType: page.contentType!, bucket: bucket.label, ...sample })));
    }
  }
  const requestedBuckets = new Set((process.env.DIAGNOSTIC_BUCKETS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const requestedCollections = new Set((process.env.DIAGNOSTIC_COLLECTIONS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  return selected.filter((candidate) =>
    (!requestedBuckets.size || requestedBuckets.has(candidate.bucket))
    && (!requestedCollections.size || requestedCollections.has(candidate.collection)),
  );
}

async function selectCandidates(): Promise<Candidate[]> {
  if (process.env.DIAGNOSTIC_SOURCE === "workspace") return workspaceCandidates();
  const accessToken = await sheetAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?ranges=Photos!A:AZ&ranges=Reels!A:AZ`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Sheets read failed (${response.status}).`);
  const body = await response.json() as { valueRanges?: { range?: string; values?: unknown[][] }[] };
  const selected: Candidate[] = [];
  for (const valueRange of body.valueRanges ?? []) {
    const collection = valueRange.range?.startsWith("Reels!") ? "Reels" : "Photos";
    const contentType: ContentType = collection === "Reels" ? "reels" : "posts";
    const [header = [], ...rows] = valueRange.values ?? [];
    const index = (column: string) => header.findIndex((value) => String(value) === column);
    const postId = index("Post ID"), reported = index("Comments Count (Reported)"), saved = index("Comments Scraped Count");
    const commentsJsonColumns = header.flatMap((value, column) => /^Comments JSON(?: \(continued \d+\))?$/.test(String(value)) ? [column] : []);
    if (postId < 0 || reported < 0 || saved < 0) throw new Error(`${collection} is missing a managed comment-count column.`);
    for (const bucket of BUCKETS) {
      const matches = rows.flatMap((row) => {
        const id = String(row[postId] ?? "").trim();
        const reportedCount = count(row[reported]);
        const savedCount = count(row[saved]);
        if (!/^\d{1,40}$/.test(id) || reportedCount == null || savedCount == null) return [];
        const delta = Math.max(0, reportedCount - savedCount);
        let savedComments: FbBrowserComment[] = [];
        const storedJson = commentsJsonColumns.map((column) => String(row[column] ?? "")).join("");
        if (storedJson) {
          try {
            const parsed = JSON.parse(storedJson);
            if (Array.isArray(parsed)) savedComments = parsed as FbBrowserComment[];
          } catch { /* A malformed historical cell remains visible as a data-quality issue. */ }
        }
        return delta >= bucket.min && delta <= bucket.max ? [{ id, reported: reportedCount, saved: savedCount, savedJsonCount: flattenFbComments(savedComments).length, savedComments, delta }] : [];
      });
      // Highest gap in each band is the most useful way to expose a collector
      // limitation without downloading every row before the diagnosis is known.
      const samples = process.env.DIAGNOSTIC_ALL === "1"
        ? matches.sort((left, right) => right.delta - left.delta || right.reported - left.reported)
        : matches.sort((left, right) => right.delta - left.delta || right.reported - left.reported).slice(0, 1);
      for (const sample of samples) selected.push({ collection, contentType, bucket: bucket.label, ...sample,
        url: contentType === "reels" ? `https://www.facebook.com/reel/${sample.id}/` : `https://www.facebook.com/photo.php?fbid=${sample.id}`,
      });
    }
  }
  const requestedBuckets = new Set((process.env.DIAGNOSTIC_BUCKETS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const requestedCollections = new Set((process.env.DIAGNOSTIC_COLLECTIONS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  return selected.filter((candidate) =>
    (!requestedBuckets.size || requestedBuckets.has(candidate.bucket))
    && (!requestedCollections.size || requestedCollections.has(candidate.collection)),
  );
}

async function activeCookies() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await db.from("fb_sessions").select("cookie_encrypted").eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data?.cookie_encrypted) throw new Error("No active Facebook session is available for the diagnostic.");
  return decrypt(data.cookie_encrypted);
}

/**
 * Opt-in, single-item workspace update for a controlled diagnostic. This uses
 * the same additive merge as the retry job and is intentionally disabled
 * unless the caller asks for it. It never writes to Google Sheets.
 */
async function applyWorkspaceResult(candidate: Candidate, result: Awaited<ReturnType<typeof fetchFacebookMediaComments>>) {
  if (process.env.DIAGNOSTIC_APPLY_WORKSPACE !== "1") return false;
  const profileUrl = process.env.DIAGNOSTIC_PROFILE_URL;
  if (!profileUrl) throw new Error("DIAGNOSTIC_PROFILE_URL is required when updating the local workspace.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await db.from("fb_profile_workspaces")
    .select("org_id,brand_id,profile_key,pages")
    .eq("profile_url", profileUrl)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.pages || !Array.isArray(data.pages)) throw new Error("The selected candidate workspace could not be reloaded for the diagnostic update.");

  const progress: MediaCommentProgress = {
    status: "completed", total: 1, completed: 1, active: 0, failed: 0,
    partial: result.status === "partial" ? 1 : 0,
    partialComments: result.commentsStatus === "partial" || result.status === "partial" ? 1 : 0,
    partialDetails: 0,
    commentCount: flattenFbComments(result.comments).length,
    observedCommentCount: result.observedCommentCount,
    excludedNonTextCommentCount: result.excludedNonTextCommentCount,
    excludedAttachmentCommentCount: result.excludedAttachmentCommentCount,
    durationMs: result.durationMs,
    includeComments: true, includeReactions: false, includeMetadata: false,
    items: [{
      postId: candidate.id, url: candidate.url, contentType: candidate.contentType,
      includeComments: true, includeReactions: false, includeMetadata: false,
      status: result.status, comments: result.comments, error: result.error,
      stopReason: result.stopReason, durationMs: result.durationMs,
      reportedCount: result.reportedCount, panelReportedCount: result.panelReportedCount, observedCommentCount: result.observedCommentCount,
      textCommentCount: result.textCommentCount,
      excludedNonTextCommentCount: result.excludedNonTextCommentCount,
      excludedAttachmentCommentCount: result.excludedAttachmentCommentCount,
      commentsContentScope: result.commentsContentScope,
      commentsSourceView: result.commentsSourceView,
      commentsStatus: result.commentsStatus ?? result.status,
      // The workspace merge distinguishes one browser execution from its
      // repeated progress snapshots. A diagnostic is also one execution, so
      // give it the same opaque marker as a normal retry; otherwise two clean
      // diagnostic scans can never establish a verified accessible count.
      attemptId: randomUUID(),
    }],
  };
  const pages = enrichMediaSheetPages(data.pages as unknown as FbBrowserPage[], progress);
  const { error: updateError } = await db.from("fb_profile_workspaces").update({ pages, updated_at: new Date().toISOString() })
    .eq("org_id", data.org_id).eq("brand_id", data.brand_id).eq("profile_key", data.profile_key);
  if (updateError) throw new Error("The diagnostic result could not be saved to the local workspace.");
  return true;
}

/** Structural evidence only: no comment text, identifiers, or cookies. */
async function surfaceSummary(candidate: Candidate, cookies: string) {
  const context = await createFacebookContext(cookies, { blockMedia: true });
  const page = await context.newPage();
  try {
    await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await ensureFacebookPageCallbackRuntime(page);
    await page.waitForTimeout(3_000);
    const commentButton = page.getByRole("button", { name: "Comment", exact: true }).first();
    if (await commentButton.isVisible().catch(() => false)) await commentButton.click().catch(() => {});
    await page.waitForTimeout(2_000);
    const collectorSelection = await selectCommentView(page);
    const orderingControl = page.locator('button, [role="button"]')
      .filter({ hasText: /^(Most relevant|All comments|Newest)[\s\uFEFF]*$/i }).first();
    let newestMenuItemVisible = false;
    let newestMenuItemClicked = false;
    if (await orderingControl.isVisible().catch(() => false)) {
      await orderingControl.click().catch(() => {});
      await page.waitForTimeout(1_500);
      const newestMenuItem = page.getByRole("menuitem", { name: /^Newest(?:\s|$)/i }).first();
      newestMenuItemVisible = await newestMenuItem.isVisible().catch(() => false);
      if (newestMenuItemVisible) {
        newestMenuItemClicked = await newestMenuItem.click().then(() => true).catch(() => false);
        await page.waitForTimeout(1_000);
      }
    }
    const orderingAfter = await orderingControl.innerText().catch(() => "");
    return await page.evaluate(({ newestMenuItemVisible, newestMenuItemClicked, orderingAfter, collectorSelection }) => {
      const visible = (node: Element) => node.getClientRects().length > 0;
      const labels = [...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='menuitem'], [role='option']")]
        .filter(visible).map((node) => (node.innerText || "").replace(/\s+/g, " ").trim())
        .filter((value) => /comment|newest|relevant|hidden|more|repl/i.test(value)).slice(0, 30);
      const ordering = [...document.querySelectorAll<HTMLElement>("*")]
        .filter((node) => visible(node) && /^(Most relevant|All comments|Newest)$/i.test((node.innerText || "").trim()))
        .slice(0, 8)
        .map((node) => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute("role"), ariaHasPopup: node.getAttribute("aria-haspopup"), tabIndex: node.getAttribute("tabindex") }));
      const menuChoices = [...document.querySelectorAll<HTMLElement>("*")]
        .filter((node) => visible(node) && /^(All comments|Newest)(?:\s|$)/i.test((node.innerText || "").trim()))
        .slice(0, 12)
        .map((node) => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute("role"), tabIndex: node.getAttribute("tabindex"), text: (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100) }));
      return {
        commentCards: document.querySelectorAll('[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]').length,
        commentLinks: document.querySelectorAll('a[href*="comment_id"], a[href*="reply_comment_id"]').length,
        dialogs: document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]').length,
        controls: [...new Set(labels)],
        ordering,
        menuChoices,
        selection: { collectorSelection, newestMenuItemVisible, newestMenuItemClicked, orderingAfter },
      };
    }, { newestMenuItemVisible, newestMenuItemClicked, orderingAfter, collectorSelection });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function main() {
  const candidates = await selectCandidates();
  const cookies = await activeCookies();
  const requestedTimeout = Number(process.env.DIAGNOSTIC_TIMEOUT_MS);
  const perItemTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(600_000, Math.max(5_000, Math.floor(requestedTimeout)))
    : null;
  console.log(`Selected ${candidates.length} representative media items across non-empty delta buckets.`);
  const results: Record<string, unknown>[] = [];
  try {
    for (const candidate of candidates) {
      const started = Date.now();
      if (process.env.DIAGNOSTIC_SURFACE_ONLY === "1") {
        try {
          results.push({ collection: candidate.collection, bucket: candidate.bucket, surface: await surfaceSummary(candidate, cookies), seconds: Math.round((Date.now() - started) / 1000) });
        } catch (error) {
          results.push({ collection: candidate.collection, bucket: candidate.bucket, status: "error", error: error instanceof Error ? error.message.slice(0, 180) : "Unknown error", seconds: Math.round((Date.now() - started) / 1000) });
        }
        continue;
      }
      const controller = new AbortController();
      const timer = perItemTimeoutMs ? setTimeout(() => controller.abort(), perItemTimeoutMs) : undefined;
      try {
        const result = await fetchFacebookMediaComments({ postId: candidate.id, url: candidate.url, contentType: candidate.contentType }, cookies, {
          limit: 0, withReplies: true, includeComments: true, includeReactions: false, includeMetadata: false, signal: controller.signal,
        });
        const live = flattenFbComments(result.comments).length;
        const merged = mergeSavedComments(candidate.savedComments, result.comments).comments;
        const retainedAfterMerge = flattenFbComments(merged).length;
        const liveBreakdown = summarizeFbComments(result.comments);
        const retainedBreakdown = summarizeFbComments(merged);
        const workspaceUpdated = await applyWorkspaceResult(candidate, result);
        results.push({ collection: candidate.collection, bucket: candidate.bucket, saved: candidate.saved, savedJson: candidate.savedJsonCount, reported: candidate.reported,
          liveReported: result.reportedCount ?? null, panelReported: result.panelReportedCount ?? null, live, liveBreakdown, retainedAfterMerge, retainedBreakdown,
          remainingDelta: Math.max(0, (result.reportedCount ?? candidate.reported) - retainedAfterMerge), status: result.status, commentStatus: result.commentsStatus ?? result.status,
          sourceView: result.commentsSourceView ?? "unknown", stop: result.stopReason, workspaceUpdated, seconds: Math.round((Date.now() - started) / 1000) });
        if (process.env.DIAGNOSTIC_SURFACE === "1") results.push({ collection: candidate.collection, bucket: candidate.bucket, surface: await surfaceSummary(candidate, cookies) });
      } catch (error) {
        results.push({ collection: candidate.collection, bucket: candidate.bucket, saved: candidate.saved, savedJson: candidate.savedJsonCount, reported: candidate.reported,
          status: "error", error: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[link]").slice(0, 180) : "Unknown error",
          seconds: Math.round((Date.now() - started) / 1000) });
        if (process.env.DIAGNOSTIC_SURFACE === "1") results.push({ collection: candidate.collection, bucket: candidate.bucket, surface: await surfaceSummary(candidate, cookies) });
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Avoid turning a diagnostic into an account-wide burst. Contexts close
      // after each item; the one shared browser is reset in finally below.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    await resetSharedBrowser();
  }
  console.log(JSON.stringify(results));
}

main().catch(async (error) => {
  await resetSharedBrowser();
  console.error(error instanceof Error ? error.message : "Diagnostic failed.");
  process.exitCode = 1;
});
