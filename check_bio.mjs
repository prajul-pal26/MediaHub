import { chromium } from "playwright-core";
import fs from "node:fs";
const raw = fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies = raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const h=process.argv[2];
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US"}); await ctx.addCookies(cookies);
const p=await ctx.newPage();
const hits=new Set();
p.on("response",async r=>{ if(!/graphql/i.test(r.url()))return;
  try{const t=await r.text();
    for(const m of t.matchAll(/instagram\.com\\?\/[A-Za-z0-9_.]{2,30}/gi)) hits.add("IG "+m[0].replace(/\\/g,""));
    for(const m of t.matchAll(/(?:twitter|x)\.com\\?\/[A-Za-z0-9_]{2,30}/gi)) hits.add("TW "+m[0].replace(/\\/g,""));
  }catch{}});
for(const path of [`/${h}/about_profile_transparency`,`/${h}/about_contact_and_basic_info`,`/${h}`]){
  try{ await p.goto("https://www.facebook.com"+path,{waitUntil:"domcontentloaded",timeout:45000}); await p.waitForTimeout(4500);}catch(e){}
}
const t=await p.evaluate(()=>document.body.innerText);
console.log("=== INTRO / BIO (first 500 of about section) ===");
const i=t.indexOf("Intro");
console.log(t.slice(i>=0?i:0,(i>=0?i:0)+500));
console.log("\n=== any ig/x anywhere in visible text ===");
console.log([...new Set([...t.matchAll(/instagram\.com\/[A-Za-z0-9_.]{2,30}|(?:twitter|x)\.com\/[A-Za-z0-9_]{2,30}|@[A-Za-z0-9_.]{4,30}/gi)].map(m=>m[0]))].slice(0,15));
console.log("\n=== from graphql network payloads ===");
console.log(hits.size?[...hits]:"(none)");
await b.close();
