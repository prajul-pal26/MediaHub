// Isolated React integration fixture. All network calls stay on this local mock server.
// Run: node scripts/facebook/media-server-save-ui.test.cjs (CHROMIUM_PATH may override Chrome).
const http = require('node:http');
const assert = require('node:assert/strict');
const path = require('node:path').resolve(__dirname, '../..');
const esbuild = require(path + '/node_modules/esbuild');
const { chromium } = require(path + '/node_modules/playwright-core');
const { randomUUID } = require('node:crypto');

const media = {
  contentType: 'posts', handle: 'fixture', name: 'Fixture', url: 'https://www.facebook.com/fixture/',
  profilePic: null, followers: null, likes: null, category: null, about: null, verified: false,
  email: null, phone: null, website: null, instagram: null, twitter: null,
  retrieval: {capturedAt: '2026-09-06T00:00:00Z', fromCache: false, durationMs: 100, requested: 1, returned: 1, stopReason: 'limit'},
  posts: [{postId: '123', url: 'https://www.facebook.com/photo.php?fbid=123', text: '', likes: 0, comments: 0, shares: 0, metricsAvailable: false, mediaType: 'photo', images: []}],
};
const mock = `
import React,{useState,useCallback,useEffect,useRef} from 'react';
const media=${JSON.stringify(media)};
window.pollDecisions=[];
const call=async(path,input)=>{const response=await fetch('/fixture/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return response.json()};
function useMutation(name){const[isPending,setPending]=useState(false);const mutateAsync=useCallback(async input=>{setPending(true);try{if(name==='media')return{results:[{query:'fixture',ok:true,page:structuredClone(media)}]};return await call(name,input)}finally{setPending(false)}},[name]);return{isPending,mutateAsync}}
function useProgress(input,options){const[data,setData]=useState();const latest=useRef(options);latest.current=options;useEffect(()=>{if(!options.enabled)return;let active=true,timer;const poll=async()=>{const next=await call('progress',input);if(!active)return;setData(next);const delay=latest.current.refetchInterval({state:{data:next}});window.pollDecisions.push({status:next.status,sheetStatus:next.sheetSave?.status,delay});if(delay!==false)timer=setTimeout(poll,15)};void poll();return()=>{active=false;clearTimeout(timer)}},[input.jobId,options.enabled]);return{data,isError:false,refetch:async()=>{const next=await call('progress',input);setData(next);return next}}}
export const trpc={fbSession:{fbDemoFetch:{useMutation:()=>useMutation('media')},fetchFbPages:{useMutation:()=>useMutation('media')},startMediaComments:{useMutation:()=>useMutation('start')},cancelMediaComments:{useMutation:()=>useMutation('cancel')},saveMediaSheet:{useMutation:()=>useMutation('save')},exportDestinations:{useQuery:()=>({data:[{brandId:'fixture-brand',brandName:'Fixture brand',rootFolderUrl:'https://drive.google.com/drive/folders/test'}],isPending:false,isError:false})},mediaCommentsProgress:{useQuery:useProgress}}};
export const useUser=()=>({profile:{id:'fixture-user'}});export const cn=(...x)=>x.filter(Boolean).join(' ');export const SURFACE={card:'',kicker:''};
export const Reveal=({children,className})=><div className={className}>{children}</div>;export const BrandLogo=()=> <span>MediaHub</span>;
export const toast={error:message=>{window.lastToast=message}};export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>};
`;

(async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Page from '${path}/src/app/facebook/page.tsx';createRoot(document.getElementById('root')).render(<Page/>);`, resolveDir: path, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({filter: /^@\/|^next\/link$|^sonner$/}, args => args.path === '@/lib/fb-export' ? {path: path + '/src/lib/fb-export.ts'} : {path: 'fixture', namespace: 'fixture'});
      build.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: mock, loader: 'tsx', resolveDir: path}));
    }}],
  });
  const html = '<div id="root"></div><script>' + built.outputFiles[0].text + '</script>';
  const jobs = new Map();
  const starts = [];
  const clientSaves = [];
  const serverSaves = [];
  let failNextFinalSave = false;
  const savedResult = {url: 'https://docs.google.com/spreadsheets/d/persistent', folderUrl: 'https://drive.google.com/drive/folders/test', fileId: 'persistent', updatedAt: 'now'};
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/fixture/')) {res.setHeader('content-type', 'text/html');res.end(html);return;}
    let body = '';for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    let result;
    if (req.url === '/fixture/start') {
      starts.push(input);
      const jobId = randomUUID();
      const job = {status: 'running', total: 1, completed: 0, failed: 0, durationMs: 100, items: input.items.map(item => ({...item, status: 'running', comments: []}))};
      jobs.set(jobId, job);
      const shouldFail = failNextFinalSave;failNextFinalSave = false;
      // These timers are outside the browser; closing the page cannot cancel them.
      setTimeout(() => {
        job.status = 'completed';job.completed = 1;
        job.items[0] = {...job.items[0], status: 'complete', metadata: {text: 'Server caption'}};
        job.sheetSave = {status: 'saving'};
        setTimeout(() => {
          if (shouldFail) job.sheetSave = {status: 'failed', error: 'Fixture server save failed'};
          else {serverSaves.push(input.sheetExport);job.sheetSave = {status: 'saved', result: savedResult};}
        }, 140);
      }, 50);
      result = {jobId};
    } else if (req.url === '/fixture/progress') result = jobs.get(input.jobId);
    else if (req.url === '/fixture/save') {clientSaves.push(input);result = savedResult;}
    else result = {ok: true};
    res.setHeader('content-type', 'application/json');res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const errors = [];
  const fresh = async () => {const page = await browser.newPage();page.on('pageerror', error => errors.push(error.message));await page.goto('http://127.0.0.1:' + server.address().port);return page;};
  const waitFor = async (predicate) => {for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Fixture condition timed out');};
  try {
    let page = await fresh();
    await page.getByRole('button', {name: 'Fetch Photos', exact: true}).click();
    await page.getByText('Google Sheet updated with retrieved details.', {exact: true}).waitFor();
    assert.equal(clientSaves.length, 1);assert.equal(serverSaves.length, 1);
    assert.equal(starts[0].sheetExport.runId, clientSaves[0].runId);
    assert.equal(starts[0].sheetExport.brandId, clientSaves[0].brandId);
    assert.deepEqual(starts[0].sheetExport.pages, clientSaves[0].pages);
    const decisions = await page.evaluate(() => window.pollDecisions);
    assert(decisions.some(value => value.status === 'completed' && value.sheetStatus === 'saving' && value.delay === 1000));
    assert(decisions.some(value => value.sheetStatus === 'saved' && value.delay === false));
    assert.equal(await page.getByRole('link', {name: 'Open Google Sheet', exact: true}).getAttribute('href'), savedResult.url);
    await page.close();

    // A failed server save is retried only on explicit click, using the same run and final caption.
    failNextFinalSave = true;page = await fresh();
    await page.getByRole('button', {name: 'Fetch Photos', exact: true}).click();
    await page.getByRole('button', {name: 'Retry save', exact: true}).waitFor();
    assert.equal(clientSaves.length, 2);
    await page.getByRole('button', {name: 'Retry save', exact: true}).click();
    await page.getByText('Google Sheet updated with retrieved details.', {exact: true}).waitFor();
    assert.equal(clientSaves.length, 3);
    assert.equal(clientSaves[1].runId, clientSaves[2].runId);
    assert.equal(clientSaves[2].pages[0].posts[0].text, 'Server caption');
    await page.close();

    // Once start is acknowledged, finalization survives closing and reloading the UI.
    page = await fresh();await page.getByRole('button', {name: 'Fetch Photos', exact: true}).click();
    await waitFor(() => starts.length === 3);await page.close();
    const finalRun = starts[2].sheetExport.runId;
    await waitFor(() => serverSaves.some(value => value.runId === finalRun));
    const writesBeforeReload = clientSaves.length;page = await fresh();await page.waitForTimeout(80);
    assert.equal(clientSaves.length, writesBeforeReload);
    await page.close();assert.deepEqual(errors, []);
    console.log('PASS: server context matches initial save; terminal server write is not duplicated; terminal saving keeps polling; server failure retries same UUID/final data; mock server finalizes after page closes and reload creates no extra writes. No Facebook/Google calls.');
  } finally {await browser.close();server.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
