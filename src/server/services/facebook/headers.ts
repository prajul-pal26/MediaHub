/**
 * Browser-realistic request headers for Facebook.
 *
 * Facebook rejects HTTP requests that don't look like a real browser navigation
 * with a bare `HTTP 400` and a ~1.5KB "Sorry, something went wrong" page. This
 * happens BEFORE any session check, so it is indistinguishable from a dead
 * session unless you look at the body — and it fires identically when no
 * cookies are sent at all, which is how it was finally isolated.
 *
 * The `Sec-Fetch-*` and `sec-ch-ua` client hints are the load-bearing part:
 * with them the same cookies return HTTP 200 and fully logged-in HTML.
 *
 * Every Facebook request in this codebase should go through here.
 */

export const FB_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Headers for a top-level page navigation (loading facebook.com, a profile, a post). */
export function fbNavigationHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": FB_DESKTOP_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    // Without these client hints Facebook answers 400 regardless of cookies.
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua": '"Chromium";v="120", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** Headers for an in-page XHR/fetch (GraphQL, internal JSON endpoints). */
export function fbXhrHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": FB_DESKTOP_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookie,
    Origin: "https://www.facebook.com",
    Referer: "https://www.facebook.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "sec-ch-ua": '"Chromium";v="120", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    ...extra,
  };
}

/**
 * Facebook's generic rejection page. Detecting it lets callers report "the
 * request was refused" instead of the misleading "your session is dead".
 */
export function isFacebookRejection(status: number, body: string): boolean {
  return status === 400 && body.length < 5000 && /something went wrong/i.test(body);
}
