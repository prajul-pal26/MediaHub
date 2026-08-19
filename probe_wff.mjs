import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1366,height:1200}});
await ctx.addCookies(cookies);
const p=await ctx.newPage();
await p.route("**/*",r=>{const t=r.request().resourceType();if(t==="image"||t==="media"||t==="font")return r.abort();r.continue();});
const h="gulabdeviup";
for (const scroll of [false,true]) {
  const t0=Date.now();
  await p.goto(`https://www.facebook.com/${h}`,{waitUntil:"domcontentloaded",timeout:40000});
  if(scroll){ await p.evaluate(()=>window.scrollTo(0,900)); }
  let found=false;
  try{
    await p.waitForFunction(()=>Array.from(document.querySelectorAll("a[href]")).some(a=>{
      let u=a.href;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}
      return /instagram\.com\//i.test(u);}),{timeout:12000,polling:200});
    found=true;
  }catch{}
  const after=await p.evaluate(()=>{const as=Array.from(document.querySelectorAll("a[href]"));
    const ig=as.find(a=>{let u=a.href;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return /instagram\.com\//i.test(u);});
    return {url:location.href, anchors:as.length, ig: ig? "PRESENT":"absent"};});
  console.log(`scroll=${scroll?"YES":"no "} wff=${found?"YES":"NO "} in ${Date.now()-t0}ms | url=${after.url.slice(0,60)} anchors=${after.anchors} instagram=${after.ig}`);
}
await b.close();
