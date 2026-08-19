import { chromium } from "playwright-core";
import fs from "node:fs";

const CHROMIUM = process.env.CHROMIUM_PATH ||
  "/Users/pranjul/Library/Caches/ms-playwright/chromium-1228/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
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

const url = `https://www.facebook.com/${handle}/about`;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);

console.log("URL   :", page.url());
console.log("TITLE :", await page.title());

// Anchors, including l.php redirect wrappers
const links = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    let h = a.href;
    const m = /l\.(?:facebook|php)[^?]*\?u=([^&]+)/.exec(h) || /\/l\.php\?u=([^&]+)/.exec(h);
    if (m) { try { h = decodeURIComponent(m[1]); } catch {} }
    if (/instagram\.com|twitter\.com|x\.com/i.test(h)) out.add(h.split("?")[0]);
  }
  return [...out];
});
console.log("LINKS :", links.length ? links : "(none in anchors)");

// Visible text fallback — handles are often rendered as plain text
const text = await page.evaluate(() => document.body.innerText);
const textHits = [...text.matchAll(/(?:instagram\.com\/|twitter\.com\/|x\.com\/|(?<=\s)@)([A-Za-z0-9_.]{3,30})/gi)].map((m) => m[0]);
console.log("TEXT  :", [...new Set(textHits)].slice(0, 12));

fs.writeFileSync("/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad/about.txt", text);
console.log("\n--- first 700 chars of About text ---\n", text.slice(0, 700));

await browser.close();
