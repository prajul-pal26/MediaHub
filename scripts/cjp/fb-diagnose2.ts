/**
 * facebook.com returns HTTP 400 with a 1.5KB body for our cookie bundle.
 * Dump that body and vary one thing at a time to find what Facebook objects to:
 * the headers, the host, or the cookie set itself.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeFbCookies } from "../../src/server/services/facebook/session-fetcher";

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

function summarize(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 300);
}

async function attempt(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; len: number; loggedIn: boolean }> {
  try {
    const res = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
    const html = await res.text();
    const loggedIn = /"USER_ID"\s*:\s*"\d+"/.test(html) || /name="fb_dtsg"/.test(html);
    console.log(`\n[${label}]`);
    console.log(`  HTTP ${res.status}  len=${html.length}  finalURL=${res.url}`);
    console.log(`  logged-in markers: ${loggedIn ? "YES" : "no"}`);
    if (html.length < 4000) console.log(`  body: ${summarize(html)}`);
    return { status: res.status, len: html.length, loggedIn };
  } catch (e: any) {
    console.log(`\n[${label}] threw: ${e.message}`);
    return { status: 0, len: 0, loggedIn: false };
  }
}

async function main() {
  const { data } = await db
    .from("fb_sessions")
    .select("cookie_encrypted, c_user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { cookie } = normalizeFbCookies(decrypt(data!.cookie_encrypted));

  // Inspect the xs value's SHAPE (not its secret content) — a truncated or
  // double-encoded xs is a classic cause of a hard 400.
  const xs = /(?:^|;\s*)xs=([^;]*)/.exec(cookie)?.[1] ?? "";
  console.log("=== cookie shape check ===");
  console.log(`  xs length         : ${xs.length}`);
  console.log(`  xs segment count  : ${xs.split(/%3A|:/i).length} (a real xs has ~6 colon-separated parts)`);
  console.log(`  xs percent-encoded: ${/%3A/i.test(xs)}`);
  console.log(`  xs raw colons     : ${/:/.test(xs)}`);
  console.log(`  xs double-encoded : ${/%253A/i.test(xs)}`);
  console.log(`  xs quoted         : ${/^["']|["']$/.test(xs)}`);
  console.log(`  xs has whitespace : ${/\s/.test(xs)}`);

  const minimal = { "User-Agent": UA_DESKTOP, Cookie: cookie };

  const browserish: Record<string, string> = {
    "User-Agent": UA_DESKTOP,
    Cookie: cookie,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": '"Chromium";v="120", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };

  await attempt("A. www + minimal headers", "https://www.facebook.com/", minimal);
  await attempt("B. www + full browser headers", "https://www.facebook.com/", browserish);
  await attempt("C. mbasic + browser headers", "https://mbasic.facebook.com/", browserish);
  await attempt("D. m.facebook + browser headers", "https://m.facebook.com/", browserish);
  await attempt("E. www NO cookies (control)", "https://www.facebook.com/", {
    "User-Agent": UA_DESKTOP,
    Accept: "text/html,*/*",
  });

  // Does c_user alone (no xs) behave differently? Isolates which cookie 400s.
  const cUserOnly = cookie
    .split(/;\s*/)
    .filter((p) => /^c_user=/.test(p))
    .join("; ");
  await attempt("F. www + c_user only", "https://www.facebook.com/", {
    "User-Agent": UA_DESKTOP,
    Cookie: cUserOnly,
    Accept: "text/html,*/*",
  });

  const datrOnly = cookie
    .split(/;\s*/)
    .filter((p) => /^datr=/.test(p))
    .join("; ");
  await attempt("G. www + datr only", "https://www.facebook.com/", {
    "User-Agent": UA_DESKTOP,
    Cookie: datrOnly,
    Accept: "text/html,*/*",
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
