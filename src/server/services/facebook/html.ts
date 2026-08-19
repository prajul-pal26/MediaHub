/**
 * Minimal HTML helpers for the mbasic scraper.
 *
 * mbasic.facebook.com serves plain server-rendered markup with no JS, so a few
 * focused regex helpers beat pulling in a full DOM parser. Everything here is
 * read-only string work — no evaluation of page content.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip tags to readable text, keeping block-level line breaks. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Pull one attribute off the first tag matching `tagPattern`. */
export function attr(html: string, attribute: string): string | null {
  const re = new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(html);
  const value = m?.[2] ?? m?.[3];
  return value == null ? null : decodeEntities(value);
}

/** All values of an attribute across the fragment. */
export function attrAll(html: string, attribute: string): string[] {
  const re = new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, "gi");
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const value = m[2] ?? m[3];
    if (value) out.push(decodeEntities(value));
  }
  return out;
}

/** Resolve an mbasic-relative href to an absolute www.facebook.com URL. */
export function absoluteUrl(href: string | null | undefined, host = "www.facebook.com"): string | null {
  if (!href) return null;
  const value = decodeEntities(href);
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://${host}${value}`;
  return null;
}

/**
 * Facebook wraps outbound links in /l.php?u=<encoded>. Unwrap so callers get
 * the real destination rather than the tracker.
 */
export function unwrapRedirect(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "https://www.facebook.com");
    if (/^\/l\.php$/i.test(parsed.pathname) || parsed.pathname === "/flx/warn/") {
      const target = parsed.searchParams.get("u");
      if (target) return decodeURIComponent(target);
    }
  } catch {
    /* leave as-is */
  }
  return url;
}

/**
 * Slice out every top-level fragment starting at a tag matching `openPattern`,
 * balanced on `<tagName ...>` / `</tagName>`. Regex alone can't nest; this walks
 * the tags to find the true closing boundary.
 */
export function extractBlocks(html: string, openPattern: RegExp, tagName: string): string[] {
  const blocks: string[] = [];
  const open = new RegExp(openPattern.source, openPattern.flags.includes("g") ? openPattern.flags : `${openPattern.flags}g`);
  const boundary = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, "gi");

  for (const match of html.matchAll(open)) {
    const start = match.index ?? 0;
    // A self-closing / void match can't contain anything.
    if (/\/>\s*$/.test(match[0])) continue;
    boundary.lastIndex = start + match[0].length;
    let depth = 1;
    let end = -1;
    let step: RegExpExecArray | null;
    while ((step = boundary.exec(html)) !== null) {
      if (step[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          end = step.index + step[0].length;
          break;
        }
      } else {
        depth += 1;
      }
    }
    blocks.push(end > start ? html.slice(start, end) : html.slice(start));
  }
  return blocks;
}

/** Parse the JSON blob Facebook stashes in `data-ft` / `data-store` attributes. */
export function parseDataAttr(html: string, attribute: string): Record<string, any> | null {
  const raw = attr(html, attribute);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
