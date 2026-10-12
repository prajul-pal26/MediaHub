/**
 * What counts as an importable Instagram link, and what counts as an Instagram
 * media host.
 *
 * Shared by the three places that have to agree about it:
 *
 *   - `AudioLibrary` — inline validation, so a typo is rejected before a round
 *     trip rather than coming back as a failed row.
 *   - `editor.importAudioFromUrl` — the real gate. The mutation makes the
 *     SERVER fetch a URL on the user's behalf, so "is this Instagram" has to be
 *     decided by parsing, not by pattern-matching a substring.
 *   - `worker.ts`, for the media URL Instagram hands back.
 *
 * Pure and dependency-free on purpose: this is imported into the browser
 * bundle, so it must not reach for `@/server/*` or node builtins.
 *
 * Why not just `extractInstagramShortcode` from
 * `src/server/services/instagram/fetcher.ts`? It is the right helper for a
 * search box — it accepts a bare shortcode and finds `instagram.com/reel/<code>`
 * ANYWHERE in the string. That last part is what makes it unsafe here:
 * `https://evil.example/instagram.com/reel/abcdefghijk/` satisfies its regex.
 * This module establishes the host with `new URL` first and only then reads the
 * path, which is the difference between a validated Instagram link and an
 * SSRF-shaped "fetch any URL" endpoint. The shortcode it extracts is then fed
 * to the service layer exactly as before.
 */

/** Longest `source_url` we will store, and the longest input we will parse. */
export const MAX_INSTAGRAM_URL_LENGTH = 2048;

/**
 * Real shortcodes are 11 characters (10 on some older posts). The range is
 * deliberately loose at the top but bounded — it ends up inside a URL path and
 * is base64-decoded to a media id, and neither wants an unbounded string.
 */
const SHORTCODE = "[A-Za-z0-9_-]{5,32}";

/** `/reel/<code>`, `/reels/<code>`, `/p/<code>`, `/tv/<code>`, optionally prefixed by the owner's username. */
const MEDIA_PATH_RE = new RegExp(`^/(?:([A-Za-z0-9._]{1,40})/)?(reel|reels|p|tv)/(${SHORTCODE})/?$`);

/** The "copy link" form: `/share/reel/<code>`, `/share/p/<code>`. */
const SHARE_MEDIA_PATH_RE = new RegExp(`^/share/(reel|reels|p|tv)/(${SHORTCODE})/?$`);

/**
 * The newer opaque share form: `/share/<token>`. The token is NOT a shortcode —
 * base64-decoding it would produce a wrong media id — so it has to be followed
 * to wherever Instagram redirects before anything can be read from it.
 */
const SHARE_TOKEN_PATH_RE = new RegExp(`^/share/(${SHORTCODE})/?$`);

/**
 * Instagram serves media bytes from its own CDNs, which are separate hosts from
 * instagram.com. Same allow-list as `ALLOWED_HOST` in
 * `src/app/api/insta-media/route.ts`, which is the existing proxy for exactly
 * these URLs — the two should not disagree about what an Instagram CDN is.
 */
const MEDIA_HOST_RE = /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

export type InstagramMediaKind = "reel" | "post" | "tv";

export interface ParsedInstagramMediaUrl {
  /** Query and fragment stripped — `?igsh=` tracking never reaches the database. */
  canonicalUrl: string;
  /** Null only when `needsRedirectResolve` is true. */
  shortcode: string | null;
  kind: InstagramMediaKind | null;
  /**
   * True for `/share/<token>`, which is an opaque redirect rather than a media
   * path. The caller has to follow it and re-parse the destination.
   */
  needsRedirectResolve: boolean;
}

export type InstagramUrlResult =
  | { ok: true; value: ParsedInstagramMediaUrl }
  | { ok: false; reason: string };

function normaliseHost(hostname: string): string {
  // A trailing dot is a legal, fully-qualified spelling of the same host, and
  // `new URL` keeps it: "instagram.com." must not read as a different host.
  return hostname.toLowerCase().replace(/\.$/, "");
}

/** True for instagram.com itself and its subdomains — never for `ddinstagram.com`. */
function isInstagramSiteHost(hostname: string): boolean {
  const host = normaliseHost(hostname);
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

/**
 * True for a host Instagram actually serves media bytes from.
 *
 * Used on the URL that comes BACK from Instagram's API. That URL is data, not a
 * promise: checking it is what stops a surprising API response turning the
 * worker into a fetcher for an arbitrary host.
 */
export function isInstagramMediaHost(hostname: string): boolean {
  return MEDIA_HOST_RE.test(normaliseHost(hostname));
}

/**
 * Parse a pasted Instagram link.
 *
 * Returns a readable `reason` rather than throwing, because every caller wants
 * to show that reason to the user verbatim.
 */
export function parseInstagramMediaUrl(input: string): InstagramUrlResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "Paste an Instagram reel or post link." };
  if (raw.length > MAX_INSTAGRAM_URL_LENGTH) {
    return { ok: false, reason: "That link is too long to be an Instagram link." };
  }

  // Pasted links frequently arrive without a scheme ("instagram.com/reel/..."),
  // which `new URL` rejects outright. Prefixing https:// is safe: a string that
  // already carries ANY scheme keeps it and is then rejected by the protocol
  // check below unless it is http(s).
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That is not a valid link." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only https links are supported." };
  }

  if (!isInstagramSiteHost(url.hostname)) {
    return {
      ok: false,
      reason: "Only instagram.com links can be imported — paste a reel or post link.",
    };
  }

  // Credentials in the authority ("https://user:pass@instagram.com/...") are a
  // request smuggling shape, never something a share sheet produces.
  if (url.username || url.password) {
    return { ok: false, reason: "That is not a valid Instagram link." };
  }

  const path = url.pathname;

  const share = SHARE_MEDIA_PATH_RE.exec(path);
  if (share) {
    return { ok: true, value: canonical(share[1], share[2]) };
  }

  const media = MEDIA_PATH_RE.exec(path);
  if (media) {
    return { ok: true, value: canonical(media[2], media[3]) };
  }

  const token = SHARE_TOKEN_PATH_RE.exec(path);
  if (token) {
    return {
      ok: true,
      value: {
        // Keep the share link exactly as Instagram minted it: the token is the
        // whole address, and a "canonical" rewrite would break the redirect.
        canonicalUrl: `https://www.instagram.com/share/${token[1]}/`,
        shortcode: null,
        kind: null,
        needsRedirectResolve: true,
      },
    };
  }

  return {
    ok: false,
    reason:
      "That Instagram link is not a reel or a post. Use the link from a reel or post — for example https://www.instagram.com/reel/Ddl_CGBA_hO/.",
  };
}

function canonical(segment: string, shortcode: string): ParsedInstagramMediaUrl {
  const kind: InstagramMediaKind =
    segment === "p" ? "post" : segment === "tv" ? "tv" : "reel";
  // `reels` collapses to `reel`, and the query string is dropped with it.
  const pathSegment = kind === "post" ? "p" : kind;
  return {
    canonicalUrl: `https://www.instagram.com/${pathSegment}/${shortcode}/`,
    shortcode,
    kind,
    needsRedirectResolve: false,
  };
}

/** A short label for an imported track, before anything better is known. */
export function instagramTrackName(shortcode: string | null, owner?: string | null): string {
  const who = owner?.trim();
  if (who) return `${who} · ${shortcode ?? "reel"}`.slice(0, 120);
  return `Instagram ${shortcode ?? "reel"}`.slice(0, 120);
}
