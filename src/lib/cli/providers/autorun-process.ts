import fs from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawnCli } from '../spawn-cli';
import { AUTORUN_BOUNDS } from '@/lib/automation/autorun-contracts';
import { createSupervisorAttempt, type SupervisorRecovery, type SupervisorAttempt } from './autorun-settlement';

/** A capability probe is an owned process too; its uncertainty must reach the engine. */
export { SupervisorProcessUncertain } from './autorun-recovery-ledger';

/** The WSL relay may die with its Windows parent. The admitted execution guardian owns a separate
 * guest session; this one-shot I/O relay cannot launch a second process or bypass sealed admission.
 */
export const AUTORUN_RECOVERY_BRIDGE = String.raw`
const cp=require('node:child_process'),p=JSON.parse(process.argv[1]);
const child=cp.spawn('flock',['--no-fork','-n',p.ledgerRoot+'/lock','node',p.workspace+'/group.cjs',p.workspace,p.attempt],{detached:true,stdio:'pipe'});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
process.stdout.on('error',()=>child.stdout.resume());process.stderr.on('error',()=>child.stderr.resume());
process.stdin.on('error',()=>child.stdin.end());child.stdin.on('error',()=>{});
child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code===0?0:1});
`;

/** Executed in the agent filesystem. A random, exclusive workspace owns this entire group. */
export const AUTORUN_GROUP_WRAPPER = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const root = process.argv[2], launch = JSON.parse(fs.readFileSync(root + '/launch.json', 'utf8'));
const attemptRoot=process.argv[3];let attempt=null;
function writeAttempt(value){
 const file=attemptRoot+'/state.json',temp=file+'.tmp',fd=fs.openSync(temp,'w',384);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(temp,file);const dir=fs.openSync(attemptRoot,'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
}
function startToken(pid){const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}
if(attemptRoot){
 attempt=JSON.parse(fs.readFileSync(attemptRoot+'/state.json','utf8'));
 const manifest=JSON.parse(fs.readFileSync(attempt.ledgerRoot+'/invocation.json','utf8'));
 if(attempt.phase!=='prelaunch'||attempt.launchId!==manifest.launchId||!manifest.attemptIds.includes(attempt.attemptId)||
  !['version','userId','agentEnvironment','invocationId','provider'].every(k=>attempt[k]===manifest[k]))process.exit(1);
 if(manifest.closedAt!==null||Date.now()>=manifest.deadlineAt){
  writeAttempt({...attempt,phase:'settled',spawned:false,noLaunchReason:manifest.closedAt!==null?'authorization-sealed':'deadline',quiescent:true,remaining:[],settledAt:Date.now()});process.exit(1);
 }
 attempt={...attempt,phase:'starting',wrapper:{pid:process.pid,start:startToken(process.pid),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}};
 writeAttempt(attempt);
}
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(TESSERA|CLAUDE|CODEX|ANTHROPIC|OPENAI)_/.test(key) || key === 'CLAUDECODE') delete env[key];
Object.assign(env, launch.environment);
const child = cp.spawn(launch.command, launch.args, {cwd:root + '/empty', detached:true, stdio:'pipe', env});
// The backend may vanish while the guest still owns a deadline/tree. Broken bridge pipes cannot
// terminate this wrapper before it persists settlement. Drain discarded output; never replay it.
process.stdout.on('error',()=>child.stdout.resume());process.stderr.on('error',()=>child.stderr.resume());
process.stdin.on('error',()=>child.stdin.end());child.stdin.on('error',()=>{});
let childStart=null;try{childStart=startToken(child.pid)}catch{}
if(attempt&&child.pid){attempt={...attempt,phase:'running',child:{pid:child.pid,start:childStart}};writeAttempt(attempt)}
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); process.stdin.pipe(child.stdin);
function members() {
 const result=[];
 for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))) try {
  const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'); const f=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(Number(f[2])===child.pid) result.push({pid:Number(pid),state:f[0],start:f[19]});
 }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}
 return result;
}
let cancelled=false, force=null;
function reused(){try{return childStart!==null&&startToken(child.pid)!==childStart}catch{return false}}
function signalGroup(signal){if(!reused())try{process.kill(-child.pid,signal)}catch{}}
function receipt(code,remaining,spawned=Number.isSafeInteger(child.pid)){
 const quiescent=!reused()&&remaining.every(p=>p.state==='Z');
 if(attempt)writeAttempt({...attempt,phase:'settled',spawned,...(!spawned?{noLaunchReason:'spawn-error'}:{}),exitCode:code,quiescent,remaining,settledAt:Date.now()});
 fs.writeFileSync(root+'/settled.json',JSON.stringify({exitCode:code,quiescent,remaining}));
}
function stop() {
 if(cancelled)return; cancelled=true;
 signalGroup('SIGTERM');
 force=setTimeout(()=>{if(members().some(p=>p.state!=='Z'))signalGroup('SIGKILL')},5000);
}
const timer=setInterval(()=>{if(fs.existsSync(root+'/abort')||Date.now()>=launch.deadlineAt)stop()},50);
child.on('error',()=>{clearInterval(timer);receipt(null,[],false);process.exitCode=1;});
child.on('exit',()=>{signalGroup('SIGTERM')});
child.on('close',code=>{
 clearInterval(timer);if(force)clearTimeout(force);
 const settle=()=>{receipt(code,members());process.exitCode=code===0?0:1;};
 if(members().some(p=>p.state!=='Z')){signalGroup('SIGKILL');setTimeout(settle,100);}else settle();
});
fs.writeFileSync(root+'/owned.json',JSON.stringify({pid:child.pid,startedAt:Date.now()}));
`;
export type OwnedProcessRequest = {
  userId: string; agentEnvironment: 'native' | 'wsl'; root: string; guestRoot: string;
  signal: AbortSignal; deadlineAt: number; stdin: string;
  recovery?: SupervisorRecovery; attempt?: SupervisorAttempt;
};
export type OwnedProcessResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null;
  quiescent: boolean; cancelled: boolean; timedOut: boolean; overflow: boolean };
export type OwnedProcessDependencies = {
  spawn(request: OwnedProcessRequest): ChildProcess;
  abort(root: string): Promise<void>;
  settlement(root: string, request?: OwnedProcessRequest): Promise<{ exitCode: number | null; quiescent: boolean }>;
  settleWaitMs?: number;
};
const defaultDependencies: OwnedProcessDependencies = {
  spawn: r => r.recovery && r.attempt ? spawnCli('node', ['-e', AUTORUN_RECOVERY_BRIDGE,
    JSON.stringify({ ledgerRoot: r.recovery.guestRoot, workspace: r.guestRoot, attempt: r.attempt.guestRoot })],
    { cwd: r.root, stdio: 'pipe' }, r.agentEnvironment) : spawnCli('node', [r.guestRoot + '/group.cjs', r.guestRoot], { cwd: r.root, stdio: 'pipe' }, r.agentEnvironment),
  abort: async root => { await fs.writeFile(root + '/abort', 'cancel', { mode: 0o600 }); },
  settlement: async (root, request) => {
    if (!request?.attempt) return JSON.parse(await fs.readFile(root + '/settled.json', 'utf8'));
    const state = JSON.parse(await fs.readFile(request.attempt.root + '/state.json', 'utf8'));
    if (state.phase !== 'settled' || state.launchId !== request.attempt.launchId || state.attemptId !== request.attempt.attemptId ||
        state.userId !== request.userId || state.agentEnvironment !== request.agentEnvironment || state.invocationId !== request.recovery?.identity.invocationId ||
        state.provider !== request.recovery?.identity.provider || state.quiescent !== true || !Number.isSafeInteger(state.settledAt) ||
        (state.exitCode !== null && !Number.isSafeInteger(state.exitCode)) || !Array.isArray(state.remaining) ||
        state.remaining.some((p: { state?: string }) => p.state !== 'Z')) throw new Error('incomplete owned settlement');
    return state;
  },
};
/** WSL descendants are signalled by the guest-owned group wrapper, never by killing wsl.exe. */
export async function runOwnedSupervisor(request: OwnedProcessRequest, deps = defaultDependencies): Promise<OwnedProcessResult> {
  if (request.recovery) {
    try { request = { ...request, attempt: await createSupervisorAttempt(request.recovery) }; }
    catch { return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: null, quiescent: false, cancelled: request.signal.aborted, timedOut: false, overflow: false }; }
  }
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let cancelled = request.signal.aborted, timedOut = request.deadlineAt <= Date.now(), overflow = false, finished = false;
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout>;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = async (code: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      request.signal.removeEventListener('abort', abort);
      let settlement = { exitCode: code, quiescent: false };
      try { settlement = await deps.settlement(request.root, request); } catch { /* Missing owned receipt is uncertainty. */ }
      resolve({ stdout, stderr, exitCode: settlement.exitCode, quiescent: settlement.quiescent, cancelled, timedOut, overflow });
    };
    const stop = () => {
      void deps.abort(request.root).catch(() => {});
      forceTimer ??= setTimeout(() => { void finish(null); }, deps.settleWaitMs ?? AUTORUN_BOUNDS.cancelGraceMs + 2000);
    };
    const abort = () => { cancelled = true; stop(); };
    if (cancelled || timedOut) { resolve({ stdout, stderr, exitCode: null, quiescent: true, cancelled, timedOut, overflow }); return; }
    try { child = deps.spawn(request); } catch { resolve({ stdout, stderr, exitCode: null, quiescent: true, cancelled, timedOut, overflow }); return; }
    const collect = (which: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk); const current = which === 'stdout' ? stdout : stderr;
      const limit = which === 'stdout' ? AUTORUN_BOUNDS.stdoutBytes : AUTORUN_BOUNDS.stderrBytes;
      const next = Buffer.concat([current, bytes.subarray(0, Math.max(0, limit - current.length))]);
      if (which === 'stdout') stdout = next; else stderr = next;
      if (current.length + bytes.length > limit) { overflow = true; stop(); }
    };
    child.stdout?.on('data', c => collect('stdout', c)); child.stderr?.on('data', c => collect('stderr', c));
    child.stdin?.on('error', () => stop()); child.on('error', () => { stop(); void finish(null); });
    child.on('close', code => { void finish(code); });
    timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, request.deadlineAt - Date.now()));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdin?.end(request.stdin);
  });
}
