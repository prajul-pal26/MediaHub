import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1366,height:1200}});
await ctx.addCookies(cookies);
const p=await ctx.newPage();
await p.route("**/*",r=>{const t=r.request().resourceType();if(t==="image"||t==="media"||t==="font")return r.abort();r.continue();});
for (const h of ["gulabdeviup","vinayprakashofficial"]) {
  const t0=Date.now();
  await p.goto(`https://www.facebook.com/${h}`,{waitUntil:"domcontentloaded",timeout:40000});
  const tNav=Date.now();
  // how long until the contact anchors actually appear?
  let tAnchor=null;
  try{
    await p.waitForFunction(()=>Array.from(document.querySelectorAll("a[href]")).some(a=>/l\.php\?u=|mailto:/i.test(a.href)),{timeout:15000});
    tAnchor=Date.now();
  }catch{ tAnchor=Date.now(); }
  console.log(`${h}: nav=${tNav-t0}ms  anchors_ready=+${tAnchor-tNav}ms  total=${tAnchor-t0}ms`);
}
await b.close();
