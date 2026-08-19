/**
 * Facebook PAGE scraper via a real headless browser (Playwright + Chromium).
 *
 * The token/HTML methods are dead (Facebook serves a JS shell to plain fetch),
 * so we render the page as a genuine Chrome using the user's session cookies and
 * read the data off the live DOM — the same way a person browsing it would.
 *
 * NOTE: against Meta ToS; slow (2–5s); Facebook can checkpoint the session. Use a
 * throwaway account. A single Chromium instance is reused across requests.
 */
import { getSharedBrowser, resetSharedBrowser, toPlaywrightCookies, DESKTOP_UA as UA } from "./browser-pool";

export class FbBrowserAuthError extends Error {}

export interface FbBrowserPost {
  text: string;
  likes: number;
  comments: number;
}
export interface FbBrowserPage {
  handle: string;
  name: string;
  url: string;
  profilePic: string | null;
  followers: number | null;
  likes: number | null;
  category: string | null;
  about: string | null;
  verified: boolean;
  posts: FbBrowserPost[];
  /**
   * Cross-platform handles and contact details from the profile's
   * "Contact info" / "Links" panel. Facebook renders the Instagram row as a
   * bare username with only an icon to identify the platform, so these are
   * recovered from the anchor href (unwrapped from its l.php redirect) rather
   * than from the visible text — a text scan alone finds nothing.
   */
  instagram: string | null;
  twitter: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

function toNum(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /([\d.,]+)\s*([KMB]?)/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult =
    m[2]?.toUpperCase() === "B" ? 1e9 : m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

/** Scrape a Facebook page's public data using the session cookies. */
export async function fetchFacebookPageViaBrowser(
  handleRaw: string,
  cookieString: string,
): Promise<FbBrowserPage> {
  const handle = handleRaw.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?facebook\.com\//i, "").replace(/\/+$/, "");
  if (!handle) throw new Error("Empty page handle");
  if (!/c_user=/.test(cookieString) || !/xs=/.test(cookieString)) {
    throw new FbBrowserAuthError("Facebook cookies must include c_user and xs");
  }

  const targetUrl = `https://www.facebook.com/${encodeURIComponent(handle)}`;
  const cookies = toPlaywrightCookies(cookieString);

  const attempt = async (): Promise<FbBrowserPage> => {
  const browser = await getSharedBrowser();
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 1200 } });
  try {
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(5500);

    // The Contact-info / Links rows hydrate a beat after the rest of the page.
    // Without this wait their anchors are simply absent and every social link
    // comes back empty.
    try {
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("a[href]")).some((a) =>
            /l\.php\?u=|instagram\.com|mailto:/i.test((a as HTMLAnchorElement).href),
          ),
        { timeout: 12000 },
      );
      await page.waitForTimeout(1500);
    } catch {
      /* profile genuinely lists nothing — fall through with what we have */
    }

    const url = page.url();
    if (/\/login|\/checkpoint/i.test(url)) {
      throw new FbBrowserAuthError("Facebook redirected to login/checkpoint — session invalid or flagged");
    }

    const raw = await page.evaluate(() => {
      const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      const body = (document.body?.innerText || "").replace(/ /g, " ");
      const nameFrom = () => {
        const h1 = q('[role="main"] h1') || q("h1");
        if (h1 && h1.innerText.trim()) return h1.innerText.trim();
        const og = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
        if (og?.content) return og.content;
        const t = document.title.replace(/\s*[|·].*$/, "").trim();
        return t && t.toLowerCase() !== "facebook" ? t : "";
      };
      const picFrom = () => {
        const el =
          document.querySelector('[role="main"] svg image') ||
          document.querySelector('[role="main"] image') ||
          document.querySelector('[role="main"] img');
        if (!el) return "";
        return (
          el.getAttribute("xlink:href") || el.getAttribute("href") || (el as HTMLImageElement).src || ""
        );
      };
      const followers = (body.match(/([\d.,]+[KMB]?)\s*followers/i) || [])[1] || "";
      const likes = (body.match(/([\d.,]+[KMB]?)\s*likes/i) || [])[1] || "";
      const catEl =
        document.querySelector('[role="main"] a[href*="/pages/category/"]') ||
        document.querySelector('a[href*="/pages/category/"]');
      const category = catEl ? (catEl as HTMLElement).innerText.trim() : "";
      const postEls = Array.from(
        document.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]'),
      ).slice(0, 8);
      const posts = postEls.map((el) => {
        // the whole post article (contains the reactions/comments/shares bar)
        const container: HTMLElement | null =
          (el as HTMLElement).closest('[role="article"]') ||
          (() => {
            let c: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 10 && c; i++) c = c.parentElement;
            return c;
          })();
        const ctxt = (container?.innerText || "").replace(/ /g, " ");
        const rx = container?.querySelector(
          '[aria-label*="reaction" i],[aria-label*="All reactions" i]',
        );
        const likesTxt = rx
          ? ((rx.getAttribute("aria-label") || "").match(/([\d.,]+[KMB]?)/) || [])[1] || ""
          : (ctxt.match(/([\d.,]+[KMB]?)\s*(?:reactions|likes)/i) || [])[1] || "";
        return {
          text: (el as HTMLElement).innerText.slice(0, 280),
          likes: likesTxt,
          comments: (ctxt.match(/([\d.,]+[KMB]?)\s*comments?/i) || [])[1] || "",
        };
      });
      const verified = !!document.querySelector(
        '[role="main"] [aria-label*="Verified" i], svg[aria-label*="Verified" i], [aria-label="Verified account"]',
      );
      const urlName = decodeURIComponent(location.pathname.replace(/^\/|\/$/g, "")).replace(/[-.]/g, " ");

      // ── Contact info / Links ────────────────────────────────────────────
      // Facebook wraps outbound links as l.facebook.com/l.php?u=<encoded>;
      // the visible text is just the bare handle, so read the href instead.
      const unwrap = (href: string): string => {
        let u = href;
        const m = /[?&]u=([^&]+)/.exec(u);
        if (m) {
          try {
            u = decodeURIComponent(m[1]);
          } catch {
            /* keep the wrapped form */
          }
        }
        return u.split("?")[0].replace(/\/+$/, "");
      };

      let instagram = "";
      let twitter = "";
      let email = "";
      let website = "";
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (a as HTMLAnchorElement).href;
        if (!email && /^mailto:/i.test(href)) {
          email = href.replace(/^mailto:/i, "").trim();
          continue;
        }
        const u = unwrap(href);
        if (!instagram && /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u)) instagram = u;
        else if (!twitter && /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u)) twitter = u;
        else if (
          !website &&
          /^https?:\/\//i.test(u) &&
          !/facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|messenger\.com|whatsapp\.com/i.test(u)
        )
          website = u;
      }
      // Phone appears as its own contact row, never as a link.
      const phone = (body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/) || [])[1] || "";

      return {
        name: nameFrom(),
        urlName,
        pic: picFrom(),
        followers,
        likes,
        category,
        posts,
        verified,
        bodyLen: body.length,
        instagram,
        twitter,
        email,
        phone,
        website,
      };
    });

    if (!raw.name && !raw.followers && raw.bodyLen < 400) {
      throw new FbBrowserAuthError("Facebook returned no data — session may be invalid or the page blocked");
    }

    return {
      handle,
      name: raw.name || (raw.urlName && !/^\d+$/.test(raw.urlName) ? raw.urlName : "") || handle,
      url: `https://www.facebook.com/${handle}`,
      profilePic: raw.pic || null,
      followers: toNum(raw.followers),
      likes: toNum(raw.likes),
      category: raw.category?.trim() || null,
      about: null,
      verified: raw.verified,
      posts: (raw.posts || [])
        .filter((p) => p.text)
        .map((p) => ({ text: p.text, likes: toNum(p.likes) ?? 0, comments: toNum(p.comments) ?? 0 })),
      instagram: raw.instagram || null,
      twitter: raw.twitter || null,
      email: raw.email || null,
      phone: raw.phone?.trim() || null,
      website: raw.website || null,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
  };

  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof FbBrowserAuthError) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Transient network / DNS / timeout → reset the browser and retry once.
      if (i === 0 && /ERR_NAME_NOT_RESOLVED|net::|ERR_|Timeout|timed out/i.test(msg)) {
        await resetSharedBrowser();
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    "Couldn't load the Facebook page (network hiccup or Facebook throttling) — please try again. " +
      (lastErr instanceof Error ? lastErr.message.slice(0, 100) : ""),
  );
}
