/**
 * Re-fetch phone numbers, anchored to the "Mobile"/"Phone" label in the
 * Contact-info block. The previous free-form regex matched any digit run on the
 * page (Reels view counts, follower tallies), producing wrong or invented
 * numbers even for profiles showing "No contact info to show".
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ROOT="/Users/pranjul/workspace/governance_report";
const SP="/private/tmp/claude-501/-Users-pranjul-workspace-governance-report/e8f4701f-af0c-4680-8c5d-ed8db78da1f6/scratchpad";
const OUT=path.join(SP,"phones.jsonl");
const CONCURRENCY=Number(process.env.CONCURRENCY||5);

const raw=fs.readFileSync(path.join(ROOT,".fb_session_new"),"utf8").trim();
const cookies=raw.split(";").map(p=>{const i=p.indexOf("=");return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:".facebook.com",path:"/"};}).filter(c=>c.name);

// only profiles that currently claim a phone
const recs=fs.readFileSync(path.join(SP,"mla_progress.jsonl"),"utf8").split("\n").filter(Boolean).map(JSON.parse);
const targets=recs.filter(r=>r.phone);
const done=new Set();
if(fs.existsSync(OUT)) for(const l of fs.readFileSync(OUT,"utf8").split("\n")) if(l.trim()) try{done.add(JSON.parse(l).handle);}catch{}
const todo=targets.filter(t=>!done.has(t.handle));
console.log(`phones to re-verify: ${todo.length} (of ${targets.length})`);

const EXTRACT=()=>{
  const body=(document.body?.innerText||"").replace(/ /g," ");
  const lines=body.split("\n").map(s=>s.trim());
  // Facebook renders: <number> \n Mobile   (label follows the value)
  let phone="";
  for(let i=0;i<lines.length;i++){
    if(/^(Mobile|Phone|Mobile phone|Phone number)$/i.test(lines[i])){
      const prev=lines[i-1]||"";
      if(/^\+?[\d][\d\s\-()]{7,17}$/.test(prev)){ phone=prev; break; }
    }
  }
  const noContact=/No contact info to show/i.test(body);
  const hasContactHeading=/Contact info/i.test(body);
  return {phone,noContact,settled:hasContactHeading||noContact};
};

const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const ctx=await b.newContext({locale:"en-US",viewport:{width:1280,height:900}});
await ctx.addCookies(cookies);
await ctx.route("**/*",r=>{const t=r.request().resourceType();if(["image","media","font","stylesheet"].includes(t))return r.abort();r.continue();});

const out=fs.createWriteStream(OUT,{flags:"a"});
let cursor=0,kept=0,cleared=0,changed=0,n=0;

async function worker(){
  const p=await ctx.newPage();
  while(true){
    const i=cursor++; if(i>=todo.length) break;
    const t=todo[i];
    const rec={handle:t.handle,ac_no:t.ac_no,old:t.phone,phone:"",status:"OK"};
    try{
      const url=/^\d+$/.test(t.handle)
        ? `https://www.facebook.com/profile.php?id=${t.handle}&sk=about_contact_and_basic_info`
        : `https://www.facebook.com/${t.handle}/about_contact_and_basic_info`;
      await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
      let d=null; const dl=Date.now()+5000;
      while(Date.now()<dl){ d=await p.evaluate(EXTRACT).catch(()=>null); if(d&&d.settled) break; await p.waitForTimeout(200); }
      if(d) rec.phone=d.phone||"";
    }catch(e){ rec.status="ERR"; }
    if(rec.phone && rec.phone.replace(/\D/g,"")===rec.old.replace(/\D/g,"")) kept++;
    else if(rec.phone) changed++;
    else cleared++;
    out.write(JSON.stringify(rec)+"\n");
    if(++n%20===0) console.log(`  ${n}/${todo.length} kept=${kept} changed=${changed} cleared=${cleared}`);
    await p.waitForTimeout(120);
  }
  await p.close().catch(()=>{});
}
await Promise.all(Array.from({length:CONCURRENCY},()=>worker()));
out.end(); await b.close();
console.log(`\nDONE kept=${kept} changed=${changed} cleared=${cleared}`);
