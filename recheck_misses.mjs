import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);
const SP="/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad";
const recs=fs.readFileSync(SP+"/mla_progress.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
const misses=recs.filter(r=>!(r.instagram||r.twitter||r.email||r.phone)).slice(0,12);
const EXTRACT=()=>{
  const unwrap=(h)=>{let u=h;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return u.split("?")[0].replace(/\/+$/,"");};
  let instagram="",twitter="",email="";
  for(const a of document.querySelectorAll("a[href]")){
    const href=a.href;
    if(!email&&/^mailto:/i.test(href)){email=href.replace(/^mailto:/i,"").trim();continue;}
    const u=unwrap(href);
    if(!instagram&&/^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+$/i.test(u))instagram=u;
    else if(!twitter&&/^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+$/i.test(u))twitter=u;
  }
  const body=(document.body?.innerText||"").replace(/ /g," ");
  const phone=(body.match(/(?:^|\n)\s*(\+?\d[\d\s-]{8,15}\d)\s*(?:\n|$)/)||[])[1]||"";
  return {instagram,twitter,email,phone,done:!!(instagram||twitter||email||phone)||/No contact info/i.test(body)};
};
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});
const p=await ctx.newPage();
let recovered=0;
for(const m of misses){
  await p.goto(`https://www.facebook.com/${m.handle}/about_contact_and_basic_info`,{waitUntil:"domcontentloaded",timeout:30000});
  let d=null; const dl=Date.now()+6000;
  while(Date.now()<dl){ d=await p.evaluate(EXTRACT).catch(()=>null); if(d&&d.done)break; await p.waitForTimeout(200);}
  const got=d&&(d.instagram||d.twitter||d.email||d.phone);
  if(got)recovered++;
  console.log(`${m.handle.slice(0,30).padEnd(30)} ${got?"RECOVERED":"really empty"} ig=${d?.instagram?"Y":"-"} tw=${d?.twitter?"Y":"-"} @=${d?.email?"Y":"-"} ph=${d?.phone?"Y":"-"}`);
}
console.log(`\nrecovered ${recovered}/${misses.length} previously-"empty" profiles`);
await b.close();
