import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const extract=()=>{
  const unwrap=(href)=>{let u=href;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return u.split("?")[0].replace(/\/+$/,"");};
  let instagram="",twitter="",email="",website="";
  for(const a of document.querySelectorAll("a[href]")){
    const href=a.href;
    if(!email&&/^mailto:/i.test(href)){email=href.replace(/^mailto:/i,"").trim();continue;}
    const u=unwrap(href);
    if(!instagram&&/^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u))instagram=u;
    else if(!twitter&&/^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u))twitter=u;
    else if(!website&&/^https?:\/\//i.test(u)&&!/facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|messenger\.com|whatsapp\.com|meta\.com/i.test(u))website=u;
  }
  const body=(document.body?.innerText||"").replace(/ /g," ");
  const phone=(body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/)||[])[1]||"";
  return {instagram,twitter,email,phone,website};
};
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1366,height:1200}});
await ctx.addCookies(cookies);
const p=await ctx.newPage();
await p.route("**/*",r=>{const t=r.request().resourceType();if(t==="image"||t==="media"||t==="font")return r.abort();r.continue();});
// Handles with KNOWN values, so a regression is visible
for(const h of ["gulabdeviup","vinayprakashofficial","KiratSinghBJP","mladevendernim","officeumaralikhan"]){
  const t0=Date.now();
  await p.goto(`https://www.facebook.com/${h}`,{waitUntil:"domcontentloaded",timeout:40000});
  // The contact panel renders LAST (~3s, after the post feed). Poll with
  // evaluate() until a real social/mailto/tel anchor exists — waitForFunction
  // proved unreliable here (it resolves against a frame that re-renders), and
  // any text signal like "Contact info" is in the chrome before rows populate.
  // Profiles that genuinely list nothing just run to the cap.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const ready = await p.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).some((a) => {
        let u = a.href; const m = /[?&]u=([^&]+)/.exec(u);
        if (m) { try { u = decodeURIComponent(m[1]); } catch {} }
        return /^https?:\/\/(www\.)?(instagram\.com|twitter\.com|x\.com)\//i.test(u) || /^mailto:|^tel:/i.test(a.href);
      }),
    ).catch(() => false);
    if (ready) break;
    await p.waitForTimeout(250);
  }
  const d=await p.evaluate(extract);
  console.log(`${(Date.now()-t0+"ms").padEnd(7)} ${h.slice(0,30).padEnd(30)} ig=${d.instagram?"Y":"-"} tw=${d.twitter?"Y":"-"} @=${d.email?"Y":"-"} ph=${d.phone?"Y":"-"}`);
}
await b.close();
