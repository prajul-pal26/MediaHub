import type { Page } from "playwright-core";
import { engagementLabelsFromPayloads } from "./media-engagement-data";
import { nativeMediaPayloads } from "./media-native-payloads";

export const REACTION_KINDS = ["like", "love", "care", "haha", "wow", "sad", "angry"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export interface MediaEngagement {
  status: "complete" | "partial";
  totalReactions: number | null;
  reactions: Partial<Record<ReactionKind, number>>;
  shares: number | null;
  approximate?: boolean;
  error?: string;
}

interface CountReading { count: number; approximate: boolean }
export interface EngagementLabels {
  totals: string[];
  shares: string[];
  reactions: { label: string; icons?: string[] }[];
}

const clean = (value: string) => value.replace(/[\u00a0\u202f\uFEFF]/g, " ").replace(/\s+/g, " ").trim();

/** Only a complete counter token is accepted; names, dates and prose are not counts. */
export function parseEngagementCount(value: string): CountReading | null {
  const text = clean(value);
  if (/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/.test(text)) {
    const count = Number(text.replace(/,/g, ""));
    return Number.isSafeInteger(count) ? { count, approximate: false } : null;
  }
  const short = /^(\d+(?:\.\d+)?)\s*(K|M|B|L|thousand|million|billion|lakh|crore)$/i.exec(text);
  if (!short) return null;
  const scale: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, l: 1e5, lakh: 1e5, crore: 1e7 };
  const count = Number(short[1]) * scale[short[2].toLowerCase()];
  return Number.isSafeInteger(Math.round(count)) ? { count: Math.round(count), approximate: true } : null;
}

const reactionWord = (kind: ReactionKind) => kind === "angry" ? "angr(?:y|ies)" : `${kind}s?`;

function countInLabel(value: string, kind: "total" | "shares" | ReactionKind): CountReading | null {
  let label = clean(value).toLowerCase();
  const expected = kind === "total" ? /\b(all|total|reactions?|reacted)\b/ : kind === "shares" ? /\bshares?\b/ : new RegExp(`\\b${reactionWord(kind)}\\b`);
  if (!expected.test(label)) return null;
  label = label.replace(/\b(?:all|total|show|who|with|reactions?|reacted|people|person|shares?|likes?|loves?|cares?|hahas?|wows?|sads?|angr(?:y|ies))\b/g, " ").replace(/[:()]/g, " ");
  return parseEngagementCount(label);
}

function consensus(readings: CountReading[]): CountReading | null {
  // An exact count supersedes its rounded display counterpart. Conflicting
  // exact counts are not resolved by choosing the larger number.
  const exact = readings.filter((r) => !r.approximate);
  const candidates = exact.length ? exact : readings;
  if (!candidates.length || new Set(candidates.map((r) => r.count)).size !== 1) return null;
  return candidates[0];
}

/** No missing reaction category becomes zero without an exact accounting total. */
export function engagementFromLabels(labels: EngagementLabels): MediaEngagement {
  // These arrays are already scoped to their native counter. Keep raw numeric
  // acceptance here so a bare number never becomes a clickable inspector.
  const total = consensus(labels.totals.map((s) => countInLabel(s, "total") ?? parseEngagementCount(s)).filter((r): r is CountReading => r !== null));
  const shared = consensus(labels.shares.map((s) => countInLabel(s, "shares") ?? parseEngagementCount(s)).filter((r): r is CountReading => r !== null));
  const typed: Partial<Record<ReactionKind, CountReading>> = {};
  for (const kind of REACTION_KINDS) {
    const readings = labels.reactions.flatMap((row) => {
      const source = [row.label, ...(row.icons ?? [])].map(clean).join(" ");
      const types = REACTION_KINDS.filter((k) => new RegExp(`\\b${reactionWord(k)}\\b`, "i").test(source));
      if (types.length !== 1 || types[0] !== kind) return [];
      // A tab can have only the numeric text with its type on the icon's alt.
      const reading = countInLabel(row.label, kind) ?? countInLabel(`${row.label} ${kind}`, kind);
      return reading ? [reading] : [];
    });
    const result = consensus(readings);
    if (result) typed[kind] = result;
  }
  const known = Object.values(typed);
  const sum = known.reduce((n, r) => n + r.count, 0);
  const allTypedExact = known.every((r) => !r.approximate);
  const effectiveTotal = total ?? (known.length === REACTION_KINDS.length && allTypedExact ? { count: sum, approximate: false } : null);
  const inconsistent = Boolean(effectiveTotal && !effectiveTotal.approximate && allTypedExact
    && (sum > effectiveTotal.count || (known.length === REACTION_KINDS.length && sum !== effectiveTotal.count)));
  if (effectiveTotal && !effectiveTotal.approximate && allTypedExact && sum === effectiveTotal.count) {
    for (const kind of REACTION_KINDS) typed[kind] ??= { count: 0, approximate: false };
  }
  const reactions: Partial<Record<ReactionKind, number>> = {};
  for (const kind of REACTION_KINDS) if (typed[kind]) reactions[kind] = typed[kind]!.count;
  const complete = !inconsistent && effectiveTotal !== null && shared !== null && Object.keys(reactions).length === REACTION_KINDS.length;
  const approximate = Boolean(effectiveTotal?.approximate || shared?.approximate || Object.values(typed).some((r) => r.approximate));
  return {
    status: complete ? "complete" : "partial",
    totalReactions: effectiveTotal?.count ?? null,
    reactions,
    shares: shared?.count ?? null,
    ...(approximate ? { approximate: true } : {}),
    ...(!complete ? { error: inconsistent ? "Visible reaction counts disagree with the total." : "Some reaction or share counts were not exposed by the visible controls." } : {}),
  };
}

/** Keep the newer category snapshot together and preserve rounded-count provenance. */
export function mergeEngagementViews(initial: MediaEngagement, fallback: MediaEngagement): MediaEngagement {
  if (fallback.status === "complete") return fallback;
  const totalReactions = fallback.totalReactions ?? initial.totalReactions;
  const shares = fallback.shares ?? initial.shares;
  const reactions = Object.keys(fallback.reactions).length ? fallback.reactions : initial.reactions;
  const combined = engagementFromLabels({
    totals: totalReactions !== null ? [`${totalReactions} reactions`] : [],
    shares: shares !== null ? [`${shares} shares`] : [],
    reactions: Object.entries(reactions).map(([kind, count]) => ({ label: `${kind} ${count}` })),
  });
  if (!initial.approximate && !fallback.approximate) return combined;
  // Converting a rounded display back to an integer must never establish zero
  // for a missing type. Retain only the supplied categories in this case.
  const complete = combined.status === "complete" && Object.keys(reactions).length === REACTION_KINDS.length;
  return {
    ...combined, reactions, approximate: true, status: complete ? "complete" : "partial",
    ...(!complete ? { error: "Facebook exposed rounded counts without a complete reaction breakdown." } : {}),
  };
}

/** A Like/React/Share action is never a permissible inspection target. */
export function isReactionInspector(label: string): boolean {
  const text = clean(label);
  // This distinct count-control label was observed inside Facebook's
  // "See who reacted to this" toolbar. It is not the plain "Like" action.
  if (/^(?:Like|Love|Care|Haha|Wow|Sad|Angry):\s*\d[\d,.KMB]*\s+(?:people|person)$/i.test(text)) return true;
  if (/\b(?:change|remove|send|add|leave|choose|your)\b|^(?:like|love|care|haha|wow|sad|angry|react|share)\b/i.test(text)) return false;
  return /^(?:see|show|view) (?:all )?(?:who reacted|reactions)(?: to this(?: (?:post|photo|reel))?)?[.!]?$/i.test(text)
    || countInLabel(text, "total") !== null
    || /^all reactions:?$/i.test(text);
}

interface CountSnapshot extends EngagementLabels {
  /** Index into the same control selector, revalidated immediately before click. */
  inspectors: { index: number; label: string }[];
}
const completeReactionBreakdown = (counts: MediaEngagement) => counts.totalReactions !== null
  && REACTION_KINDS.every((kind) => counts.reactions[kind] !== undefined)
  && REACTION_KINDS.reduce((sum, kind) => sum + counts.reactions[kind]!, 0) === counts.totalReactions;
const CONTROLS = 'button, [role="button"], a[role="link"]';

async function visibleCounts(page: Page): Promise<CountSnapshot> {
  return page.evaluate((selector) => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && getComputedStyle(el).visibility !== "hidden";
    };
    const ownSurface = (el: Element) => visible(el) && !el.closest('[role="navigation"], [role="banner"], [aria-label="Notifications"], [role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]');
    const labels: CountSnapshot = { totals: [], shares: [], reactions: [], inspectors: [] };
    for (const [index, control] of [...document.querySelectorAll<HTMLElement>(selector)].entries()) {
      if (!ownSurface(control)) continue;
      const aria = control.getAttribute("aria-label")?.trim() || "";
      const text = control.innerText.trim();
      // Native photo/reel action buttons render the aggregate count as their
      // numeric text. Reading it is safe; these action buttons are never clicked.
      if (/^[\d,.\s]+(?:K|M|B|L|thousand|million|billion|lakh|crore)?$/i.test(text)) {
        if (aria === "Like") labels.totals.push(`All reactions: ${text}`);
        if (aria === "Share" || aria === "Send this to friends or post it on your profile.") labels.shares.push(`${text} shares`);
      }
      // Read count-control labels only. Never inspect the reactor people's list.
      for (const value of [aria, text].filter(Boolean)) {
        if (/\b(?:all reactions|total reactions|\d[\d,.KMB]*\s+(?:people reacted|reactions))\b/i.test(value)) labels.totals.push(value);
        if (/^(?:\d[\d,.\s]*(?:(?:K|M|B|L|thousand|million|billion|lakh|crore)\s*)?shares?|shares?:?\s+\d[\d,.\s]*(?:K|M|B|L|thousand|million|billion|lakh|crore)?)$/i.test(value)) labels.shares.push(value);
      }
      const label = aria || text;
      if ((/\breaction|\breacted/i.test(label) || /^(?:Like|Love|Care|Haha|Wow|Sad|Angry):/i.test(label)) && label.length < 100) labels.inspectors.push({ index, label });
      // Some surfaces expose category counts without opening the dialog.
      if (aria && /\b(?:like|love|care|haha|wow|sad|angry)\s*:?\s*\d|\d[\d,.KMB]*\s+(?:like|love|care|haha|wow|sad|angry)\b/i.test(aria)) labels.reactions.push({ label: aria });
    }
    return labels;
  }, CONTROLS);
}

async function reactionTabs(page: Page): Promise<EngagementLabels> {
  return page.evaluate(() => {
    const labels: EngagementLabels = { totals: [], shares: [], reactions: [] };
    for (const tab of document.querySelectorAll<HTMLElement>('[role="dialog"] [role="tab"]')) {
      if (!tab.getClientRects().length) continue;
      const aria = tab.getAttribute("aria-label")?.trim() || "";
      const text = tab.innerText.trim();
      const icons = [...tab.querySelectorAll<HTMLImageElement>("img[alt]")].map((img) => img.alt);
      const allTab = /^all\b/i.test(aria) || /^all\b/i.test(text) || /\breacted with All\b/i.test(aria);
      // Some FB tabs say "Show 0 people" in aria while visibly displaying
      // 1.7K. That contradictory zero is not an observed count.
      const falseZero = /^Show 0 people who reacted with (Like|Love|Care|Haha|Wow|Sad|Angry)$/i.exec(aria);
      if (!allTab && falseZero && /^[1-9][\d,.]*(?:\s*(?:K|M|B|L|thousand|million|billion|lakh|crore))?$/i.test(text)) {
        labels.reactions.push({ label: `${falseZero[1]} ${text}` });
        continue;
      }
      for (const label of [aria, text].filter(Boolean)) {
        if (allTab) labels.totals.push(label);
        else labels.reactions.push({ label, icons });
      }
    }
    return labels;
  });
}

function isRequestedMedia(current: string, item: { postId: string; contentType: "posts" | "reels" }): boolean {
  try {
    const url = new URL(current);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return false;
    // Watch legitimately redirects older uploads to the owner's Videos path
    // and live recordings to /watch/live. Their video ID must still match.
    const id = item.contentType === "reels"
      ? /^\/reel\/(\d+)\/?$/.exec(url.pathname)?.[1]
        ?? /^\/(?:[^/]+\/)?videos\/(\d+)\/?$/.exec(url.pathname)?.[1]
        ?? (/^\/watch(?:\/live)?\/?$/.test(url.pathname) ? url.searchParams.get("v") : null)
      : /^\/photo(?:\.php|\/)?$/.test(url.pathname) ? url.searchParams.get("fbid") : null;
    return id === item.postId;
  } catch { return false; }
}

async function embeddedCounts(page: Page, item: { postId: string; contentType: "posts" | "reels" }, refresh = false): Promise<EngagementLabels> {
  return engagementLabelsFromPayloads(await nativeMediaPayloads(page, { refresh }), item).labels;
}

/** Only read the requested media's counters; never reaction actions or people. */
async function readCurrentMediaEngagement(
  page: Page,
  item: { postId: string; url: string; contentType: "posts" | "reels" },
  signal?: AbortSignal,
): Promise<MediaEngagement> {
  signal?.throwIfAborted();
  if (!isRequestedMedia(page.url(), item)) return { status: "partial", totalReactions: null, reactions: {}, shares: null, error: "The open Facebook media does not match this result." };
  let labels: EngagementLabels = { totals: [], shares: [], reactions: [] };
  let opened = false;
  try {
    let embedded = await embeddedCounts(page, item);
    const structured = engagementFromLabels(embedded);
    if (structured.status === "complete") return structured;
    // The caller can invoke this directly after domcontentloaded. Wait for the
    // native counters instead of recording the pre-hydration shell as unknown.
    if (!embedded.totals.length && !embedded.shares.length) await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && !el.closest('[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]')
        && (/^(?:Like|Share|Send this to friends or post it on your profile\.)$/.test(el.getAttribute("aria-label") || "") && /^\d/.test(el.innerText.trim())
          || /(?:reactions|people reacted|Like:|Love:)/i.test(el.getAttribute("aria-label") || ""));
    }), undefined, { timeout: 5000 }).catch(() => {});
    signal?.throwIfAborted();
    const initial = await visibleCounts(page);
    embedded = await embeddedCounts(page, item, true);
    // The exact owner's feedback can expose 0 even when the action button has
    // no text. Prefer these scoped fields over counters on adjacent video cards.
    labels = {
      totals: embedded.totals.length ? embedded.totals : initial.totals,
      shares: embedded.shares.length ? embedded.shares : initial.shares,
      reactions: embedded.reactions.length ? embedded.reactions : initial.reactions,
    };
    const first = engagementFromLabels(labels);
    if (first.status === "complete") return first;
    for (const candidate of initial.inspectors.filter((c) => isReactionInspector(c.label))) {
      signal?.throwIfAborted();
      const control = page.locator(CONTROLS).nth(candidate.index);
      const current = (await control.getAttribute("aria-label"))?.trim() || (await control.innerText()).trim();
      if (current !== candidate.label || !isReactionInspector(current) || !(await control.isVisible())) continue;
      await control.click({ timeout: 1500 });
      opened = true;
      await page.locator('[role="dialog"] [role="tab"]').first().waitFor({ state: "visible", timeout: 2000 });
      const deadline = Date.now() + 3000;
      do {
        signal?.throwIfAborted();
        const tabs = await reactionTabs(page);
        // A freshly opened dialog may reflect a newer total. Its category tabs
        // hydrate separately, so the first visible All tab is not completion.
        const tabTotal = engagementFromLabels({ totals: tabs.totals, shares: [], reactions: [] }).totalReactions;
        const previousTotal = engagementFromLabels(labels).totalReactions;
        if (tabTotal === 0 && previousTotal !== null && previousTotal > 0) {
          await page.waitForTimeout(150);
          continue;
        }
        labels = { totals: tabs.totals.length ? tabs.totals : labels.totals, shares: labels.shares, reactions: tabs.reactions.length ? tabs.reactions : labels.reactions };
        const snapshot = engagementFromLabels(labels);
        // A reaction dialog cannot fill missing shares. Stop once its reaction
        // breakdown is complete; the caller retains shares from the Reel rail.
        if (snapshot.status === "complete" || completeReactionBreakdown(snapshot)) break;
        await page.waitForTimeout(150);
      } while (Date.now() < deadline);
      break;
    }
    return engagementFromLabels(labels);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...engagementFromLabels(labels), status: "partial", error: "Facebook did not expose all requested reaction counts." };
  } finally {
    // Only dismiss a dialog this function opened; leave the caller's media in place.
    if (opened) await page.keyboard.press("Escape").catch(() => {});
  }
}

/** Reels hide type counts in their action rail. Watch is the same public video
 * with a count summary. Reuse the assigned detail page: creating a second Watch
 * page per Reel doubled the number of live renderer pages in a 10-worker run.
 * This stage runs before comment loading, so returning to the requested Reel
 * does not discard a comment surface. */
export async function readMediaEngagement(
  page: Page,
  item: { postId: string; url: string; contentType: "posts" | "reels" },
  signal?: AbortSignal,
): Promise<MediaEngagement> {
  const initial = await readCurrentMediaEngagement(page, item, signal);
  if (initial.status === "complete" || item.contentType !== "reels" || !isRequestedMedia(page.url(), item) || !/^\/reel\//.test(new URL(page.url()).pathname)) return initial;
  signal?.throwIfAborted();
  let switchedToWatch = false;
  try {
    signal?.throwIfAborted();
    await page.goto(`https://www.facebook.com/watch/?v=${item.postId}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    switchedToWatch = true;
    if (!isRequestedMedia(page.url(), item) || await page.locator('input[type="password"]').first().isVisible()) return initial;
    const fallback = await readCurrentMediaEngagement(page, item, signal);
    return mergeEngagementViews(initial, fallback);
  } catch (error) {
    if (signal?.aborted) throw error;
    return initial;
  } finally {
    // Details reads comments after engagement. Restore the exact original
    // item on this same page without allocating an auxiliary context/page.
    if (switchedToWatch) {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    }
  }
}
