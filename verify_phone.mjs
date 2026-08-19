import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});
const p=await ctx.newPage();
for(const h of ["vinayprakashofficial","shuchismitamaurya.upmla","gulabdeviup"]){
  await p.goto(`https://www.facebook.com/${h}/about_contact_and_basic_info`,{waitUntil:"domcontentloaded",timeout:30000});
  await p.waitForTimeout(3000);
  const d=await p.evaluate(()=>{
    const body=(document.body?.innerText||"").replace(/ /g," ");
    // What does a real tel: link say, vs what the regex grabbed?
    const tel=[...document.querySelectorAll('a[href^="tel:"]')].map(a=>a.href.replace("tel:",""));
    const m=(body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/)||[])[1]||"";
    const i=body.indexOf("Contact info");
    return {tel, regexGrabbed:m, contactBlock: i>=0? body.slice(i,i+220).replace(/\n/g," | "):"(no Contact info)"};
  });
  console.log(`\n=== ${h} ===`);
  console.log("  tel: links   :", d.tel.length?d.tel:"(none)");
  console.log("  regex grabbed:", JSON.stringify(d.regexGrabbed));
  console.log("  contact block:", d.contactBlock.slice(0,180));
}
await b.close();
