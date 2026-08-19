import { chromium } from "playwright-core";
import fs from "node:fs";
const raw=fs.readFileSync("/Users/pranjul/workspace/governance_report/.fb_session_new","utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);

const EXTRACT=()=>{
  const unwrap=(h)=>{let u=h;const m=/[?&]u=([^&]+)/.exec(u);if(m){try{u=decodeURIComponent(m[1]);}catch{}}return u.split("?")[0].replace(/\/+$/,"");};
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
  // Has the contact panel finished rendering? "Contact info"/"No contact info"
  // heading plus at least one row, OR an explicit social anchor.
  const panelDone = !!instagram||!!twitter||!!email||!!phone||/No contact info/i.test(body);
  return {instagram,twitter,email,phone,website,panelDone};
};

// KEY TEST: does the /about_contact_and_basic_info page render the panel FIRST
// (no post feed to wait behind)? That would remove the 7s dead wait entirely.
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});
const p=await ctx.newPage();

// two known-empty and two known-full
for(const h of ["gulabdeviup","mlamukeshchoudhary","imashumalik","KiratSinghBJP"]){
  for(const path of ["", "/about_contact_and_basic_info"]){
    const t0=Date.now();
    await p.goto(`https://www.facebook.com/${h}${path}`,{waitUntil:"domcontentloaded",timeout:30000});
    let d=null;
    const dl=Date.now()+7000;
    while(Date.now()<dl){
      d=await p.evaluate(EXTRACT).catch(()=>null);
      if(d&&d.panelDone) break;
      await p.waitForTimeout(200);
    }
    console.log(`${(path||"/main").padEnd(32)} ${h.slice(0,20).padEnd(20)} ${String(Date.now()-t0).padStart(5)}ms done=${d?.panelDone?"Y":"N"} ig=${d?.instagram?"Y":"-"} tw=${d?.twitter?"Y":"-"} @=${d?.email?"Y":"-"}`);
  }
}
await b.close();
