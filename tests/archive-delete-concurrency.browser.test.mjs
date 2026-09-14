import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

// Component test: real ArchiveDashboard and dialogs, delayed fixture API responses.
const root = process.cwd();
const artifacts = process.env.TESSERA_TEST_ARTIFACT_DIR ?? path.join(root, 'tmp', 'archive-delete-browser');
await fs.mkdir(artifacts, { recursive: true });
const stub = `
import {en} from '${root}/src/lib/i18n/en.ts';
export const t = (key, params) => { const text = key.split('.').reduce((v,k) => v?.[k], en) ?? key; return Object.entries(params ?? {}).reduce((s,[k,v]) => s.replaceAll('{{'+k+'}}',String(v)),text); };
export const useI18n = () => ({t});
export const useSessionClickHandlers = () => ({handleSessionClick: async () => {}});
export const useSessionStore = {getState: () => ({loadProjects: async () => { window.archiveProjectRefreshes = (window.archiveProjectRefreshes ?? 0) + 1; }, upsertSession() {}})};
export const useWorktreeRetentionSettingsUpdate = () => ({settings:{archivedWorktreeRetentionDays:3},updateSettings(){},setRetentionDaysDraft(){},commitRetentionDays(){},retentionDaysInputValue:'3'});
export const projectViewWorkspaceState = {};
export const refreshProjectViewWorkspaceMutation = async () => {};
export const captureTelemetryUiControl = () => {};
export const telemetryClickAttributes = (control) => ({'data-control':control});
`;
const mocks = new Set(['@/lib/i18n','@/hooks/use-session-click-handlers','@/stores/session-store','@/hooks/use-worktree-retention-settings-update','@/lib/projects/project-view-workspace-state-client','@/lib/telemetry/client','@/lib/telemetry/ui-click']);
const output = await build({
  stdin: {contents: `import React from 'react'; import {useAuthStore} from './src/stores/auth-store'; useAuthStore.setState({user:{id:'fixture',username:'fixture'},isAuthenticated:true}); import {createRoot} from 'react-dom/client'; import {ArchiveDashboard} from './src/components/archive/archive-dashboard'; createRoot(document.getElementById('root')).render(<ArchiveDashboard/>);`, resolveDir: root, loader:'tsx'},
  bundle:true, write:false, format:'iife', jsx:'automatic', define:{'process.env.NODE_ENV':'"development"'},
  plugins:[{name:'fixture-dependencies',setup(b){b.onResolve({filter:/^@\//},a=>mocks.has(a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:stub,loader:'js',resolveDir:root}));}}],
});
const css = await postcss([tailwind()]).process(await fs.readFile('src/app/globals.css','utf8'), {from:path.join(root,'src/app/globals.css')});
const server = http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/app.js'?output.outputFiles[0].text:req.url==='/style.css'?css.css:'<html class="dark"><head><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const rows=Array.from({length:105},(_,i)=>({id:'task-'+i,kind:'task',title:'Archived task '+i,projectId:'project',projectName:'Project',archivedAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',createdAt:'2020-01-01T00:00:00Z',worktreeId:'wt_'+i,workDir:'/fixture/'+i,worktreeStatus:'present',worktreeManaged:true,canRestore:true,sharedWorktree:false,affectedProjectIds:['project'],sessions:[]}));
 rows[6].worktreeId='wt_2';
 const chats=[0,1].map(i=>({...rows[0],kind:'chat',id:'chat-'+i,title:'Archived chat '+i,worktreeId:undefined,workDir:undefined,worktreeStatus:'none',canRestore:true}));
 let holdArchive=false;
 const heldArchive=[];
 let requests=0;
 const pending=new Map();
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(req.method()==='DELETE'){pending.set(url.pathname,route);return;}
  if(url.pathname==='/api/archive/retention'){await route.fulfill({json:{progress:{phase:'idle',total:0,completed:0,removed:0,skipped:0,errors:[],currentTitle:null,startedAt:null,finishedAt:null}}});return;}
  if(url.pathname==='/api/archive'){
   requests++;
   const offset=Number(url.searchParams.get('cursor')||0),items=url.searchParams.get('kind')==='task'?rows:chats;
   const payload={json:{items:items.slice(offset,offset+100),projects:[],summary:{total:rows.length,tasks:rows.length,chats:0,worktreesPresent:rows.length,worktreesDeleted:0,worktreesMissing:0},pagination:{kind:url.searchParams.get('kind'),total:items.length,nextCursor:offset+100<items.length?String(offset+100):null}}};
   if(holdArchive){heldArchive.push({route,payload:JSON.parse(JSON.stringify(payload))});return;}
   await route.fulfill(payload);return;
  }
  await route.fulfill({json:{}});
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 const row=id=>page.getByTestId('archive-task-row-task-'+id);
 await row(0).waitFor();
 const shot=name=>page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});
 await shot('01-initial');
 async function start(id,folder=false){
  await row(id).locator('[data-control="archive.item.'+(folder?'delete_worktree':'delete')+'"]').click();
  await page.getByTestId(folder?'archive-worktree-delete-confirm':'archive-delete-confirm').click();
 }
 await start(0);
 await shot('02-first-pending');
 await page.getByTestId('archive-delete-dialog').waitFor({state:'hidden',timeout:1500});
 await start(1);
 await expect.poll(()=>pending.size).toBe(2);
 await shot('03-two-pending');
 await row(0).evaluate(el=>{window.archiveTable=el.closest('table');window.archiveScroll=window.archiveTable.parentElement;window.archiveScroll.scrollTop=120;});
 rows.splice(rows.findIndex(r=>r.id==='task-1'),1);
 await pending.get('/api/archive/tasks/task-1').fulfill({json:{ok:true}});
 await row(1).waitFor({state:'hidden'});
 assert.equal(await row(0).count(),1);
 assert.equal(requests,2,'no archive refetch after delete');
 assert.equal(await page.evaluate(()=>window.archiveTable.isConnected && window.archiveScroll.scrollTop>0),true,'table stays mounted and scrolled');
 await pending.get('/api/archive/tasks/task-0').fulfill({status:500,json:{error:'fixture deletion failed'}});
 await row(0).locator('[data-control="archive.item.delete"]:enabled').waitFor();
 await shot('04-out-of-order-error');
 assert.match(await page.locator('body').innerText(),/fixture deletion failed/);
 await start(0);
 rows.splice(rows.findIndex(r=>r.id==='task-0'),1);
 await pending.get('/api/archive/tasks/task-0').fulfill({json:{ok:true}});
 await row(0).waitFor({state:'hidden'});
 await start(2,true);
 await page.getByTestId('archive-worktree-delete-dialog').waitFor({state:'hidden',timeout:1500});
 await expect(row(6).locator('[data-control="archive.item.delete"]')).toBeDisabled();
 await start(3,true);
 await pending.get('/api/worktrees/wt_3').fulfill({json:{ok:true}});
 await row(3).locator('[data-control="archive.item.delete_worktree"]').waitFor({state:'hidden'});
 await pending.get('/api/worktrees/wt_2').fulfill({json:{ok:true}});
 await row(2).locator('[data-control="archive.item.restore"]').waitFor({state:'hidden'});
 await row(6).locator('[data-control="archive.item.restore"]').waitFor({state:'hidden'});
 assert.equal(requests,2);
 await shot('05-folder-deletions');
 await page.locator('[data-control="archive.load_more"]').click();
 await row(104).waitFor();
 assert.equal(await page.locator('[data-testid^="archive-task-row-"]').count(),103,'offset adjusts after deleting loaded rows');
 await shot('06-pagination');
 await page.setViewportSize({width:390,height:844});
 await start(4);
 await page.getByTestId('archive-delete-dialog').waitFor({state:'hidden',timeout:1500});
 await start(5);
 await shot('07-phone-two-pending');
 rows.splice(rows.findIndex(r=>r.id==='task-4'),1);
 rows.splice(rows.findIndex(r=>r.id==='task-5'),1);
 await pending.get('/api/archive/tasks/task-4').fulfill({json:{ok:true}});
 await pending.get('/api/archive/tasks/task-5').fulfill({json:{ok:true}});
 await row(5).waitFor({state:'hidden'});
 await shot('08-phone-complete');
 const chat=id=>page.getByTestId('archive-chat-row-chat-'+id);
 for(const id of [0,1]){
  await chat(id).locator('[data-control="archive.item.delete"]').click();
  await page.getByTestId('archive-delete-confirm').click();
  await page.getByTestId('archive-delete-dialog').waitFor({state:'hidden'});
 }
 await expect.poll(()=>pending.has('/api/sessions/chat-1')).toBe(true);
 await pending.get('/api/sessions/chat-0').abort('failed');
 await pending.get('/api/sessions/chat-1').fulfill({json:{ok:true}});
 await chat(1).waitFor({state:'hidden'});
 await expect(chat(0).locator('[data-control="archive.item.delete"]')).toBeEnabled();
 chats.splice(1,1);
 await shot('09-chat-network-failure');
 await page.setViewportSize({width:1440,height:1000});
 await start(7);
 holdArchive=true;
 await page.locator('[data-control="archive.retry"]').click();
 await expect.poll(()=>heldArchive.length).toBe(2);
 const refreshesBefore=await page.evaluate(()=>window.archiveProjectRefreshes ?? 0);
 rows.splice(rows.findIndex(r=>r.id==='task-7'),1);
 await pending.get('/api/archive/tasks/task-7').fulfill({json:{ok:true}});
 // Observe the completed request before releasing the stale list snapshots.
 await page.waitForFunction(previous=>(window.archiveProjectRefreshes ?? 0)>previous,refreshesBefore);
 holdArchive=false;
 for(const held of heldArchive) await held.route.fulfill(held.payload);
 await row(8).waitFor();
 assert.equal(await row(7).count(),0,'late list response cannot resurrect a deleted row');
 await shot('10-late-refresh');
 console.log('PASS: concurrent deletes, out-of-order completion, failure/retry, folder updates, pagination, phone');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
