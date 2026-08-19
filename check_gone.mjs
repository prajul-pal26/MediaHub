import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const SP="/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad";
const recs=fs.readFileSync(SP+"/mla_progress.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
const gone=recs.filter(r=>r.status==="GONE").slice(0,8);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});
const p=await ctx.newPage();
for(const g of gone){
  await p.goto(`https://www.facebook.com/${g.handle}`,{waitUntil:"domcontentloaded",timeout:30000});
  await p.waitForTimeout(2500);
  const s=await p.evaluate(()=>{
    const t=(document.body?.innerText||"").slice(0,300);
    const as=Array.from(document.querySelectorAll("a[href]"));
    const ig=as.some(a=>{let u=a.href;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return /instagram\.com\//i.test(u);});
    return {title:document.title.slice(0,50), unavailable:/isn't available|content isn't available/i.test(t), ig, snippet:t.replace(/\n/g," ").slice(0,90)};
  });
  console.log(`${g.handle.slice(0,32).padEnd(32)} unavail=${s.unavailable?"Y":"N"} ig=${s.ig?"FOUND!":"-"} | ${s.title}`);
}
await b.close();
