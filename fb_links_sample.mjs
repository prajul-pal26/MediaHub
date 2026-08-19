import { chromium } from "playwright-core";
import fs from "node:fs";

const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session", "utf8").trim();
const cookies = raw.split(";").map((p) => {
  const i = p.indexOf("=");
  return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: ".facebook.com", path: "/" };
}).filter((c) => c.name);

const handles = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const ctx = await browser.newContext({ locale: "en-US" });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

const results = [];
for (const h of handles) {
  const rec = { handle: h, ok: false, links: [], instagram: "", twitter: "" };
  try {
    await page.goto(`https://www.facebook.com/${h}/about`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('a,div[role="tab"],span,div[role="button"]')]
        .find((e) => e.innerText && e.innerText.trim() === "Links");
      if (t) t.click();
    });
    await page.waitForTimeout(3000);

    const text = await page.evaluate(() => document.body.innerText);
    rec.ok = !/Log in to Facebook|content isn't available/i.test(text);

    const i = text.indexOf("Links");
    const chunk = i >= 0 ? text.slice(i, i + 600) : text;
    const urls = new Set();
    for (const m of chunk.matchAll(/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[^\s\n]{1,60}/g)) urls.add(m[0]);
    rec.links = [...urls].slice(0, 8);
    rec.instagram = rec.links.find((u) => /instagram\.com\//i.test(u)) || "";
    rec.twitter = rec.links.find((u) => /(twitter|x)\.com\//i.test(u)) || "";
  } catch (e) {
    rec.error = e.message.slice(0, 80);
  }
  results.push(rec);
  console.log(
    `${rec.ok ? "OK " : "!! "} ${h.padEnd(32)} ig=${rec.instagram ? "Y" : "-"} tw=${rec.twitter ? "Y" : "-"}  ${rec.links.join(" | ").slice(0, 90)}`,
  );
  await page.waitForTimeout(1200);
}

const ig = results.filter((r) => r.instagram).length;
const tw = results.filter((r) => r.twitter).length;
const anyLink = results.filter((r) => r.links.length).length;
console.log(`\nSUMMARY  profiles=${results.length}  loaded_ok=${results.filter((r) => r.ok).length}  any_link=${anyLink}  instagram=${ig}  twitter=${tw}`);
fs.writeFileSync("/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad/sample.json", JSON.stringify(results, null, 2));
await browser.close();
