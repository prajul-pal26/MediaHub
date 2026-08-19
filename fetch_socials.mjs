import { chromium } from "playwright-core";
import fs from "node:fs";

const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies = raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);

/** Unwrap l.facebook.com/l.php?u=<encoded> and strip FB tracking params. */
function unwrap(href) {
  if (!href) return null;
  let u = href;
  const m = /[?&]u=([^&]+)/.exec(u);
  if (m) { try { u = decodeURIComponent(m[1]); } catch {} }
  return u.split("?")[0].replace(/\/$/, "");
}

export async function fetchSocials(handle, page) {
  await page.goto(`https://www.facebook.com/${handle}`, {waitUntil:"domcontentloaded", timeout:45000});
  await page.waitForTimeout(5500);
  // Contact rows hydrate late; wait for the Contact-info anchors to appear.
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("a[href]")].some(a => /l\\.php\\?u=|instagram\\.com/i.test(a.href)),
      { timeout: 15000 },
    );
  } catch {}
  await page.waitForTimeout(2500);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map(a => a.href)
  );
  const text = await page.evaluate(() => document.body.innerText);

  const out = { handle, instagram:"", twitter:"", email:"", phone:"", website:"" };
  for (const h of hrefs) {
    const u = unwrap(h);
    if (!u) continue;
    if (!out.instagram && /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u)) out.instagram = u;
    if (!out.twitter && /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u)) out.twitter = u;
    if (!out.email && /^mailto:/i.test(h)) out.email = h.replace(/^mailto:/i,"");
    if (!out.website && /wikipedia\.org|\.gov\.in|\.in\/|\.com\//i.test(u) && !/facebook|instagram|twitter|x\.com/i.test(u)) out.website = u;
  }
  const ph = /(?:^|\n)\s*(\+?\d[\d\s\-]{8,15}\d)\s*(?:\n|$)/.exec(text);
  if (ph) out.phone = ph[1].trim();
  return out;
}

if (process.argv[2]) {
  const b = await chromium.launch({executablePath:process.env.CHROMIUM_PATH, headless:true});
  const ctx = await b.newContext({locale:"en-US"}); await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  for (const h of process.argv.slice(2)) console.log(JSON.stringify(await fetchSocials(h,p), null, 2));
  await b.close();
}
