import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

// Real shared hook and status component; controlled API models a cleanup batch.
const root = process.cwd();
const artifacts = process.env.TESSERA_TEST_ARTIFACT_DIR ?? path.join(root, 'tmp', 'archive-retention-browser');
await fs.mkdir(artifacts, { recursive: true });
const output = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {useAuthStore} from './src/stores/auth-store';
useAuthStore.setState({user:{id:'user1',username:'fixture'},isAuthenticated:true});window.setUser=(id)=>useAuthStore.setState({user:id?{id,username:id}:null});
import {ArchiveNavigationButton} from './src/components/archive/archive-navigation-button';
import {ArchiveRetentionStatus} from './src/components/archive/archive-retention-status';
import {useArchiveRetentionProgress,isArchiveRetentionActive} from './src/hooks/use-archive-retention-progress';
function Probe(){const p=useArchiveRetentionProgress();return <output className="sr-only" data-testid="probe">{isArchiveRetentionActive(p)?'active':'inactive'}</output>}
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<div className="flex gap-4 p-4"><aside className="w-11 bg-(--sidebar-bg)"><ArchiveNavigationButton/><Probe/></aside><main className="w-full max-w-xl"><ArchiveRetentionStatus/></main></div>);`,
    resolveDir: root, loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'translation-fixture', setup(b) {
    b.onResolve({ filter: /^@\/(lib\/i18n|stores\/tab-store|lib\/telemetry\/ui-click|hooks\/use-tooltips-enabled)$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: `import {en} from '${root}/src/lib/i18n/en.ts';export const useTabStore={getState:()=>({findSessionLocation:()=>null,createTab:()=>window.archiveOpened=true})};export const telemetryClickAttributes=()=>({});export const useTooltipsEnabled=()=>true;export const useI18n=()=>({t:(key,params)=>Object.entries(params??{}).reduce((s,[k,v])=>s.replaceAll('{{'+k+'}}',String(v)),key.split('.').reduce((v,k)=>v?.[k],en)??key)});`,
      loader: 'js', resolveDir: root,
    }));
  } }],
});
const css = await postcss([tailwind()]).process(await fs.readFile('src/app/globals.css', 'utf8'), {from:path.join(root,'src/app/globals.css')});
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/app.js' ? output.outputFiles[0].text : req.url === '/style.css' ? css.css : '<html class="dark"><head><link rel="stylesheet" href="/style.css"></head><body style="background:#181818;color:#ddd;font:16px sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.clock.install();
  let progress = { phase: 'scanning', total: 0, completed: 0, removed: 0, skipped: 0, errors: [], currentTitle: null, startedAt: '2026-09-12T00:00:00Z', finishedAt: null };
  let requests = 0;
  let fail = false;
  await page.route('**/api/archive/retention', async route => {
    requests++;
    await route.fulfill({ status: fail ? 503 : 200, json: { progress } });
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await expect(page.getByTestId('probe')).toHaveText('active');
  await expect(page.getByTestId('archive-retention-spinner')).toBeVisible();
  await expect(page.getByTestId('archive-retention-status').getByRole('status')).toHaveText('Checking folders for automatic cleanup…');
  assert.equal(requests, 1, 'three consumers share one request');
  await page.getByTestId('project-strip-archive').click();
  assert.equal(await page.evaluate(()=>window.archiveOpened), true, 'archive navigation still opens its tab');
  await page.screenshot({ path: path.join(artifacts, '01-scanning.png') });
  progress = { ...progress, phase: 'waiting', total: 3, completed: 2, removed: 1, skipped: 1 };
  await page.clock.runFor(2_100);
  await expect(page.getByTestId('archive-retention-status').getByRole('status')).toContainText('2/3 processed');
  await expect(page.getByTestId('probe')).toHaveText('active');
  await expect(page.getByTestId('project-strip-archive')).toHaveAttribute('aria-label', 'Cleaning worktree folders · 2/3 processed');
  assert.equal(requests, 2, 'one shared timer polls during inter-folder wait');
  await page.screenshot({ path: path.join(artifacts, '02-waiting.png') });
  progress = { ...progress, phase: 'complete', completed: 3, errors: [{ id: 'wt1', kind: 'task', title: 'Archived example', error: 'Folder is locked' }], finishedAt: '2026-09-12T00:01:00Z' };
  await page.clock.runFor(2_100);
  await expect(page.getByTestId('probe')).toHaveText('inactive');
  await expect(page.getByTestId('archive-retention-spinner')).toHaveCount(0);
  await expect(page.getByTestId('archive-retention-status').getByRole('status')).toHaveText('Automatic folder cleanup complete');
  await page.getByText('View 1 failed folders').click();
  await expect(page.getByText('Archived example: Folder is locked')).toBeVisible();
  await expect(page.getByText('1 deleted · 1 skipped · 1 failed')).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, '03-complete-failure.png') });
  progress = {...progress, phase:'complete',total:0,completed:0,removed:0,skipped:0,errors:[{id:'scan',kind:'task',error:'Cannot inspect archived folders'}]};
  await page.clock.runFor(15_100);
  await expect(page.getByTestId('archive-retention-status')).toBeVisible();
  await expect(page.getByText('scan: Cannot inspect archived folders')).toBeVisible();
  await page.screenshot({path:path.join(artifacts,'04-scan-failed.png')});
  progress = {...progress, phase:'idle',total:0,completed:0,errors:[]};
  await page.clock.runFor(15_100);
  await expect(page.getByTestId('archive-retention-status')).toHaveCount(0);
  await expect(page.getByTestId('project-strip-archive')).toHaveAttribute('aria-label','Archive');
  await page.screenshot({path:path.join(artifacts,'05-idle.png')});
  fail = true;
  await page.clock.runFor(15_100);
  await expect(page.getByTestId('archive-retention-status')).toHaveCount(0);
  await expect(page.getByTestId('probe')).toHaveText('inactive');
  await page.screenshot({ path: path.join(artifacts, '06-disconnected.png') });
  fail=false;
  progress={...progress,phase:'running',total:1,completed:0};
  await page.evaluate(()=>window.setUser('user2'));
  await expect(page.getByTestId('probe')).toHaveText('active');
  await page.evaluate(()=>window.setUser(null));
  await expect(page.getByTestId('probe')).toHaveText('inactive');
  await expect(page.getByTestId('archive-retention-status')).toHaveCount(0);
  const afterLogout=requests;
  await page.clock.runFor(30_000);
  assert.equal(requests,afterLogout,'logout clears progress and stops polling');
  await page.evaluate(() => window.unmount());
  const before = requests;
  await page.clock.runFor(30_000);
  assert.equal(requests, before, 'polling stops when all consumers unmount');
  console.log('PASS: shared polling, scanning, waiting, completion, failure details, disconnect and teardown');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
