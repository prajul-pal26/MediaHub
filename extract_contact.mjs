import { chromium } from "playwright-core";
import fs from "node:fs";
const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies = raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const h=process.argv[2];
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US"}); await ctx.addCookies(cookies);
const p=await ctx.newPage();
await p.goto(`https://www.facebook.com/${h}`,{waitUntil:"domcontentloaded",timeout:45000});
await p.waitForTimeout(6000);

const rows = await p.evaluate(() => {
  const out = [];
  // Each contact row: an icon (img/svg with a distinguishing mask/src) + a text value
  const heads = [...document.querySelectorAll("span,div,h2")].filter(e => /^(Contact info|Links)$/.test(e.innerText?.trim()));
  for (const head of heads) {
    let box = head; for (let i=0;i<6 && box.parentElement;i++) box = box.parentElement;
    for (const li of box.querySelectorAll("li, div[role='listitem']")) {
      const text = li.innerText?.trim();
      if (!text || text.length > 80) continue;
      const img = li.querySelector("img");
      out.push({
        section: head.innerText.trim(),
        text,
        icon: img?.src?.slice(0,110) || null,
        href: li.querySelector("a[href]")?.href || null,
      });
    }
  }
  return out;
});
const seen=new Set();
for (const r of rows) {
  const k=r.section+"|"+r.text; if(seen.has(k))continue; seen.add(k);
  console.log(`[${r.section}] ${JSON.stringify(r.text)}\n     href=${r.href}\n     icon=${r.icon}`);
}
await b.close();
