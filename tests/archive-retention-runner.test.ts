import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import type { RetentionResult } from '@/lib/archive/archive-service';

const candidate = (id: string) => ({ worktreeId: `wt_${id}`, id, kind: 'task' as const, title: `Folder ${id}` });
let candidates = [candidate('a'), candidate('b'), candidate('c')];
let calls: string[] = [];
let scanCount = 0;
let cleanup: (id: string) => Promise<RetentionResult> = async () => ({removed:1,attempted:1,skipped:0,errors:[]});
let scan: (() => Promise<typeof candidates>) | undefined;
const dependencies = {
  listExpiredArchivedWorktreeCandidates: async () => { scanCount++; return scan ? scan() : candidates; },
  pruneExpiredArchivedWorktrees: async (_days: number, _user: string, opts: {worktreeIds: Set<string>}) => {
    const id = [...opts.worktreeIds][0]; calls.push(id); return cleanup(id);
  },
};
// Exercise the production runner and its actual timers with only disk deletion stubbed.
(globalThis as unknown as {retentionTestDependencies: typeof dependencies}).retentionTestDependencies = dependencies;
let runner: typeof import('@/lib/archive/archive-retention-runner');
test.before(async () => {
const bundle = await build({
  entryPoints:['src/lib/archive/archive-retention-runner.ts'],bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'retention-dependencies',setup(b){
    b.onResolve({filter:/^\.\/archive-service$/},()=>({path:'service',namespace:'fixture'}));
    b.onResolve({filter:/^@\/lib\/logger$/},()=>({path:'logger',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='logger'
      ? 'export default {warn(){}}'
      : 'export const {listExpiredArchivedWorktreeCandidates,pruneExpiredArchivedWorktrees}=globalThis.retentionTestDependencies;'}));
  }}],
});
runner = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
});
const progress = () => runner.getArchivedWorktreeRetentionProgress('user-a');
const flush = () => new Promise<void>(resolve=>setImmediate(resolve));
test.beforeEach(()=>{
  runner.stopArchivedWorktreeRetention();
  candidates=[candidate('a'),candidate('b'),candidate('c')];calls=[];scanCount=0;scan=undefined;
  cleanup=async()=>({removed:1,attempted:1,skipped:0,errors:[]});
  runner.configureArchivedWorktreeRetention({retentionDays:3,userId:'user-a'});
});
test.afterEach(()=>runner.stopArchivedWorktreeRetention());

test('one snapshot counts physical folders and advances beyond failures',async()=>{
  cleanup=async id=>id==='wt_a'
    ? {removed:0,attempted:1,skipped:0,errors:[{id:'a',kind:'task',error:'locked'}]}
    : {removed:1,attempted:1,skipped:100,errors:[]};
  await runner.runArchivedWorktreeRetentionNow();
  assert.deepEqual(calls,['wt_a']);
  assert.equal(progress().phase,'waiting');
  assert.equal(progress().total,3);
  assert.equal(progress().completed,1);
  assert.equal(progress().removed,0);
  assert.equal(progress().skipped,0,'irrelevant archive rows are not skipped folders');
  assert.equal(progress().errors[0].title,'Folder a');
  await runner.runArchivedWorktreeRetentionNow();
  await runner.runArchivedWorktreeRetentionNow();
  assert.deepEqual(calls,['wt_a','wt_b','wt_c']);
  assert.equal(scanCount,1);
  assert.equal(progress().phase,'complete');
  assert.equal(progress().completed,3);
  assert.equal(progress().removed,2);
  assert.ok(progress().finishedAt);
  assert.equal(runner.getArchivedWorktreeRetentionProgress('other-user').phase,'idle');
});

test('in-flight folder is visible and duplicate requests share the operation',async()=>{
  let finish!: (r:RetentionResult)=>void;
  cleanup=()=>new Promise(resolve=>{finish=resolve;});
  const first=runner.runArchivedWorktreeRetentionNow();
  await flush();
  const second=runner.runArchivedWorktreeRetentionNow();
  assert.equal(progress().currentTitle,'Folder a');
  assert.equal(progress().phase,'running');
  assert.equal(progress().completed,0);
  finish({removed:1,attempted:1,skipped:0,errors:[]});
  await Promise.all([first,second]);
  assert.equal(calls.length,1);
  assert.equal(progress().completed,1);
});

test('restored or externally removed queued folders count as skipped',async()=>{
  cleanup=async()=>({removed:0,attempted:0,skipped:250,errors:[]});
  await runner.runArchivedWorktreeRetentionNow();
  assert.equal(progress().completed,1);
  assert.equal(progress().skipped,1);
  assert.equal(progress().removed,0);
});

test('policy changes during a scan cancel the old snapshot before deletion',async()=>{
  let finish!: (r:typeof candidates)=>void;
  scan=()=>new Promise(resolve=>{finish=resolve;});
  const pending=runner.runArchivedWorktreeRetentionNow();
  await flush();
  assert.equal(progress().phase,'scanning');
  runner.configureArchivedWorktreeRetention({retentionDays:7,userId:'user-b'});
  finish(candidates);
  await pending;
  assert.equal(calls.length,0);
  assert.equal(progress().phase,'idle');
  assert.equal(runner.getArchivedWorktreeRetentionProgress('user-b').phase,'idle');
});

test('unchanged settings preserve progress and deletion throws do not block the queue',async()=>{
  cleanup=async()=>{throw new Error('disk unavailable');};
  await runner.runArchivedWorktreeRetentionNow();
  runner.configureArchivedWorktreeRetention({retentionDays:3,userId:'user-a'});
  await runner.runArchivedWorktreeRetentionNow();
  assert.deepEqual(calls,['wt_a','wt_b']);
  assert.equal(progress().completed,2);
  assert.equal(progress().errors.length,2);
});

test('startup waits one minute and subsequent folders wait thirty seconds',async t=>{
  runner.stopArchivedWorktreeRetention();
  t.mock.timers.enable({apis:['setTimeout']});
  runner.configureArchivedWorktreeRetention({retentionDays:3,userId:'user-a'});
  t.mock.timers.tick(59_999);await flush();assert.equal(calls.length,0);
  t.mock.timers.tick(1);await flush();assert.equal(calls.length,1);
  runner.configureArchivedWorktreeRetention({retentionDays:3,userId:'user-a'});
  t.mock.timers.tick(29_999);await flush();assert.equal(calls.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(calls.length,2);
});

test('empty cycles stay idle and scan failures are visible',async()=>{
  candidates=[];
  await runner.runArchivedWorktreeRetentionNow();assert.equal(progress().phase,'idle');
  scan=async()=>{throw new Error('scan failed');};
  await runner.runArchivedWorktreeRetentionNow();
  assert.equal(progress().phase,'complete');
  assert.equal(progress().errors[0].error,'scan failed');
});


test('overlapping callers both settle when the shared scan fails', async () => {
  let rejectScan!: (error: Error) => void;
  scan = () => new Promise((_resolve, reject) => { rejectScan = reject; });
  const first = runner.runArchivedWorktreeRetentionNow();
  await flush();
  const second = runner.runArchivedWorktreeRetentionNow();
  rejectScan(new Error('shared scan failed'));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(progress().errors[0].error, 'shared scan failed');
});
