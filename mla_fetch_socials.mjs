/**
 * Fetch Instagram / X handles (plus email, phone, website) for every MLA in
 * up_mla_403.csv by reading each Facebook profile's contact panel.
 *
 * Two things make this fast AND correct:
 *
 *  1. Hit /about_contact_and_basic_info, NOT the main profile. The main page
 *     renders the whole post feed before the contact panel (~9s, and often
 *     never within a sane cap -> false negatives). The contact subpage renders
 *     the panel first: ~2s, and it finds handles the main page misses.
 *  2. Run several tabs in parallel. Each profile is an independent network
 *     wait, so concurrency multiplies throughput almost linearly.
 *
 * Facebook renders the Instagram row as a bare handle with only an icon to
 * identify the platform, and wraps the real URL in l.facebook.com/l.php?u=…
 * so the value must be read from the anchor href and URL-decoded.
 *
 * Resumable: appends one JSON object per line to mla_progress.jsonl and skips
 * handles already present, so it can be stopped and restarted freely.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/pranjul/workspace/governance_report";
const OUT_DIR =
  process.env.OUT_DIR ||
  "/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad";
const PROGRESS = path.join(OUT_DIR, "mla_progress.jsonl");
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const POLL_CAP_MS = Number(process.env.POLL_CAP_MS || 5000);
// Email lives only on the main profile, which costs a second page load and
// roughly doubles wall-clock. Socials (the actual goal) come from the fast
// contact subpage. Set WANT_EMAIL=1 to pay for emails too.
const WANT_EMAIL = process.env.WANT_EMAIL === "1";

const raw = fs.readFileSync(path.join(ROOT, ".fb_session_new"), "utf8").trim();
const cookies = raw
  .split(";")
  .map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: ".facebook.com", path: "/" };
  })
  .filter((c) => c.name);

// ── read the CSV ────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let cur = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

const csvText = fs.readFileSync(path.join(ROOT, "up_mla_403.csv"), "utf8").replace(/^﻿/, "");
const table = parseCsv(csvText).filter((r) => r.length > 1);
const IDX = Object.fromEntries(table[0].map((h, i) => [h.trim(), i]));

const targets = [];
for (const row of table.slice(1)) {
  const fb = (row[IDX.facebook_profile] || "").trim();
  if (!fb) continue;
  let handle = fb
    .replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, "")
    .replace(/^p\//, "")
    .replace(/\/+$/, "")
    .split("?")[0];
  // Drop trailing sections like /photos, /about, /videos — they break the
  // contact subpage URL and made these profiles look unavailable.
  handle = handle.replace(/\/(photos|about|videos|reels|posts|friends)(\/.*)?$/i, "");
  if (handle) targets.push({ ac_no: row[IDX.ac_no], name: row[IDX.mla_name], handle, fb });
}

const done = new Set();
if (fs.existsSync(PROGRESS)) {
  for (const line of fs.readFileSync(PROGRESS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).handle); } catch {}
  }
}
const todo = targets.filter((t) => !done.has(t.handle));
console.log(`total=${targets.length} done=${done.size} todo=${todo.length} concurrency=${CONCURRENCY}`);

// Runs inside the page. Returns the contact fields plus whether the panel has
// settled, so the poller knows when it can stop early.
const EXTRACT = () => {
  const unwrap = (href) => {
    let u = href;
    const m = /[?&]u=([^&]+)/.exec(u);
    if (m) { try { u = decodeURIComponent(m[1]); } catch {} }
    return u.split("?")[0].replace(/\/+$/, "");
  };
  let instagram = "", twitter = "", email = "", website = "";
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!email && /^mailto:/i.test(href)) { email = href.replace(/^mailto:/i, "").trim(); continue; }
    const u = unwrap(href);
    if (!instagram && /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u)) instagram = u;
    else if (!twitter && /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u)) twitter = u;
    else if (!website && /^https?:\/\//i.test(u) &&
      !/facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|messenger\.com|whatsapp\.com|meta\.com/i.test(u))
      website = u;
  }
  const body = (document.body?.innerText || "").replace(/ /g, " ");
  const phone = (body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/) || [])[1] || "";
  const notFound = /isn't available|content isn't available|page isn't available/i.test(body);
  const settled =
    !!(instagram || twitter || email || phone) ||
    /No contact info|Contact info/i.test(body) ||
    notFound;
  return { instagram, twitter, email, phone, website, notFound, settled };
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
await ctx.addCookies(cookies);
// Drop everything that doesn't affect the DOM we read.
await ctx.route("**/*", (route) => {
  const t = route.request().resourceType();
  if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return route.abort();
  route.continue();
});

const out = fs.createWriteStream(PROGRESS, { flags: "a" });
const stats = { ok: 0, ig: 0, tw: 0, em: 0, ph: 0, err: 0 };
let cursor = 0, blocked = false, completed = 0;
const t0 = Date.now();

async function worker(id) {
  const page = await ctx.newPage();
  while (!blocked) {
    const i = cursor++;
    if (i >= todo.length) break;
    const t = todo[i];
    const rec = { ...t, instagram: "", twitter: "", email: "", phone: "", website: "", status: "" };
    try {
      // Numeric IDs must use profile.php?id=…&sk=about_contact_and_basic_info;
      // the /<id>/about_… path form does not resolve for them.
      const contactUrl = /^\d+$/.test(t.handle)
        ? `https://www.facebook.com/profile.php?id=${t.handle}&sk=about_contact_and_basic_info`
        : `https://www.facebook.com/${t.handle}/about_contact_and_basic_info`;
      await page.goto(contactUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
      if (/\/login|\/checkpoint/i.test(page.url())) {
        rec.status = "AUTH";
        blocked = true;
        out.write(JSON.stringify(rec) + "\n");
        console.log(`!! SESSION BLOCKED at ${t.handle} — stopping all workers`);
        break;
      }
      let d = null;
      const deadline = Date.now() + POLL_CAP_MS;
      while (Date.now() < deadline) {
        d = await page.evaluate(EXTRACT).catch(() => null);
        if (d && d.settled) break;
        await page.waitForTimeout(200);
      }
      if (d) {
        Object.assign(rec, {
          instagram: d.instagram, twitter: d.twitter, email: d.email,
          phone: d.phone, website: d.website,
        });
        rec.status = d.notFound ? "GONE" : "OK";
      } else {
        rec.status = "ERR";
      }

      // The contact subpage renders socials/phone but omits the email row,
      // which only appears on the main profile. Fall back for that one field —
      // and only when it's missing, so most profiles still cost a single load.
      // "Unavailable" on the contact subpage is often just an unsupported URL
      // shape, not a dead profile — confirm against the main page before
      // recording an empty row.
      if (rec.status === "GONE" || (!rec.instagram && !rec.twitter && !rec.phone)) {
        try {
          const mainUrl = /^\d+$/.test(t.handle)
            ? `https://www.facebook.com/profile.php?id=${t.handle}`
            : `https://www.facebook.com/${t.handle}`;
          await page.goto(mainUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          const dl3 = Date.now() + 5000;
          while (Date.now() < dl3) {
            const d3 = await page.evaluate(EXTRACT).catch(() => null);
            if (d3) {
              if (!rec.instagram && d3.instagram) rec.instagram = d3.instagram;
              if (!rec.twitter && d3.twitter) rec.twitter = d3.twitter;
              if (!rec.phone && d3.phone) rec.phone = d3.phone;
              if (!rec.email && d3.email) rec.email = d3.email;
              if (!rec.website && d3.website) rec.website = d3.website;
              if (rec.instagram || rec.twitter) break;
              if (!d3.notFound && d3.settled) { rec.status = "OK"; break; }
            }
            await page.waitForTimeout(250);
          }
          if (rec.instagram || rec.twitter || rec.phone) rec.status = "OK";
        } catch { /* keep the original verdict */ }
      }

      if (WANT_EMAIL && rec.status === "OK" && !rec.email) {
        try {
          await page.goto(`https://www.facebook.com/${t.handle}`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          const dl2 = Date.now() + 4000;
          while (Date.now() < dl2) {
            const d2 = await page.evaluate(EXTRACT).catch(() => null);
            if (d2) {
              if (d2.email) { rec.email = d2.email; break; }
              if (!rec.instagram && d2.instagram) rec.instagram = d2.instagram;
              if (!rec.twitter && d2.twitter) rec.twitter = d2.twitter;
              if (!rec.phone && d2.phone) rec.phone = d2.phone;
            }
            await page.waitForTimeout(250);
          }
        } catch { /* keep what the contact page gave us */ }
      }
      if (rec.status === "OK") stats.ok++;
      if (rec.instagram) stats.ig++;
      if (rec.twitter) stats.tw++;
      if (rec.email) stats.em++;
      if (rec.phone) stats.ph++;
    } catch (e) {
      rec.status = "ERR";
      rec.error = String(e.message || e).slice(0, 100);
      stats.err++;
    }

    out.write(JSON.stringify(rec) + "\n");
    completed++;
    if (completed % 10 === 0 || completed === todo.length) {
      const rate = (Date.now() - t0) / 1000 / completed;
      const eta = ((todo.length - completed) * rate / 60).toFixed(1);
      console.log(
        `[${completed}/${todo.length}] ig=${stats.ig} tw=${stats.tw} @=${stats.em} ph=${stats.ph} ` +
        `err=${stats.err} | ${rate.toFixed(2)}s/profile eta=${eta}min`,
      );
    }
    await page.waitForTimeout(150);
  }
  await page.close().catch(() => {});
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
out.end();
await browser.close();
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\nDONE in ${mins}min  ok=${stats.ok} instagram=${stats.ig} twitter=${stats.tw} email=${stats.em} phone=${stats.ph} err=${stats.err}`);
