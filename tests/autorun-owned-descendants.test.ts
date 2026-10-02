import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUTORUN_GROUP_WRAPPER, runOwnedSupervisor } from '../src/lib/cli/providers/autorun-process';
import { createAutorunProviderPort } from '../src/lib/cli/providers/autorun-provider';
import { registerSupervisorInvocation, closeSupervisorInvocation, type SettlementDependencies } from '../src/lib/cli/providers/autorun-settlement';
const exec = promisify(execFile);
const request = { version: 1 as const, userId: 'descendant-owner', agentEnvironment: 'wsl' as const, invocationId: 'escaped-tree' };
async function living(pid: number, start: string) {
  try { const f = (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)!.split(' '); return f[19] === start && f[0] !== 'Z'; }
  catch { return false; }
}
test('recovery settles double-forked detached descendants before releasing capacity', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-detached-'));
  const deps: SettlementDependencies = { resolveGuestHome: async () => home,
    execute: async (_r, command, args) => { try { return { ok: true, ...await exec(command, args, { timeout: 5000 }) }; }
      catch { return { ok: false, stdout: '', stderr: '' }; } } };
  const identities = home + '/descendants.json';
  try {
    const recovery = await registerSupervisorInvocation({ ...request, provider: 'codex', deadlineAt: Date.now() + 15_000 }, home, deps);
    const workspace = home + '/scratch'; await fs.mkdir(workspace); await fs.mkdir(workspace + '/empty');
    await fs.writeFile(workspace + '/group.cjs', AUTORUN_GROUP_WRAPPER);
    const fixture = workspace + '/daemon.cjs';
    await fs.writeFile(fixture, `const cp=require('child_process'),fs=require('fs'),stage=Number(process.argv[2]);
if(stage<2){const c=cp.spawn(process.execPath,[__filename,String(stage+1)],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
c.on('message',()=>{if(process.send)process.send('ready');c.disconnect();c.unref();process.exit(0)});}
else{const file=${JSON.stringify(identities)},saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
saved.push({pid:process.pid,start:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]});fs.writeFileSync(file,JSON.stringify(saved));
process.on('SIGTERM',()=>{if(stage===2){const c=cp.spawn(process.execPath,[__filename,'3'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
c.on('message',()=>process.exit(0));}});process.send('ready');setInterval(()=>{},50);}`);
    await fs.writeFile(workspace + '/launch.json', JSON.stringify({ command: process.execPath, args: [fixture, '0'], environment: {}, deadlineAt: Date.now() + 10_000 }));
    const result = await runOwnedSupervisor({ ...request, root: workspace, guestRoot: workspace, recovery,
      deadlineAt: Date.now() + 10_000, signal: new AbortController().signal, stdin: '' });
    const owned = JSON.parse(await fs.readFile(identities, 'utf8')) as { pid: number; start: string }[];
    const closed = await closeSupervisorInvocation(recovery);
    assert.equal(result.quiescent, true);
    assert.equal(closed.kind, 'quiescent');
    assert.equal(owned.length, 2, 'fixture forked a replacement while termination was underway');
    for (const child of owned) assert.equal(await living(child.pid, child.start), false, 'escaped owned child still runs after quiescence');
    assert.equal((await createAutorunProviderPort('codex', deps).observeSupervisorSettlement!(request)).kind, 'quiescent');
  } finally {
    try { for (const child of JSON.parse(await fs.readFile(identities, 'utf8'))) if (await living(child.pid, child.start)) process.kill(child.pid, 'SIGKILL'); } catch { /* fixture never spawned */ }
    await fs.rm(home, { recursive: true });
  }
});
