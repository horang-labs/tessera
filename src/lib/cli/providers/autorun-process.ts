import fs from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawnCli } from '../spawn-cli';
import { AUTORUN_BOUNDS } from '@/lib/automation/autorun-contracts';

/** Executed in the agent filesystem. A random, exclusive workspace owns this entire group. */
export const AUTORUN_GROUP_WRAPPER = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const root = process.argv[2], launch = JSON.parse(fs.readFileSync(root + '/launch.json', 'utf8'));
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(TESSERA|CLAUDE|CODEX|ANTHROPIC|OPENAI)_/.test(key) || key === 'CLAUDECODE') delete env[key];
Object.assign(env, launch.environment);
const child = cp.spawn(launch.command, launch.args, {cwd:root + '/empty', detached:true, stdio:'pipe', env});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); process.stdin.pipe(child.stdin);
function members() {
 const result=[];
 for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))) try {
  const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'); const f=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(Number(f[2])===child.pid) result.push({pid:Number(pid),state:f[0],start:f[19]});
 }catch{}
 return result;
}
let cancelled=false, force=null;
function stop() {
 if(cancelled)return; cancelled=true;
 try{process.kill(-child.pid,'SIGTERM')}catch{}
 force=setTimeout(()=>{if(members().some(p=>p.state!=='Z'))try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);
}
const timer=setInterval(()=>{if(fs.existsSync(root+'/abort'))stop()},50);
child.on('error',()=>{clearInterval(timer);fs.writeFileSync(root+'/settled.json',JSON.stringify({exitCode:null,quiescent:true}));process.exitCode=1;});
child.on('exit',()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}});
child.on('close',code=>{
 clearInterval(timer);if(force)clearTimeout(force);
 const settle=()=>{const remaining=members();const quiescent=remaining.every(p=>p.state==='Z');
 fs.writeFileSync(root+'/settled.json',JSON.stringify({exitCode:code,quiescent,remaining}));process.exitCode=code===0?0:1;};
 if(members().some(p=>p.state!=='Z')){try{process.kill(-child.pid,'SIGKILL')}catch{};setTimeout(settle,100);}else settle();
});
fs.writeFileSync(root+'/owned.json',JSON.stringify({pid:child.pid,startedAt:Date.now()}));
`;
export type OwnedProcessRequest = {
  userId: string; agentEnvironment: 'native' | 'wsl'; root: string; guestRoot: string;
  signal: AbortSignal; deadlineAt: number; stdin: string;
};
export type OwnedProcessResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null;
  quiescent: boolean; cancelled: boolean; timedOut: boolean; overflow: boolean };
export type OwnedProcessDependencies = {
  spawn(request: OwnedProcessRequest): ChildProcess;
  abort(root: string): Promise<void>;
  settlement(root: string): Promise<{ exitCode: number | null; quiescent: boolean }>;
  settleWaitMs?: number;
};
const defaultDependencies: OwnedProcessDependencies = {
  spawn: r => spawnCli('node', [r.guestRoot + '/group.cjs', r.guestRoot], { cwd: r.root, stdio: 'pipe' }, r.agentEnvironment),
  abort: async root => { await fs.writeFile(root + '/abort', 'cancel', { mode: 0o600 }); },
  settlement: async root => JSON.parse(await fs.readFile(root + '/settled.json', 'utf8')),
};
/** WSL descendants are signalled by the guest-owned group wrapper, never by killing wsl.exe. */
export function runOwnedSupervisor(request: OwnedProcessRequest, deps = defaultDependencies): Promise<OwnedProcessResult> {
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
      try { settlement = await deps.settlement(request.root); } catch { /* Missing owned receipt is uncertainty. */ }
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
