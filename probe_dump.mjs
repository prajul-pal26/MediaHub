import { chromium } from "playwright-core";
import fs from "node:fs";

const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new", "utf8").trim();
const cookies = raw.split(";").map((p) => {
  const i = p.indexOf("=");
  return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: ".facebook.com", path: "/" };
}).filter((c) => c.name);

const handle = process.argv[2] || "gulabdeviup";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const ctx = await browser.newContext({ locale: "en-US" });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

await page.goto(`https://www.facebook.com/${handle}/about`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);

// Click the "Links" tab in the left nav of the About pane
const clicked = await page.evaluate(() => {
  const els = [...document.querySelectorAll('a,div[role="tab"],span,div[role="button"]')];
  const t = els.find((e) => e.innerText && e.innerText.trim() === "Links");
  if (t) { t.click(); return true; }
  return false;
});
console.log("clicked Links tab:", clicked);
await page.waitForTimeout(4000);

console.log("URL:", page.url());
const text = await page.evaluate(() => document.body.innerText);
const i = text.indexOf("Links");
console.log("\n--- text around 'Links' ---\n", text.slice(Math.max(0, i - 200), i + 800));

const anchors = await page.evaluate(() =>
  [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => !/facebook\.com|fbcdn/.test(h)),
);
console.log("\n--- non-FB anchors ---\n", [...new Set(anchors)].slice(0, 25));
await browser.close();
