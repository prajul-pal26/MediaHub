import { createHash } from "node:crypto";
import { withFacebookContext } from "./browser-pool";
import { mediaCollection } from "./media-grid";
import type { FbBrowserPage } from "./browser-fetcher";

type ProfileDetails = Pick<FbBrowserPage, "email" | "phone" | "website" | "instagram" | "twitter" | "followers" | "about" | "category">;
interface ProfileSnapshot { lines: string[]; links: { href: string; text: string }[] }

/** Only the owner's public About fields; never contact details inside reviews. */
export function profileDetails(snapshot: ProfileSnapshot): ProfileDetails {
  const details: ProfileDetails = { email: null, phone: null, website: null, instagram: null, twitter: null, followers: null, about: null, category: null };
  const boundary = snapshot.lines.findIndex((s) => /^Reviews$/i.test(s));
  const lines = boundary < 0 ? snapshot.lines : snapshot.lines.slice(0, boundary);
  const categoryIndex = lines.findIndex((line) => /^(Politician|Political candidate|Political organization|Public figure|Artist|Musician\/band|Digital creator|Community|Business|Organization)$/i.test(line));
  if (categoryIndex >= 0) {
    details.category = lines[categoryIndex];
    const bioStart = lines.indexOf("Search");
    if (bioStart >= 0 && bioStart < categoryIndex - 1) details.about = lines.slice(bioStart + 1, categoryIndex).join("\n");
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const value = lines[i + 1];
    if (/^Email$/i.test(lines[i]) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) details.email = value;
    if (/^(Phone|Mobile)$/i.test(lines[i]) && /^\+?\d[\d ()-]{6,20}\d$/.test(value)) details.phone = value;
  }
  for (const link of snapshot.links) {
    try {
      let url = new URL(link.href);
      if (/^(?:l|lm)\.facebook\.com$/i.test(url.hostname) && url.searchParams.has("u")) url = new URL(url.searchParams.get("u")!);
      if (url.protocol === "mailto:" && !details.email) details.email = decodeURIComponent(url.pathname);
      if (url.protocol === "tel:" && !details.phone) details.phone = decodeURIComponent(url.pathname);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.searchParams.delete("fbclid");
      const host = url.hostname.replace(/^www\./i, "");
      if (host === "instagram.com" && /^\/[\w.]+\/?$/.test(url.pathname)) details.instagram ??= url.toString();
      else if ((host === "twitter.com" || host === "x.com") && /^\/[\w]+\/?$/.test(url.pathname)) details.twitter ??= url.toString();
      else if (!/(^|\.)(facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|messenger\.com|whatsapp\.com)$/.test(host)) details.website ??= url.toString();
      const followers = /^([\d,.]+)\s*([KM])? followers$/i.exec(link.text);
      if (followers) details.followers = Math.round(Number(followers[1].replace(/,/g, "")) * (followers[2]?.toUpperCase() === "M" ? 1e6 : followers[2] ? 1e3 : 1));
    } catch { /* Skip malformed public links. */ }
  }
  return details;
}

const cache = new Map<string, { expires: number; value: ProfileDetails }>();
const pending = new Map<string, Promise<ProfileDetails>>();

export async function fetchFacebookMediaProfile(input: string, cookies: string, refresh = false): Promise<ProfileDetails> {
  const target = mediaCollection(input, "posts");
  const key = createHash("sha256").update(JSON.stringify([target.url, cookies])).digest("hex");
  const saved = cache.get(key);
  if (!refresh && saved && saved.expires > Date.now()) return { ...saved.value };
  if (pending.has(key)) return pending.get(key)!;
  const task = withFacebookContext(cookies, async (context) => {
    const page = await context.newPage();
    await page.goto(`${target.url}about_contact_and_basic_info`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await page.getByRole("link", { name: "Contact info", exact: true }).first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    const snapshot = await page.evaluate(() => {
      const main = document.querySelector('[role="main"]');
      if (!main) return { lines: [], links: [] };
      const review = [...main.querySelectorAll('a[href]')].find((el) => el.textContent?.trim() === "Reviews");
      const links = [...main.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((el) => !el.closest('[role="article"]') && (!review || Boolean(el.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING)))
        .map((el) => ({ href: el.href, text: el.innerText.trim() }));
      // innerText is read from the live surface so labels remain line-separated.
      return { lines: (main as HTMLElement).innerText.split(/\n/).map((s) => s.trim()).filter(Boolean), links };
    });
    const value = profileDetails(snapshot);
    for (const [id, row] of cache) if (row.expires <= Date.now()) cache.delete(id);
    if (cache.size >= 30) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 5 * 60_000, value });
    return value;
  }, { blockMedia: true });
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
