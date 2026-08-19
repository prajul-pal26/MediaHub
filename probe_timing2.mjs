import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1366,height:1200}});
await ctx.addCookies(cookies);
const p=await ctx.newPage();
await p.route("**/*",r=>{const t=r.request().resourceType();if(t==="image"||t==="media"||t==="font")return r.abort();r.continue();});
const h=process.argv[2]||"gulabdeviup";
const t0=Date.now();
await p.goto(`https://www.facebook.com/${h}`,{waitUntil:"domcontentloaded",timeout:40000});
// poll every 250ms and report when the instagram anchor first appears
for(let i=0;i<40;i++){
  const s=await p.evaluate(()=>{
    const as=Array.from(document.querySelectorAll("a[href]"));
    const ig=as.find(a=>{let u=a.href;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return /instagram\.com\//i.test(u);});
    const t=document.body?.innerText||"";
    return {n:as.length, ig:!!ig, contact:/Contact info/i.test(t), lphp:as.filter(a=>/l\.php\?u=/.test(a.href)).length};
  });
  console.log(`+${String(Date.now()-t0).padStart(5)}ms anchors=${String(s.n).padStart(4)} l.php=${String(s.lphp).padStart(3)} contactText=${s.contact?"Y":"-"} INSTAGRAM=${s.ig?"YES":"-"}`);
  if(s.ig) break;
  await p.waitForTimeout(250);
}
await b.close();
