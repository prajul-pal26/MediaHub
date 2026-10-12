import type { BrowserContext, Page } from "playwright-core";
import { createHash } from "node:crypto";
import { withFacebookContext } from "./browser-pool";
import { FbBrowserAuthError, FbBrowserRateLimitError, summarizeFbComments, type FbBrowserComment, type FbCommentContentKind, type FbCommentContentType, type FbCommentsBreakdown, type FbCommentsSourceView, type FbMediaEngagement, type FbMediaMetadata } from "./browser-fetcher";
import { readMediaEngagement } from "./media-engagement";
import { readMediaMetadata } from "./media-metadata";

export interface CommentMediaItem { postId: string; url: string; contentType: "posts" | "reels"; panelCountOnly?: boolean }
export interface MediaCommentsResult {
  comments: FbBrowserComment[];
  status: "complete" | "partial";
  stopReason: string;
  durationMs: number;
  reportedCount?: number | null;
  /** Facebook's count inside the selected Newest comment tray, when exposed. */
  panelReportedCount?: number | null;
  observedCommentCount?: number;
  textCommentCount?: number;
  excludedNonTextCommentCount?: number;
  excludedAttachmentCommentCount?: number;
  commentsContentScope?: "text_only" | "observed_nodes";
  /** The ordering view Facebook exposed. `newest` is complete only for that view, not an assertion about Facebook's raw count. */
  commentsSourceView?: FbCommentsSourceView;
  commentsBreakdown?: FbCommentsBreakdown;
  commentsStatus?: "complete" | "partial";
  engagement?: FbMediaEngagement;
  metadata?: FbMediaMetadata;
  error?: string;
}

type MediaDetailStage = "opening-media" | "checking-access" | "reading-metadata" | "reading-reactions" | "loading-comments";
type MediaDetailFailureKind = "timeout" | "navigation" | "page-closed" | "dom-read" | "unknown";

function mediaDetailFailureKind(error: unknown): MediaDetailFailureKind {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/execution context was destroyed|navigation/i.test(message)) return "navigation";
  if (/target page|target closed|browser has been closed/i.test(message)) return "page-closed";
  if (/evaluate|innertext|selector/i.test(message)) return "dom-read";
  return "unknown";
}

/** A stable diagnostic for a failed media page, without exposing Playwright URLs or cookies. */
export class FbMediaDetailFetchError extends Error {
  readonly code = "FB_MEDIA_DETAIL_FETCH" as const;
  constructor(public readonly stage: MediaDetailStage, public readonly kind: MediaDetailFailureKind = "unknown") {
    const stageMessage = {
      "opening-media": "Facebook did not finish opening this media page.",
      "checking-access": "Facebook loaded too slowly to verify this media page.",
      "reading-metadata": "Facebook did not finish reading this media metadata.",
      "reading-reactions": "Facebook did not finish reading reactions for this media.",
      "loading-comments": "Facebook did not finish loading comments for this media.",
    }[stage];
    const kindMessage = {
      timeout: " The page timed out.",
      navigation: " The page navigated while details were loading.",
      "page-closed": " The browser page closed while details were loading.",
      "dom-read": " Facebook changed the visible detail markup.",
      unknown: "",
    }[kind];
    super(`${stageMessage}${kindMessage}`);
    this.name = "FbMediaDetailFetchError";
  }
}

const COMMENT_ARTICLES = '[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]';

export function commentIdentity(rawUrl: string): { id: string; parentId: string | null } | null {
  try {
    const url = new URL(rawUrl, "https://www.facebook.com");
    if (url.protocol !== "https:" || !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return null;
    const root = url.searchParams.get("comment_id");
    const reply = url.searchParams.get("reply_comment_id");
    const id = reply || root;
    if (!id || !/^\d+$/.test(id)) return null;
    return { id, parentId: reply && root && /^\d+$/.test(root) && root !== reply ? root : null };
  } catch { return null; }
}

export function commentImages(images: string[]): string[] {
  const result = new Set<string>();
  for (const value of images) {
    try {
      let url = new URL(value);
      if (url.protocol !== "https:") continue;
      const original = url.searchParams.get("url");
      if (original) {
        const source = new URL(original);
        if (source.protocol === "https:" && /(^|\.)giphy\.com$/i.test(source.hostname)) url = source;
      }
      url.searchParams.delete("fbclid");
      result.add(url.toString());
    } catch { /* Ignore icons and malformed attachment URLs. */ }
  }
  return [...result];
}

/** Parentage comes from IDs, never the preceding row in a virtualized list. */
export function threadComments(flat: FbBrowserComment[], limit = 0): FbBrowserComment[] {
  const unique = new Map<string, FbBrowserComment>();
  for (const c of flat) if (!unique.has(c.id)) unique.set(c.id, { ...c, replies: [] });
  const selected = [...unique.values()].slice(0, limit || undefined);
  const byId = new Map(selected.map((c) => [c.id, c]));
  const roots: FbBrowserComment[] = [];
  for (const c of selected) {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    // A corrupt/reordered reference must not create a cycle in exported JSON.
    const visited = new Set([c.id]);
    let ancestor = parent;
    let cycle = false;
    while (ancestor) {
      if (visited.has(ancestor.id)) { cycle = true; break; }
      visited.add(ancestor.id);
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    if (parent && !cycle) parent.replies!.push(c);
    else roots.push(c);
  }
  const pending = roots.map((comment) => ({ comment, depth: comment.parentId ? Math.max(1, comment.depth) : 0 }));
  while (pending.length) {
    const { comment, depth } = pending.pop()!;
    comment.depth = depth;
    comment.replyCount = comment.replies!.length;
    for (const reply of comment.replies!) pending.push({ comment: reply, depth: depth + 1 });
  }
  return roots;
}

/**
 * Keep only comments with meaningful text, while preserving a text reply whose
 * direct parent was an attachment-only comment. The reply remains linked to
 * that verified parent ID, but is promoted into the returned tree so it is not
 * silently lost with its omitted parent.
 */
export function textOnlyThreadComments(flat: FbBrowserComment[], limit = 0): FbBrowserComment[] {
  const roots = threadComments(flat);
  const liftText = (comment: FbBrowserComment, depth: number): FbBrowserComment[] => {
    const keep = Boolean(comment.text.trim());
    const childDepth = keep ? depth + 1 : depth;
    const replies = (comment.replies ?? []).flatMap((reply) => liftText(reply, childDepth));
    if (!keep) return replies;
    return [{ ...comment, images: [], video: null, depth, replies, replyCount: replies.length }];
  };
  const textRoots = roots.flatMap((root) => liftText(root, 0));
  if (!limit) return textRoots;

  let remaining = limit;
  const take = (comment: FbBrowserComment): FbBrowserComment | null => {
    if (remaining <= 0) return null;
    remaining -= 1;
    const replies = (comment.replies ?? []).flatMap((reply) => {
      const retained = take(reply);
      return retained ? [retained] : [];
    });
    return { ...comment, replies, replyCount: replies.length };
  };
  return textRoots.flatMap((root) => {
    const retained = take(root);
    return retained ? [retained] : [];
  });
}

export type RawComment = {
  url: string | null; parentUrl: string | null; label: string;
  author: string; authorUrl: string | null; avatar: string | null; badge: string | null;
  text: string; emoji: string[]; images: string[]; stickers: string[]; gifs: string[]; video: string | null;
  time: string | null; reaction: string | null; fallbackKey: string;
  /** Card-local Facebook hidden marker; a control-only label never marks a card. */
  isHidden?: boolean;
  hiddenSource?: "card_marker" | "revealed_by_hidden_control";
};

export type CommentContent = {
  text: string;
  hasText: boolean;
  contentKind: FbCommentContentKind;
  contentKinds: FbCommentContentKind[];
};

/**
 * Remove decorative Unicode emoji while retaining readable text in every
 * language. Emoji-only comments are represented separately instead of being
 * mistaken for an attachment or silently discarded.
 */
export function readableCommentText(value: string): string {
  return value
    .replace(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[#*0-9]\uFE0F?\u20E3|\uFE0F|\u200D)/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The emoji a wordless comment actually contains, so the JSON shows "🔥" rather
 * than a generic label. Whitespace and Facebook's affordances are trimmed away;
 * anything left that is not emoji means this was not an emoji-only comment.
 */
export function emojiOnlyText(value: string): string {
  const trimmed = (value || "")
    .replace(/\s*See (?:more|less|translation)\s*$/i, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u034F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return "";
  return readableCommentText(trimmed) ? "" : trimmed;
}

export function commentPlaceholder(type: Exclude<FbCommentContentType, "text">): string {
  switch (type) {
    case "emoji": return "[Emoji]";
    case "gif": return "[GIF]";
    case "image": return "[Image/Logo]";
    case "video": return "[Video]";
    case "attachment": return "[Attachment]";
    case "unavailable": return "[No text exposed]";
  }
}

/** Remove Facebook UI affordances without discarding words the author wrote. */
export function trimCommentText(value: string): string {
  return (value || "")
    .replace(/\s*(?:See (?:more|less|translation)|·\s*Edited)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function commentHasText(value: string): boolean {
  return Boolean(readableCommentText(trimCommentText(value)));
}

/**
 * Keep a visible card countable even when it is an emoji, GIF, sticker, photo,
 * or video with no text. Text remains the primary kind for mixed comments.
 */
export function classifyCommentContent(raw: Partial<Pick<RawComment, "text" | "emoji" | "images" | "stickers" | "gifs" | "video">>): CommentContent {
  const original = trimCommentText(raw.text || "");
  const text = readableCommentText(original);
  const emoji = [...new Set([...(raw.emoji ?? []), ...(original.match(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}])/gu) ?? []), emojiOnlyText(original)].filter(Boolean))];
  const kinds: FbCommentContentKind[] = [];
  if (text) kinds.push("text");
  if (emoji.length) kinds.push("emoji");
  if (raw.gifs?.length) kinds.push("gif");
  if (raw.stickers?.length) kinds.push("sticker");
  if (raw.video) kinds.push("video");
  if (raw.images?.length) kinds.push("photo");
  if (!kinds.length) return { text: "", hasText: false, contentKind: "empty", contentKinds: ["empty"] };
  const contentKind = text ? "text" : kinds[0]!;
  return { text: text || emoji.join(""), hasText: Boolean(text), contentKind, contentKinds: kinds };
}

export function countCommentRows(comments: FbBrowserComment[]): number {
  return comments.reduce((count, comment) => count + 1 + countCommentRows(comment.replies ?? []), 0);
}

const derivedCommentId = (key: string) => `d${BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 16)}`).toString(36)}`;

const legacyContentType = (kind: FbCommentContentKind): FbCommentContentType => {
  switch (kind) {
    case "text": return "text";
    case "photo": return "image";
    case "sticker": return "attachment";
    case "empty": return "unavailable";
    default: return kind;
  }
};

export function mergeComment(existing: FbBrowserComment, incoming: FbBrowserComment): FbBrowserComment {
  const text = incoming.text.length > existing.text.length ? incoming.text : existing.text;
  const images = [...new Set([...(existing.images ?? []), ...(incoming.images ?? [])])];
  const kinds = [...new Set([...(existing.contentKinds ?? (existing.contentKind ? [existing.contentKind] : [])), ...(incoming.contentKinds ?? (incoming.contentKind ? [incoming.contentKind] : []))])];
  const contentKind = kinds.includes("text") ? "text" : (kinds[0] ?? incoming.contentKind ?? existing.contentKind);
  return {
    ...existing,
    ...incoming,
    text,
    images,
    video: existing.video ?? incoming.video ?? null,
    contentKind,
    contentKinds: kinds,
    contentType: legacyContentType(contentKind ?? "empty"),
    idSource: existing.idSource === "permalink" || incoming.idSource === "permalink" ? "permalink" : "derived",
    isHidden: existing.isHidden || incoming.isHidden || undefined,
    hiddenSource: existing.hiddenSource === "card_marker" || incoming.hiddenSource === "card_marker"
      ? "card_marker"
      : existing.hiddenSource ?? incoming.hiddenSource,
  };
}

export interface CommentPageScan {
  comments: RawComment[];
  expanders: { text: number; thread: number };
  signature: CommentSignature;
}

/**
 * Playwright serializes DOM callbacks into Facebook's page. The production
 * bundle preserves local function names with a module-only `__name` helper,
 * which is absent in that remote page. Give every collector entry point a
 * page-local identity helper before it serializes any callback.
 */
export async function ensureFacebookPageCallbackRuntime(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (typeof (globalThis as { __name?: unknown }).__name !== "function") {
      // Keeping this anonymous and indirect prevents the bundler from trying
      // to call the helper while creating the helper itself.
      (globalThis as { __name?: unknown }).__name = [function (target: unknown) { return target; }][0];
    }
  });
}

/** One DOM pass collects cards, card-local expanders, and a stable progress signature. */
export async function scanCommentPage(
  page: Page,
  options: { withReplies: boolean; expandableIds?: string[] } = { withReplies: true },
): Promise<CommentPageScan> {
  await ensureFacebookPageCallbackRuntime(page);
  return page.evaluate((scanOptions) => {
    const articleSelector = '[role="article"][aria-label^="Comment"], [role="article"][aria-label^="Reply"]';
    // Any Facebook permalink carrying this card's comment ID identifies it.
    // Restricting the path to /posts//reel//photo//permalink//story silently
    // dropped every comment Facebook permalinked through /videos/ or /watch,
    // which showed up only as a scraped count below the reported count.
    const identityLinks = (node: Element) => [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => {
      if (a.closest(articleSelector) !== node) return false;
      let u: URL;
      try { u = new URL(a.href); } catch { return false; }
      if (u.protocol !== "https:" || !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(u.hostname)) return false;
      const id = u.searchParams.get("reply_comment_id") || u.searchParams.get("comment_id");
      return Boolean(id && /^\d+$/.test(id));
    });
    const identityLink = (node: Element) => {
      const links = identityLinks(node);
      // A link quoted in the comment body can itself carry a comment_id. The
      // timestamp permalink is outside the readable body and is the card ID.
      return links.find((a) => !a.closest('[dir="auto"]')) ?? links.at(-1) ?? null;
    };
    const output = [...document.querySelectorAll<HTMLElement>(articleSelector)].flatMap((node) => {
      if (!node.getClientRects().length) return [];
      const own = <T extends Element>(selector: string) => [...node.querySelectorAll<T>(selector)].filter((e) => e.closest(articleSelector) === node);
      const link = identityLink(node);
      const parentNode = node.parentElement?.closest(articleSelector);
      const authorLink = own<HTMLAnchorElement>("a[href]").find((a) => a !== link && a.innerText.trim() && !a.href.includes("l.facebook.com/"));
      const author = authorLink?.innerText.trim() || "";
      const blocks = own<HTMLElement>('[dir="auto"]').filter((e) => !e.closest('a, [role="button"]') && !e.querySelector(articleSelector)).map((e) => e.innerText.trim())
        .filter((text) => text && text !== author && !/^(Like|Reply|Share|See translation|·|\d+[hmwdy])$/i.test(text));
      const rawText = blocks.sort((a, b) => b.length - a.length)[0] || "";
      const avatarImage = own<HTMLImageElement>("a img")[0];
      const avatar = avatarImage?.src ?? null;
      const inlineImages = own<HTMLImageElement>("img").filter((image) => image !== avatarImage
        && !image.closest("a[href*='comment_id'], a[href*='reply_comment_id'], a[href*='/profile'], a[href*='/people']"));
      const emojiOnly = (value: string | null | undefined) => {
        const raw = value?.trim() || "";
        return Boolean(raw) && !raw
          .replace(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[#*0-9]\uFE0F?\u20E3|\uFE0F|\u200D|\s)/gu, "");
      };
      const emojiImages = inlineImages.filter((image) => emojiOnly(image.alt) || emojiOnly(image.getAttribute("aria-label")));
      const nonEmojiImages = inlineImages.filter((image) => !emojiImages.includes(image));
      const reaction = own<HTMLElement>('[aria-label*="reaction" i]')[0];
      const badge = own<HTMLElement>('[aria-label*="Author" i], [aria-label*="contributor" i]')[0];
      const images = nonEmojiImages.filter((image) => !/stickers?\//i.test(image.src)).map((image) => image.src).filter(Boolean);
      const stickers = nonEmojiImages.filter((image) => /stickers?\//i.test(image.src)).map((image) => image.src).filter(Boolean);
      const gifs = own<HTMLImageElement>("img").filter((image) => /(?:^|[./_-])gif(?:[./?_-]|$)/i.test(image.src) || /gif/i.test(image.alt)).map((image) => image.src).filter(Boolean);
      const emoji = [...emojiImages.map((image) => image.alt || image.getAttribute("aria-label") || "").filter(Boolean)];
      const video = own<HTMLVideoElement>("video")[0]?.src || null;
      // Do not classify a whole thread as hidden merely because a nearby
      // "View hidden comments" control exists. A card is directly hidden only
      // when Facebook marks that card or one of its own descendants as hidden.
      const cardMarkers = [node.getAttribute("aria-label") || "", ...own<HTMLElement>("[aria-label]").map((element) => element.getAttribute("aria-label") || "")].join(" ");
      const isHidden = /\b(?:hidden by facebook|hidden comment|comment hidden)\b/i.test(cardMarkers);
      const fallbackKey = [author, link?.getAttribute("title") || link?.innerText.trim() || "", node.getAttribute("aria-label") || "", emoji.join(""), gifs[0] || stickers[0] || images[0] || ""].join("|");
      // A visible card with no permalink is still an observed Facebook
      // comment. Its derived key deliberately omits the expandable body.
      if (!link && !author && !rawText && !emoji.length && !images.length && !stickers.length && !gifs.length && !video) return [];
      return [{ url: link?.href ?? null, parentUrl: parentNode ? identityLink(parentNode)?.href ?? null : null,
        label: node.getAttribute("aria-label") || "", author, authorUrl: authorLink?.href ?? null,
        avatar, badge: badge?.getAttribute("aria-label") ?? null, text: rawText, emoji, images, stickers, gifs, video,
        time: link?.getAttribute("title") || link?.innerText.trim() || null,
        reaction: reaction?.getAttribute("aria-label") ?? null,
        fallbackKey,
        isHidden,
        ...(isHidden ? { hiddenSource: "card_marker" as const } : {}),
      }];
    });
    const allowed = scanOptions.expandableIds ? new Set(scanOptions.expandableIds) : null;
    const idFor = (node: Element) => {
      const link = identityLink(node);
      if (!link) return null;
      const url = new URL(link.href);
      return url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id");
    };
    let textExpanders = 0;
    for (const node of document.querySelectorAll<HTMLElement>(articleSelector)) {
      if (!node.getClientRects().length || (allowed && (!idFor(node) || !allowed.has(idFor(node)!)))) continue;
      for (const candidate of node.querySelectorAll<HTMLElement>('[role="button"], span, div[tabindex]')) {
        if (candidate.closest(articleSelector) === node && (candidate.textContent || "").trim() === "See more" && candidate.getClientRects().length) { textExpanders += 1; break; }
      }
    }
    const threadPattern = /^(?:(?:View|See|Load|Show)\s+(?:(?:all|more|previous|next|hidden)\s+)?(?:\d[\d,]*\s+)?(?:(?:all|more|previous|next|hidden)\s+)?(?:comments?|replies|reply)|(?:more|previous|next|hidden)\s+(?:comments?|replies|reply)|\d[\d,]*\s+(?:(?:more|next|hidden)\s+comments?|(?:(?:more|next|hidden)\s+)?(?:replies|reply))|\d[\d,]*\s+hidden\s+comments?)$/i;
    let threadExpanders = 0;
    if (scanOptions.withReplies !== false) for (const candidate of document.querySelectorAll<HTMLElement>('button, [role="button"], a, [role="link"]')) {
      if (candidate.getClientRects().length && threadPattern.test((candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim())) threadExpanders += 1;
    }
    const ids = output.flatMap((row) => row.url ? (() => { try { const url = new URL(row.url); return [url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id") || ""]; } catch { return []; } })() : [] ).filter(Boolean);
    return { comments: output, expanders: { text: textExpanders, thread: threadExpanders }, signature: { articles: output.length, links: ids.length, expanders: textExpanders, commentFingerprint: [...new Set(ids)].slice(-16).join("|") } };
  }, options);
}

async function readComments(page: Page): Promise<RawComment[]> { return (await scanCommentPage(page, { withReplies: true })).comments; }

/** Expand full comment text before pagination; a successful click is not proof of new data. */
export async function advanceCommentSection(
  page: Page,
  options: { withReplies: boolean; expandThreads: boolean; commentIds?: string[]; waitMs?: number },
): Promise<{ pending: boolean; clicked: boolean; changed: boolean; kind?: "text" | "thread"; revealedHidden?: boolean }> {
  // Facebook commonly acknowledges a pagination click before it has rendered
  // the next page. On heavier Reels, that render can take longer than the old
  // 4.5-second default, which made real "View more" and hidden-comment pages
  // look stalled even though the next rows were still arriving. Keep callers
  // free to use a short fixture timeout, but give live collection a realistic
  // bounded settle window.
  const waitMs = options.waitMs ?? 8_000;
  // An empty allow-list means text expansion was abandoned. Walking every
  // "See more" only to skip them all costs a round trip each and grows with
  // the thread, so skip straight to pagination.
  const moreText = options.commentIds?.length === 0
    ? null
    : page.locator(COMMENT_ARTICLES).getByText("See more", { exact: true });
  for (let i = 0; moreText && i < await moreText.count(); i++) {
    const button = moreText.nth(i);
    if (!await button.isVisible()) continue;
    const row = await button.evaluate((el, selector) => {
      const article = el.closest(selector);
      if (!article) return null;
      const links = [...article.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => a.closest(selector) === article);
      const url = links.find((a) => /[?&](?:reply_comment_id|comment_id)=\d/.test(a.href))?.href;
      return { url, reply: /^Reply/i.test(article.getAttribute("aria-label") || ""), text: (article as HTMLElement).innerText };
    }, COMMENT_ARTICLES);
    const id = row?.url ? commentIdentity(row.url)?.id : undefined;
    if (!id || (!options.withReplies && row?.reply) || (options.commentIds && !options.commentIds.includes(id))) continue;
    const clicked = await button.click({ timeout: 1500 }).then(() => true).catch(() => false);
    if (!clicked) return { pending: true, clicked: false, changed: false, kind: "text" };
    const changed = await page.waitForFunction(({ selector, id, before }) => [...document.querySelectorAll<HTMLElement>(selector)].some((article) => {
      const same = [...article.querySelectorAll<HTMLAnchorElement>("a[href]")].some((a) => {
        if (a.closest(selector) !== article) return false;
        const url = new URL(a.href);
        return (url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id")) === id;
      });
      const clean = (text: string) => text.replace(/\bSee (?:more|less)\b/gi, "").replace(/\s+/g, " ").trim();
      return same && !/\bLoading(?:[.…\s]|$)/i.test(article.innerText) && clean(article.innerText) !== clean(before);
    }), { selector: COMMENT_ARTICLES, id, before: row!.text }, { timeout: waitMs, polling: 100 }).then(() => true).catch(() => false);
    return { pending: true, clicked, changed, kind: "text" };
  }
  if (!options.expandThreads) return { pending: false, clicked: false, changed: false };
  // Facebook uses native buttons, links, and role buttons for the same
  // control. Normalize its label instead of relying on exact `hasText`
  // matching, which misses `View 3 more comments` when a wrapper inserts
  // whitespace or accessibility text.
  // Locate the control with ONE evaluate and tag it, instead of walking every
  // button through Playwright. Each comment adds several buttons and links, so
  // the old per-element `isVisible()` + `innerText()` pair cost two round trips
  // per candidate and grew with the comments already loaded — the run started
  // fast and then crawled. This is constant work regardless of thread size.
  const label = await page.evaluate(({ source, mark }) => {
    const pattern = new RegExp(source, "i");
    for (const stale of document.querySelectorAll(`[${mark}]`)) stale.removeAttribute(mark);
    for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"], a, [role="link"]')) {
      // textContent needs no layout, so it prefilters the vast majority.
      const raw = el.textContent || "";
      if (raw.length > 80 || !/more|previous|repl|comment/i.test(raw)) continue;
      if (!el.getClientRects().length) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!pattern.test(text)) continue;
      el.setAttribute(mark, "1");
      return text;
    }
    return null;
  }, { source: options.withReplies ? THREAD_SOURCE_WITH_REPLIES : THREAD_SOURCE_ROOTS_ONLY, mark: EXPAND_MARK });
  if (!label) return { pending: false, clicked: false, changed: false };

  // A virtualized Facebook tray can replace every visible card while retaining
  // the same number of cards and permalinks. The old count-only predicate
  // called that successful page transition a stall, leaving later pages and
  // their replies behind. Keep a compact ID fingerprint as well as counts so
  // the settle step recognizes replacement progress without shipping the full
  // accumulated ID set into the browser.
  const previous = await readCommentSignature(page);
  const target = page.locator(`[${EXPAND_MARK}="1"]`).first();
  const revealedHidden = /\bhidden\s+comments?\b/i.test(label);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const clicked = await target.click({ timeout: 1500 }).then(() => true).catch(() => false);
  if (!clicked) return { pending: true, clicked: false, changed: false, kind: "thread", ...(revealedHidden ? { revealedHidden: true } : {}) };
  const changed = await settleCommentSection(page, previous, waitMs, "content");
  return { pending: true, clicked, changed, kind: "thread", ...(revealedHidden ? { revealedHidden: true } : {}) };
}

const EXPAND_MARK = "data-mh-expand";

/** Facebook renders "See more" as a button, a bare span or a focusable div. */
const EXPANDER_NODES = '[role="button"], span, div[tabindex]';
/**
 * Labels Facebook uses for the control that reveals more comments.
 *
 * Every form below has been observed to matter, and each miss shows up as a
 * scraped count below the reported one:
 *
 *   pagination   View / See / Load / Show  [all|more|previous] [N] [more] comments
 *                "More comments", "Previous comments"
 *   replies      "View 4 more replies", "3 replies", "1 reply", "More replies"
 *   hidden       "View 1 hidden comment", "Show hidden comments", "1 hidden
 *                comment" — Facebook collapses spam-filtered and low-quality
 *                comments behind these, and they are still counted in the
 *                reported badge. Missing them produced an exact one-comment
 *                shortfall on reels.
 *
 * A bare "N comments" is deliberately NOT matched: on a reel that is the
 * comment-count button itself, and clicking it again closes the panel.
 * "N hidden comment" is matched, because that form is never the count button.
 */
const MODIFIER = "(?:all|more|previous|next|hidden)";
const NOUN_WITH_REPLIES = "(?:comments?|replies|reply)";
const THREAD_SOURCE_WITH_REPLIES = `^(?:(?:View|See|Load|Show)\\s+(?:${MODIFIER}\\s+)?(?:\\d[\\d,]*\\s+)?(?:${MODIFIER}\\s+)?${NOUN_WITH_REPLIES}|(?:more|previous|next|hidden)\\s+${NOUN_WITH_REPLIES}|\\d[\\d,]*\\s+(?:(?:more|next|hidden)\\s+comments?|(?:(?:more|next|hidden)\\s+)?(?:replies|reply))|\\d[\\d,]*\\s+hidden\\s+comments?)$`;
const THREAD_SOURCE_ROOTS_ONLY = `^(?:(?:View|See|Load|Show)\\s+(?:${MODIFIER}\\s+)?(?:\\d[\\d,]*\\s+)?(?:${MODIFIER}\\s+)?comments?|(?:more|previous|next|hidden)\\s+comments?|\\d[\\d,]*\\s+(?:more|next|hidden)\\s+comments?)$`;

/** The pagination-label matcher, shared by the batch and the single-control path. */
export function threadControlPattern(withReplies: boolean): RegExp {
  return new RegExp(withReplies ? THREAD_SOURCE_WITH_REPLIES : THREAD_SOURCE_ROOTS_ONLY, "i");
}


export interface CommentSignature { articles: number; links: number; expanders: number; commentFingerprint: string }

/** Selector counts only: no layout, no page text built. */
export async function readCommentSignature(page: Page): Promise<CommentSignature> {
  return page.evaluate(({ sel, expanderNodes }) => {
    const descend = (selector: string, child: string) => selector.split(",")
      .flatMap((part) => child.split(",").map((leaf) => `${part.trim()} ${leaf.trim()}`)).join(", ");
    let expanders = 0;
    for (const button of document.querySelectorAll<HTMLElement>(descend(sel, expanderNodes))) {
      if ((button.textContent || "").trim() === "See more") expanders += 1;
    }
    // Facebook virtualizes the comment tray. When the next page replaces the
    // visible cards, article and permalink *counts* can stay identical even
    // though all of the actual comment IDs changed. Tracking a small ID
    // fingerprint lets the settle loop recognize that real progress instead
    // of declaring the pagination control stalled after three pages.
    const commentIds = [...new Set([...document.querySelectorAll<HTMLAnchorElement>(descend(sel, 'a[href*="comment_id"]'))].flatMap((anchor) => {
      try {
        const url = new URL(anchor.href);
        if (url.protocol !== "https:" || !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return [];
        const id = url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id");
        return id && /^\d+$/.test(id) ? [id] : [];
      } catch { return []; }
    }))];
    return {
      articles: document.querySelectorAll(sel).length,
      links: document.querySelectorAll(descend(sel, 'a[href*="comment_id"]')).length,
      expanders,
      commentFingerprint: commentIds.slice(-16).join("|"),
    };
  }, { sel: COMMENT_ARTICLES, expanderNodes: EXPANDER_NODES });
}

/**
 * Click every visible expander in one round trip.
 *
 * The one-click-per-pass loop spent its whole budget on round trips: each
 * control cost a Playwright actionability check plus a wait of up to 4.5s, so a
 * thread with a hundred truncated bodies could not finish inside its deadline.
 */
export async function expandCommentSectionBatch(
  page: Page,
  options: { withReplies: boolean; expandThreads: boolean; expandText?: boolean; commentIds?: string[]; expandableIds?: string[]; maxText?: number; maxThreads?: number },
): Promise<{ text: number; thread: number }> {
  return page.evaluate(({ sel, threadSource, commentIds, expandThreads, expandText, expanderNodes, maxText, maxThreads }) => {
    const threadPattern = new RegExp(threadSource, "i");
    const allowed = commentIds ? new Set(commentIds) : null;
    const rendered = (el: Element) => el.getClientRects().length > 0;
    const label = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();
    const idOf = (node: Element) => {
      const candidates: HTMLAnchorElement[] = [];
      for (const a of node.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (a.closest(sel) !== node) continue;
        try {
          const url = new URL(a.href);
          if (url.protocol !== "https:" || !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) continue;
          const id = url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id");
          if (id && /^\d+$/.test(id)) candidates.push(a);
        } catch { /* Not an addressable permalink. */ }
      }
      // Do not let a Facebook link pasted in the readable body masquerade as
      // this card's ID; timestamp permalinks are outside the content body.
      const link = candidates.find((a) => !a.closest('[dir="auto"]')) ?? candidates.at(-1);
      if (!link) return null;
      const url = new URL(link.href);
      return url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id");
    };
    let text = 0;
    let thread = 0;
    for (const node of expandText ? document.querySelectorAll<HTMLElement>(sel) : []) {
      if (text >= maxText || !rendered(node)) continue;
      if (allowed) {
        const id = idOf(node);
        if (!id || !allowed.has(id)) continue;
      }
      for (const button of node.querySelectorAll<HTMLElement>(expanderNodes)) {
        if (button.closest(sel) !== node || (button.textContent || "").trim() !== "See more" || !rendered(button)) continue;
        button.click();
        text += 1;
        break;
      }
    }
    if (expandThreads) {
      for (const button of document.querySelectorAll<HTMLElement>('button, [role="button"], a, [role="link"]')) {
        if (thread >= maxThreads) break;
        // Prefilter on textContent (cheap), then confirm on innerText. These
        // controls carry visually-hidden accessibility text, so textContent
        // alone does not match the anchored label pattern and pagination was
        // silently never clicked — capping every thread at its first page.
        const raw = button.textContent || "";
        if (!/more|previous|repl|comment/i.test(raw) || !rendered(button)) continue;
        if (!threadPattern.test(label(button)) && !threadPattern.test((button.innerText || "").replace(/\s+/g, " ").trim())) continue;
        // Facebook loads the next page lazily; the control has to be in view.
        button.scrollIntoView({ block: "center" });
        button.click();
        thread += 1;
      }
    }
    return { text, thread };
  }, {
    sel: COMMENT_ARTICLES,
    threadSource: options.withReplies ? THREAD_SOURCE_WITH_REPLIES : THREAD_SOURCE_ROOTS_ONLY,
    commentIds: options.expandableIds ?? options.commentIds ?? null,
    expandThreads: options.expandThreads,
    expandText: options.expandText !== false,
    expanderNodes: EXPANDER_NODES,
    // Expanding truncated text is local DOM work, so it batches freely.
    // Pagination issues a request each, so keep that burst modest: this runs on
    // the user's own session and Facebook rate-limits on request volume.
    maxText: options.maxText ?? 30,
    maxThreads: options.maxThreads ?? 6,
  });
}

/**
 * `mode: "content"` waits for comments to actually arrive. A clicked control
 * relabels itself the moment it is pressed, so accepting that as the settle
 * signal would let the loop run ahead of Facebook's render and call a thread
 * exhausted while its next page was still on the way.
 */
export async function settleCommentSection(
  page: Page,
  before: CommentSignature,
  timeoutMs: number,
  mode: "content" | "any" = "any",
): Promise<boolean> {
  return page.waitForFunction(({ sel, before, mode, expanderNodes }) => {
    const descend = (selector: string, child: string) => selector.split(",")
      .flatMap((part) => child.split(",").map((leaf) => `${part.trim()} ${leaf.trim()}`)).join(", ");
    if (document.querySelectorAll(sel).length !== before.articles) return true;
    if (document.querySelectorAll(descend(sel, 'a[href*="comment_id"]')).length !== before.links) return true;
    const ids = [...new Set([...document.querySelectorAll<HTMLAnchorElement>(descend(sel, 'a[href*="comment_id"]'))].flatMap((anchor) => {
      try {
        const url = new URL(anchor.href);
        if (url.protocol !== "https:" || !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return [];
        const id = url.searchParams.get("reply_comment_id") || url.searchParams.get("comment_id");
        return id && /^\d+$/.test(id) ? [id] : [];
      } catch { return []; }
    }))];
    if (ids.slice(-16).join("|") !== before.commentFingerprint) return true;
    if (mode === "content") return false;
    let expanders = 0;
    for (const button of document.querySelectorAll<HTMLElement>(descend(sel, expanderNodes))) {
      if ((button.textContent || "").trim() === "See more") expanders += 1;
    }
    return expanders !== before.expanders;
  }, { sel: COMMENT_ARTICLES, before, mode, expanderNodes: EXPANDER_NODES },
  { timeout: timeoutMs, polling: 150 }).then(() => true).catch(() => false);
}

export function commentCompletionReason(input: { found: number; limit: number; reported: number | null; pendingExpansion: boolean; unfiltered: boolean; idle: number; view?: FbCommentsSourceView }): string | null {
  const view = input.view ?? (input.unfiltered ? "all" : "most_relevant");
  if (input.pendingExpansion) return null;
  if (input.limit > 0 && input.found >= input.limit) return "requested-limit";
  // Facebook's badge is positive evidence that more comments exist, so a few
  // quiet passes do not mean the list is exhausted. Lazy-loading threads need
  // longer before silence counts as an answer.
  // Legacy callers do not supply the explicitly observed view. Preserve their
  // three-pass behaviour while the live collector (which always supplies it)
  // keeps the safer eight-pass wait when Facebook's badge says more exist.
  const exhausted = input.idle >= (input.view === undefined && input.unfiltered
    ? 3
    : input.reported !== null && input.found < input.reported ? 8 : 3);
  // A reported badge can establish raw-count coverage only in Facebook's
  // explicit All comments view. It must not turn a Newest result into a claim
  // that every raw comment was exposed.
  if (view === "all" && input.reported !== null && input.found >= input.reported) return "reported-count-reached";
  if (view === "newest" && exhausted && input.found > 0) return "best-available-view-exhausted";
  // A relevance-filtered view hides rows, so running out of them proves
  // nothing on its own — but matching Facebook's own badge does. Without this
  // the filtered view had no completion path at all, so rows that scraped 4 of
  // a reported 4 were exported "partial" with nothing actually missing.
  if (view !== "all" && exhausted && input.reported !== null && input.reported > 0 && input.found >= input.reported) {
    return "reported-count-reached";
  }
  if (view !== "all") return null;
  // In text-only mode, a verified All comments view that has no more rows or
  // expanders establishes completion of the exposed text set. Facebook's raw
  // badge can include deleted, attachment-only, or otherwise unavailable rows
  // and must remain informational rather than forcing this result partial.
  if (exhausted && input.found > 0) return "visible-comments-exhausted";
  return null;
}

/**
 * A raw badge is sometimes absent even when the Newest tray exposes its own
 * total. The tray total is the only count the Newest-only collector can work
 * toward, so it must also determine the large-thread time budget.
 */
export function commentCollectionBudgetMs(rawReportedCount: number | null, panelReportedCount: number | null): number {
  const targetCount = panelReportedCount ?? rawReportedCount;
  return targetCount == null
    ? 180_000
    : Math.min(600_000, Math.max(180_000, 30_000 + targetCount * 500));
}

type CommentViewSelection = { view: FbCommentsSourceView; changed: boolean };

const commentViewName = (value: string): FbCommentsSourceView => {
  if (/^All comments(?:\s|$)/i.test(value)) return "all";
  if (/^Newest(?:\s|$)/i.test(value)) return "newest";
  if (/^Most relevant(?:\s|$)/i.test(value)) return "most_relevant";
  return "unknown";
};

/**
 * Collect through one ordering only: Newest. Facebook can expose different
 * menus on different Reels, but mixing All comments and Newest within the
 * same collection made the result non-deterministic and difficult to audit.
 * Confirm the top-level control changed before trusting it.
 */
export async function selectCommentView(page: Page): Promise<CommentViewSelection> {
  // Facebook alternates between an explicit ARIA button and a native <button>
  // for the same ordering control. Restricting this to [role=button] left
  // native-button Reels in Most relevant, even when All comments was present.
  const ordering = page.locator('button, [role="button"]').filter({ hasText: /^(Most relevant|All comments|Newest)(?:\s|$)/i }).first();
  await ordering.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (!await ordering.isVisible()) return { view: "unknown", changed: false };

  const current = commentViewName((await ordering.innerText()).trim());
  if (current === "newest") return { view: "newest", changed: false };
  if (!await ordering.click().then(() => true).catch(() => false)) return { view: "unknown", changed: false };

  // Reel comment menus use several different accessible structures. Some
  // render their choices as dialog/listbox buttons instead of menu items.
  const choices = page.locator(
    '[role="menuitem"], [role="menuitemradio"], [role="option"], '
    + '[role="menu"] [role="button"], [role="listbox"] [role="button"], [role="dialog"] [role="button"]',
  );
  // Wait once for the menu itself. Waiting five seconds for a missing All
  // comments option on every Reel made the valid Newest fallback needlessly
  // expensive at larger batch sizes.
  await choices.first().waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  // The menu's own items hydrate after the first one appears, and the heavier
  // the thread the longer that takes. Checking visibility immediately after the
  // 2s menu wait left ~20% of reels stuck in Most relevant — which is where
  // every observed reported/scraped shortfall came from, because that view
  // hides comments the badge still counts. Wait for the option itself.
  const optionCandidates = (target: "newest") => {
    const label = /^Newest(?:\s|$)/i;
    // Facebook sometimes appends a short ordering description to this option.
    // Anchor it to the option name so the portal-menu fallback remains scoped
    // but does not leave Photos stuck in Most relevant.
    return [
      page.getByRole("menuitem", { name: label }).first(),
      page.getByRole("menuitemradio", { name: label }).first(),
      page.getByRole("option", { name: label }).first(),
      choices.filter({ hasText: label }).first(),
      page.getByText(label).last(),
    ];
  };
  const optionReady = async (target: "newest") => Promise.any(optionCandidates(target).map((candidate) =>
    candidate.waitFor({ state: "visible", timeout: 4000 }),
  )).then(() => true).catch(() => false);
  const confirm = async (target: "newest") => {
    const expected = /^Newest(?:\s|$)/i;
    // Poll the already-identified ordering control. Searching every visible
    // button can keep finding the menu option itself and waste several
    // seconds on each Photo; the control is the only state that matters.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (expected.test((await ordering.innerText().catch(() => "")).trim())) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  const choose = async (target: "newest") => {
    if (!await optionReady(target)) return false;
    for (const choice of optionCandidates(target)) {
      if (!await choice.isVisible().catch(() => false)) continue;
      if (!await choice.click().then(() => true).catch(() => false)) continue;
      return confirm(target);
    }
    return false;
  };

  // The caller deliberately uses one ordering. Do not sample or switch to
  // All comments: it is a different Facebook view and can produce a different
  // page cursor from Newest.
  if (await choose("newest")) return { view: "newest", changed: true };
  await page.keyboard.press("Escape").catch(() => {});

  // One retry: staying in Most relevant is the single largest cause of a
  // scraped count below the reported one, so it is worth reopening the menu
  // once before accepting the filtered view.
  if (await ordering.click().then(() => true).catch(() => false)) {
    await choices.first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    if (await choose("newest")) return { view: "newest", changed: true };
    await page.keyboard.press("Escape").catch(() => {});
  }
  // The caller selected a single, audited source. Returning All comments or
  // Most relevant here would silently mix different Facebook orderings into
  // one saved tree, so signal that Newest was unavailable instead.
  return { view: "unknown", changed: false };
}

export function normalizeComment(raw: RawComment): FbBrowserComment | null {
  const identity = raw.url ? commentIdentity(raw.url) : null;
  const content = classifyCommentContent(raw);
  // Facebook occasionally renders a valid card without its timestamp
  // permalink. Retain it under a stable, explicitly-derived ID rather than
  // making the exported count smaller than the visible card count.
  if (!identity && !raw.fallbackKey) return null;
  if (!identity && !content.text && content.contentKind === "empty") return null;
  const id = identity?.id ?? derivedCommentId(raw.fallbackKey);
  const inferredParent = raw.parentUrl ? commentIdentity(raw.parentUrl)?.id : null;
  const parentId = identity?.parentId ?? (inferredParent !== id ? inferredParent : null) ?? null;
  let authorUrl = raw.authorUrl;
  if (authorUrl) {
    const url = new URL(authorUrl);
    for (const key of [...url.searchParams.keys()]) if (key !== "id") url.searchParams.delete(key);
    authorUrl = url.toString();
  }
  const reaction = raw.reaction?.match(/\b(\d[\d,]*)\b/);
  const text = content.text;
  const legacyType = legacyContentType(content.contentKind);
  const placeholderType: Exclude<FbCommentContentType, "text"> = legacyType === "text" ? "unavailable" : legacyType;
  return { id, parentId, commentUrl: raw.url, authorName: raw.author,
    authorProfileUrl: authorUrl, authorAvatar: raw.avatar, authorBadge: raw.badge,
    // Rich-media nodes retain a short label, not the attachment URL or media —
    // except emoji, which are the comment's actual content and are kept
    // verbatim. Replacing "🔥" with "[Emoji]" threw away the only thing the
    // author wrote; the label remains the fallback when nothing was captured.
    text: text || commentPlaceholder(placeholderType),
    contentType: legacyType, contentKind: content.contentKind, contentKinds: content.contentKinds,
    idSource: identity ? "permalink" : "derived",
    isHidden: raw.isHidden || undefined,
    hiddenSource: raw.isHidden ? raw.hiddenSource ?? "card_marker" : undefined,
    images: commentImages([...raw.images, ...raw.gifs, ...raw.stickers]), video: raw.video, timeLabel: raw.time, createdAt: null,
    likeCount: reaction ? Number(reaction[1].replace(/,/g, "")) : 0, metricsAvailable: Boolean(reaction),
    replyCount: 0, depth: parentId || /^Reply/i.test(raw.label) ? 1 : 0,
  };
}

async function assertAccess(page: Page) {
  if (/^\/(login|checkpoint|two_step_verification)(?:\/|\.php|$)/.test(new URL(page.url()).pathname)) throw new FbBrowserAuthError("Facebook requires a session check before loading comments.");
  // The page navigation itself can complete before Facebook has attached a
  // readable body. Keep fast selector defaults elsewhere, but give this
  // access check a bounded startup allowance so a cold page is not reported
  // as a generic fetch failure after two seconds.
  await page.locator("body").waitFor({ state: "attached", timeout: 7000 });
  // Read headings and alerts rather than the whole body. This runs on every
  // pass of the collection loop, and `innerText` on <body> forces a full
  // relayout plus a text serialisation of the entire comment list each time.
  const state = await page.evaluate(() => ({
    login: Boolean(document.querySelector('input[type="password"]')),
    text: [...document.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"], [role="alert"]')]
      .slice(0, 60).map((el) => el.textContent || "").join(" ").slice(0, 4000),
  }));
  if (state.login) throw new FbBrowserAuthError("Facebook is showing a login prompt. Refresh the saved Facebook session in Settings before trying again.");
  if (/you're temporarily blocked|you’re temporarily blocked|we limit how often|going too fast/i.test(state.text)) throw new FbBrowserRateLimitError("Facebook temporarily limited comment loading. Wait before retrying.");
}

/**
 * Facebook can show a raw count on the Reel button and a narrower count in
 * the opened comment tray (for example, "6 of 191 comments"). The latter is
 * the user-requested basis for the actionable delta, but only when it is a
 * visible Newest-panel label rather than arbitrary page text.
 */
export async function readNewestPanelReportedCount(page: Page): Promise<number | null> {
  // Facebook hydrates this label after the ordering control, particularly on
  // long Reels. Its tray counter may be rendered in a portal beside (rather
  // than beneath) the sort control. Accept it only when Newest is active and
  // the page exposes exactly one visible “of N comments” total; competing
  // totals are deliberately retried instead of guessed.
  for (let attempt = 0; attempt < 32; attempt++) {
    const result = await page.evaluate(() => {
      const visible = (node: Element) => node.getClientRects().length > 0;
      const newest = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((node) => visible(node) && /^Newest(?:\s|$)/i.test((node.innerText || "").trim()))
        .at(-1);
      if (!newest) return { count: null, ambiguous: false };

      const counts = new Set(
        [...document.querySelectorAll<HTMLElement>("*")]
          .filter(visible)
          .flatMap((node) => [...(node.innerText || "").replace(/\s+/g, " ").matchAll(/\b\d[\d,]*\s+of\s+(\d[\d,]*)\s+comments?\b/gi)]
            .map((match) => Number(match[1].replace(/,/g, ""))))
          .filter((count) => Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000),
      );
      if (counts.size !== 1) return { count: null, ambiguous: counts.size > 1 };
      return { count: [...counts][0], ambiguous: false };
    });
    if (result.count != null) return result.count;
    // An ambiguous tray is unsafe to record. A delayed label can appear on a
    // subsequent poll, while a second distinct total remains deliberately
    // retryable instead of corrupting the candidate's delta basis.
    if (!result.ambiguous && attempt < 31) await page.waitForTimeout(250);
    else break;
  }
  return null;
}

export async function fetchFacebookMediaComments(
  item: CommentMediaItem,
  cookies: string,
  options: { limit: number; withReplies: boolean; includeComments?: boolean; includeReactions?: boolean; includeMetadata?: boolean; panelCountOnly?: boolean; signal?: AbortSignal; context?: BrowserContext; onStage?: (stage: "opening" | "captions" | "reactions" | "comments") => void },
): Promise<MediaCommentsResult> {
  const started = Date.now();
  let stage: MediaDetailStage = "opening-media";
  options.signal?.throwIfAborted();
  const readInContext = async (context: BrowserContext) => {
    const page = await context.newPage();
    const found = new Map<string, FbBrowserComment>();
    let reportedCount: number | null = null;
    let panelReportedCount: number | null = null;
    let commentsSourceView: FbCommentsSourceView = "unknown";
    let engagement: FbMediaEngagement | undefined;
    let metadata: FbMediaMetadata | undefined;
    const detailErrors: string[] = [];
    const includeComments = options.includeComments !== false;
    const collectComments = (raws: RawComment[], revealedHiddenIds?: ReadonlySet<string>) => {
      for (const raw of raws) {
        const comment = normalizeComment(raw);
        if (!comment || (!options.withReplies && comment.depth !== 0)) continue;
        const incoming = revealedHiddenIds?.has(comment.id)
          ? { ...comment, isHidden: true, hiddenSource: "revealed_by_hidden_control" as const }
          : comment;
        found.set(incoming.id, found.has(incoming.id) ? mergeComment(found.get(incoming.id)!, incoming) : incoming);
      }
    };
    const retainedCommentResult = () => {
      const all = [...found.values()];
      const comments = threadComments(all, options.limit);
      const textCount = all.filter((comment) => comment.contentKind === "text").length;
      return {
        comments,
        commentsBreakdown: summarizeFbComments(comments),
        observedCommentCount: all.length,
        textCommentCount: textCount,
        excludedNonTextCommentCount: 0,
        excludedAttachmentCommentCount: 0,
        commentsContentScope: "observed_nodes" as const,
      };
    };
    const finish = (value: MediaCommentsResult): MediaCommentsResult => ({
      ...value, metadata, engagement,
      commentsSourceView: includeComments ? value.commentsSourceView ?? commentsSourceView : undefined,
      panelReportedCount: includeComments ? value.panelReportedCount ?? panelReportedCount : undefined,
      commentsStatus: includeComments ? value.commentsStatus ?? value.status : undefined,
      status: value.status === "partial" || engagement?.status === "partial" || detailErrors.length > 0 ? "partial" : "complete",
      ...(value.error || detailErrors.length ? { error: value.error || detailErrors.join(" ") } : {}),
    });
    const cancel = () => { void context.close().catch(() => {}); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      options.signal?.throwIfAborted();
      page.setDefaultTimeout(2000);
      await ensureFacebookPageCallbackRuntime(page);
      await page.route("**/*", (route) => ["media", "image", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
      options.onStage?.("opening");
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      stage = "checking-access";
      await assertAccess(page);
      await page.getByRole("button", { name: "Like", exact: true }).first().waitFor({ state: "visible", timeout: 7000 }).catch(() => {});
      await assertAccess(page);
      if (options.includeMetadata !== false) {
        stage = "reading-metadata";
        options.onStage?.("captions");
        try { metadata = await readMediaMetadata(page, item); } catch (error) {
          if (error instanceof Error && "partialMetadata" in error) metadata = error.partialMetadata as FbMediaMetadata;
          if (options.signal?.aborted || error instanceof FbBrowserAuthError || error instanceof FbBrowserRateLimitError) throw error;
          if (error instanceof Error && "mediaBlocked" in error && error.mediaBlocked) throw error;
          detailErrors.push("The caption or date could not be fully read.");
        }
      }
      if (options.includeReactions) {
        stage = "reading-reactions";
        options.onStage?.("reactions");
        try { engagement = await readMediaEngagement(page, item, options.signal); } catch (error) {
          if (options.signal?.aborted || error instanceof FbBrowserAuthError || error instanceof FbBrowserRateLimitError) throw error;
          engagement = { status: "partial", totalReactions: null, reactions: {}, shares: null, error: "Facebook reaction counts could not be fully read." };
        }
      }
      await assertAccess(page);
      if (!includeComments) return finish({ comments: [], status: "complete", stopReason: "details-read", durationMs: Date.now() - started });
      stage = "loading-comments";
      options.onStage?.("comments");
      const article = COMMENT_ARTICLES;
      const emptyState = page.getByText(/^(No comments yet|Be the first to comment)[.!]?$/i).first();
      const commentButton = page.getByRole("button", { name: item.contentType === "reels" ? "Comment" : "Leave a comment", exact: true }).first();
      if (item.contentType === "reels") {
        await commentButton.waitFor({ state: "visible", timeout: 7000 }).catch(() => {});
      } else {
        // Empty photo threads have no comment-count button. Do not spend seven
        // seconds waiting for a control after Facebook already rendered an empty state.
        await Promise.any([
          commentButton.waitFor({ state: "visible", timeout: 7000 }),
          page.locator(article).first().waitFor({ state: "visible", timeout: 7000 }),
          emptyState.waitFor({ state: "visible", timeout: 7000 }),
        ]).catch(() => {});
      }
      if (await emptyState.isVisible()) {
        return finish({ comments: [], status: "complete", stopReason: "no-comments", durationMs: Date.now() - started, reportedCount: 0, observedCommentCount: 0, textCommentCount: 0, excludedNonTextCommentCount: 0, excludedAttachmentCommentCount: 0, commentsContentScope: "observed_nodes" });
      }
      if (await commentButton.isVisible()) {
        const text = (await commentButton.innerText()).trim().replace(/,/g, "");
        if (/^\d+$/.test(text)) reportedCount = Number(text);
        if (item.contentType === "reels") await commentButton.click();
      }
      await Promise.any([
        page.locator(article).first().waitFor({ state: "visible", timeout: 2500 }),
        emptyState.waitFor({ state: "visible", timeout: 2500 }),
      ]).catch(() => {});
      await assertAccess(page);
      // Keep the initially visible comments even if ordering controls fail later.
      collectComments(await readComments(page));

      const selection = await selectCommentView(page);
      commentsSourceView = selection.view;
      // A candidate run must use exactly the Newest view. Do not retain the
      // initially rendered Most relevant/All comments cards when Facebook
      // cannot expose Newest; an additive workspace merge will preserve prior
      // evidence and a later retry can safely try again.
      if (commentsSourceView !== "newest") {
        found.clear();
        return finish({ ...retainedCommentResult(), status: "partial", commentsStatus: "partial", stopReason: "newest-unavailable", durationMs: Date.now() - started, reportedCount,
          error: "Facebook did not expose a Newest comment view for this media.",
        });
      }
      if (selection.changed) {
        // Switching Most relevant -> All/Newest replaces the comment cards.
        // Do not retain cards from the prior filter under the newly recorded
        // view source.
        found.clear();
        await Promise.any([
          page.locator(article).first().waitFor({ state: "visible", timeout: 6000 }),
          emptyState.waitFor({ state: "visible", timeout: 6000 }),
        ]).catch(() => {});
        collectComments(await readComments(page));
      }
      panelReportedCount = await readNewestPanelReportedCount(page);
      if (options.panelCountOnly) {
        // This dedicated metadata pass deliberately stops after the verified
        // Newest control and its "of N comments" label. It retains the small
        // initial visible set for a merge, but never burns minutes paginating a
        // thread when the caller needs only the panel's count basis.
        return finish({ ...retainedCommentResult(), status: "partial", commentsStatus: "partial", stopReason: "panel-count-read", durationMs: Date.now() - started, reportedCount });
      }

      // Larger public threads cannot be completely paged in the same fixed
      // window as a ten-comment photo. Keep ordinary items at three minutes,
      // but give a verified large badge a bounded, proportional window rather
      // than declaring it incomplete solely because the client was patient.
      // The cap protects a stalled Facebook tray from occupying a worker
      // forever; cancellation remains immediate through the job signal.
      const collectionReportedCount = panelReportedCount ?? reportedCount;
      const unlimitedBudget = commentCollectionBudgetMs(reportedCount, panelReportedCount);
      const deadline = Date.now() + (options.limit === 0 ? unlimitedBudget : Math.min(180_000, 30_000 + options.limit * 350));
      let idle = 0;
      let stalledExpansions = 0;
      // Only text expansion is ever abandoned; pagination never is.
      let ignoreTextExpanders = false;
      let status: MediaCommentsResult["status"] = "partial";
      let stopReason = "loading-stalled";
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        await assertAccess(page);
        const before = found.size;
        collectComments(await readComments(page));
        const expandThreads = options.limit === 0 || found.size < options.limit;
        // With no limit every comment is kept, so there is nothing to restrict —
        // and shipping thousands of IDs into the page each pass is pure cost.
        const commentIds = options.limit > 0 ? [...found.keys()].slice(0, options.limit) : undefined;
        const signature = await readCommentSignature(page);
        // Batch every visible control in one round trip. Falling back to the
        // single-control path only when in-page clicking was refused (an
        // overlay, a non-clickable node) keeps the slow path for hard cases.
        // Only truncated bodies are expanded in bulk. That is local DOM work
        // and safely batched. Pagination stays on the proven single-control
        // path: batching it measurably worsened coverage on a live run
        // (reel reported/scraped mismatches 10 -> 18, stalls 1 -> 24), so it is
        // not enabled again without live evidence that it helps.
        const batch = await expandCommentSectionBatch(page, {
          withReplies: options.withReplies, expandThreads: false, expandText: !ignoreTextExpanders, commentIds,
        });
        let expansion: Awaited<ReturnType<typeof advanceCommentSection>>;
        if (batch.text > 0) {
          // A text expansion only rewrites an existing card, so its own control
          // changing is an acceptable settle signal.
          const changed = await settleCommentSection(page, signature, 4000, "any");
          expansion = { pending: true, clicked: true, changed };
        } else {
          // An empty ID list suppresses text expansion without suppressing
          // pagination, so an unresolvable "See more" cannot stall the run
          // while more comments still wait behind a page control.
          expansion = await advanceCommentSection(page, {
            withReplies: options.withReplies, expandThreads,
            commentIds: ignoreTextExpanders ? [] : commentIds,
          });
        }
        if (expansion.changed) {
          const beforeIds = new Set(found.keys());
          const raws = await readComments(page);
          const revealedHiddenIds = expansion.revealedHidden
            ? new Set(raws.map((raw) => normalizeComment(raw)?.id).filter((id): id is string => Boolean(id && !beforeIds.has(id))))
            : undefined;
          collectComments(raws, revealedHiddenIds);
        }
        stalledExpansions = expansion.pending && !expansion.changed && found.size === before ? stalledExpansions + 1 : 0;
        if (stalledExpansions >= 4) {
          // A "See more" that will not resolve must not stop pagination, which
          // is what actually decides how many comments exist. Give up on the
          // stuck text only; never report a short list as a whole one.
          if (!ignoreTextExpanders && signature.expanders > 0) { ignoreTextExpanders = true; stalledExpansions = 0; continue; }
          stopReason = "loading-stalled";
          break;
        }
        const empty = page.getByText(/^(No comments yet|Be the first to comment)[.!]?$/i).first();
        if (!found.size && await empty.isVisible()) { status = "complete"; stopReason = "no-comments"; break; }
        idle = found.size === before && !expansion.pending ? idle + 1 : 0;
        // This extractor continues only after it has selected Newest. If that
        // option is unavailable it returns above without retaining another
        // ordering, so completion must not infer an unfiltered view here.
        const completion = commentCompletionReason({ found: found.size, limit: options.limit, reported: collectionReportedCount, pendingExpansion: expansion.pending, unfiltered: false, idle, view: commentsSourceView });
        if (completion) {
          // A visible list can be exhausted while Facebook's own numeric badge
          // still says there are more comments. That is useful evidence about
          // the currently exposed view, but it is not a complete retrieval and
          // must remain eligible for a later delta retry. A row is complete
          // only when there is no verified raw target, or its unique retained
          // comment IDs meet that target.
          const reachesReportedCount = collectionReportedCount == null || found.size >= collectionReportedCount;
          status = reachesReportedCount ? "complete" : "partial";
          stopReason = reachesReportedCount ? completion : "some-comments-unavailable";
          break;
        }
        // Facebook's own badge is positive evidence that more comments exist,
        // so a few quiet passes are not exhaustion. Reels and long relevance-
        // filtered threads load the next page lazily on scroll, and giving up
        // after three quick rounds exported 6 of a reported 59.
        const shortOfReported = collectionReportedCount !== null && found.size < collectionReportedCount;
        if (idle >= (shortOfReported ? 8 : 3)) {
          stopReason = "some-comments-unavailable";
          break;
        }
        // Scroll the comment tray itself, not the next reel in the background.
        if (!expansion.pending) {
          const last = page.locator(article).last();
          if (await last.count()) {
            await last.scrollIntoViewIfNeeded().catch(() => {});
            const box = await last.boundingBox();
            if (box) await page.mouse.move(box.x + Math.min(box.width / 2, 100), Math.min(box.y + box.height / 2, (page.viewportSize()?.height ?? 1200) - 10));
            // Lazy comment lists need sustained scrolling, not one nudge.
            const nudges = shortOfReported ? 4 : 1;
            for (let i = 0; i < nudges; i++) {
              await page.mouse.wheel(0, 650);
              if (nudges > 1) await page.waitForTimeout(250);
            }
          }
        }
        if (!expansion.clicked) await page.waitForTimeout(650);
      }
      if (Date.now() >= deadline) stopReason = "time-budget";
      await assertAccess(page);
      return finish({ ...retainedCommentResult(), status, stopReason, durationMs: Date.now() - started, reportedCount });
    } catch (error) {
      if (options.signal?.aborted) {
        return finish({ ...retainedCommentResult(), status: "partial", stopReason: "cancelled", durationMs: Date.now() - started, reportedCount });
      }
      if (found.size || metadata || engagement) {
        const fatal = error instanceof FbBrowserAuthError ? "authentication" : error instanceof FbBrowserRateLimitError ? "rate_limit" : null;
        return finish({ ...retainedCommentResult(), status: "partial", stopReason: fatal ?? "loading-interrupted", durationMs: Date.now() - started, reportedCount,
          error: fatal === "authentication" ? "Facebook requires sign-in; collected details were preserved." : fatal === "rate_limit" ? "Facebook temporarily limited this session; collected details were preserved." : "Loading stopped before all requested details were retrieved.",
        });
      }
      if (error instanceof FbBrowserAuthError || error instanceof FbBrowserRateLimitError) throw error;
      throw new FbMediaDetailFetchError(stage, mediaDetailFailureKind(error));
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      // A pooled context stays authenticated for its next assigned item, but
      // its media page must never survive an item or retain a hidden renderer.
      await page.close().catch(() => {});
    }
  };
  return options.context
    ? readInContext(options.context)
    : withFacebookContext(cookies, readInContext, { blockMedia: true });
}
