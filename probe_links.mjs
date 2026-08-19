import { chromium } from "playwright-core";
import fs from "node:fs";

const CHROMIUM = process.env.CHROMIUM_PATH;
const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session", "utf8").trim();
const cookies = raw.split(";").map((p) => {
  const i = p.indexOf("=");
  return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: ".facebook.com", path: "/" };
}).filter((c) => c.name);

const handle = process.argv[2] || "gulabdeviup";
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const ctx = await browser.newContext({ locale: "en-US" });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

// Capture links from every network response too — FB loads About via XHR
const netHits = new Set();
page.on("response", async (res) => {
  const u = res.url();
  if (!/graphql|profile_tilecs|about/i.test(u)) return;
  try {
    const body = await res.text();
    for (const m of body.matchAll(/(?:https?:\\?\/\\?\/)?(?:www\.)?(instagram\.com\\?\/[A-Za-z0-9_.]{2,30}|(?:twitter|x)\.com\\?\/[A-Za-z0-9_]{2,30})/gi)) {
      netHits.add(m[1].replace(/\\/g, ""));
    }
  } catch {}
});

// The dedicated links tab
for (const path of [`/${handle}/about_contact_and_basic_info`, `/${handle}/about`]) {
  try {
    await page.goto(`https://www.facebook.com${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);
  } catch (e) { console.log("nav fail", path, e.message); }
}

const domHits = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    let h = a.href;
    const m = /[?&]u=([^&]+)/.exec(h);
    if (m) { try { h = decodeURIComponent(m[1]); } catch {} }
    if (/instagram\.com|twitter\.com|x\.com/i.test(h)) out.add(h.split("?")[0]);
  }
  const t = document.body.innerText;
  for (const m of t.matchAll(/(?:instagram\.com\/|twitter\.com\/|x\.com\/)[A-Za-z0-9_.]{2,30}/gi)) out.add(m[0]);
  return [...out];
});

console.log("HANDLE:", handle);
console.log("DOM   :", domHits.length ? domHits : "(none)");
console.log("NET   :", netHits.size ? [...netHits] : "(none)");
await browser.close();
