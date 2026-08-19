/**
 * Why does establishGraphqlSession() report every Facebook session as dead?
 *
 * The saved cookies may be perfectly valid while our fb_dtsg extraction is
 * stale — exactly the failure mode we hit with Instagram's comments endpoint,
 * where the request looked fine and the parsing was wrong. This inspects what
 * Facebook actually returns rather than trusting the boolean.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeFbCookies } from "../../src/server/services/facebook/session-fetcher";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db
    .from("fb_sessions")
    .select("id, label, c_user, status, cookie_encrypted, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return console.log("no fb_sessions row");

  console.log(`session ${data.id}`);
  console.log(`  label=${data.label} c_user=${data.c_user} db_status=${data.status}`);
  console.log(`  created=${data.created_at}`);

  const raw = decrypt(data.cookie_encrypted);
  const { cookie, cUser } = normalizeFbCookies(raw);

  // What cookies are actually present? (names only — never values)
  const names = cookie
    .split(/;\s*/)
    .map((p) => p.split("=")[0].trim())
    .filter(Boolean);
  console.log(`\n  cookie names present (${names.length}): ${names.join(", ")}`);
  console.log(`  c_user parsed: ${cUser ?? "MISSING"}`);
  console.log(`  xs present   : ${/(^|;\s*)xs=/.test(cookie)}`);
  for (const need of ["c_user", "xs", "datr", "sb", "fr"]) {
    const has = names.includes(need);
    console.log(`    ${need.padEnd(7)} ${has ? "yes" : "no"}`);
  }

  console.log(`\n=== fetching https://www.facebook.com/ with these cookies ===`);
  const res = await fetch("https://www.facebook.com/", {
    headers: {
      "User-Agent": DESKTOP_UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
    },
    redirect: "follow",
    cache: "no-store",
  });
  const html = await res.text();
  console.log(`  HTTP ${res.status}, final URL: ${res.url}`);
  console.log(`  html length: ${html.length}`);

  // Logged-in vs logged-out signals
  console.log(`\n  LOGGED-IN SIGNALS:`);
  const signals: [string, boolean][] = [
    ['"USER_ID":"<digits>" present', /"USER_ID"\s*:\s*"(\d+)"/.test(html)],
    ["actorID present", /"actorID"\s*:\s*"?\d+/.test(html)],
    ["login form (name=pass)", /name="pass"/.test(html)],
    ["redirected to /login", /\/login/i.test(res.url)],
    ["checkpoint", /checkpoint/i.test(res.url) || /checkpoint\/block/i.test(html)],
  ];
  for (const [label, hit] of signals) console.log(`    ${hit ? "YES" : "no "}  ${label}`);
  const uid = /"USER_ID"\s*:\s*"(\d+)"/.exec(html)?.[1];
  if (uid) console.log(`    USER_ID = ${uid}  (cookie c_user = ${cUser}) ${uid === cUser ? "MATCH" : "MISMATCH"}`);

  console.log(`\n  TOKEN EXTRACTION — patterns currently used by establishGraphqlSession():`);
  const patterns: [string, RegExp][] = [
    ["DTSGInitialData", /"DTSGInitialData",\s*\[\],\s*\{\s*"token"\s*:\s*"([^"]+)"/],
    ['"dtsg":{"token"', /"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/],
    ['input name="fb_dtsg"', /name="fb_dtsg"\s+value="([^"]+)"/],
  ];
  let found = false;
  for (const [label, re] of patterns) {
    const m = re.exec(html);
    console.log(`    ${m ? "HIT " : "miss"}  ${label}${m ? ` -> ${m[1].slice(0, 14)}…` : ""}`);
    if (m) found = true;
  }

  if (!found) {
    console.log(`\n  NONE MATCHED — searching for any dtsg-shaped token in the page:`);
    const alts: [string, RegExp][] = [
      ["DTSGInitData", /DTSGInitData[^}]{0,120}?"token"\s*:\s*"([^"]{10,})"/],
      ["async_get_token", /"async_get_token"\s*:\s*"([^"]{10,})"/],
      ['any "token":"NA..."', /"token"\s*:\s*"(NA[A-Za-z0-9_-]{10,})"/],
      ["f= prefixed dtsg", /"(AQ[A-Za-z0-9_-]{20,})"/],
      ["literal fb_dtsg anywhere", /fb_dtsg/],
    ];
    for (const [label, re] of alts) {
      const m = re.exec(html);
      console.log(`    ${m ? "HIT " : "miss"}  ${label}${m && m[1] ? ` -> ${String(m[1]).slice(0, 18)}…` : ""}`);
    }
    const idx = html.indexOf("DTSGInit");
    if (idx >= 0) {
      console.log(`\n  context around first "DTSGInit" (200 chars):`);
      console.log("    " + html.slice(idx, idx + 200).replace(/\s+/g, " "));
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
