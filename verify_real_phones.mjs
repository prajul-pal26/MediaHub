import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});
const p=await ctx.newPage();
// handles whose CSV phone looked VALID — confirm the page really shows Mobile
for(const [h,csvPhone] of [["KiratSinghBJP","087659 54729"],["rajeevgumber01","099973 43343"],["BrijeshSingh.Official","097600 23881"]]){
  await p.goto(`https://www.facebook.com/${h}/about_contact_and_basic_info`,{waitUntil:"domcontentloaded",timeout:30000});
  await p.waitForTimeout(3000);
  const d=await p.evaluate(()=>{
    const body=(document.body?.innerText||"").replace(/ /g," ");
    const i=body.indexOf("Contact info");
    return {block: i>=0? body.slice(i,i+200).replace(/\n/g," | "):"(none)"};
  });
  console.log(`${h.slice(0,26).padEnd(26)} csv=${csvPhone}`);
  console.log(`   page: ${d.block.slice(0,150)}`);
}
await b.close();
