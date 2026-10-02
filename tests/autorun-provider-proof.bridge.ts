import fs from 'node:fs';
import assert from 'node:assert/strict';
import { acceptSupervisorResult } from './autorun-provider-proof-finality';
import { correlateCompletedTurn } from './autorun-provider-proof-context';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnCliProcess } from '../src/lib/cli/spawn-cli-runtime';
import { getSpawnCliCache } from '../src/lib/cli/spawn-cli-cache';
import { buildHookCommand } from '../src/lib/terminal/hook-command';
import { appendTrustedHookState } from '../src/lib/terminal/codex-overlay';
import { resolveAgentReportedPath } from '../src/lib/filesystem/path-environment';
const guest=process.argv[2];
if (process.platform !== 'win32' || !guest?.startsWith('/home/')) throw new Error('Windows backend and owned WSL scratch required');
const root='\\\\wsl.localhost\\Ubuntu-24.04'+guest.replaceAll('/', '\\');
const token=randomUUID(); const session=randomUUID();const events:any[]=[];
const server=http.createServer((req,res)=>{
 if(req.headers['x-tessera-pane-token']!==token){res.writeHead(403).end();return;}
 let data='';req.on('data',b=>data+=b);req.on('end',()=>{events.push(JSON.parse(data));res.writeHead(204).end();});
});
async function main(){
 for(const k of Object.keys(process.env)) if(k.startsWith('TESSERA')) delete process.env[k];
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as any).port;
 fs.writeFileSync(root+'/bridge-command.txt',buildHookCommand('posix'));
 const hook=`node ${guest}/observer.cjs`;
 const hooks:any={hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','Stop','PermissionRequest','PreToolUse','PostToolUse'].map(k=>[k,[{hooks:[{type:'command',command:hook,timeout:10}]}]]))};
 const mode=process.argv[3]??'claude-worker';
 if(mode.endsWith('worker')) fs.writeFileSync(root+'/codex-home/hooks.json',JSON.stringify(hooks));
 if(mode.endsWith('worker')) fs.writeFileSync(root+'/codex-home/config.toml',appendTrustedHookState('model="gpt-6.1-sol"\nmodel_reasoning_effort="high"\nservice_tier="default"\nsandbox_mode="read-only"\napproval_policy="never"\n',guest+'/codex-home/hooks.json',hooks));
 console.log('backend platform',process.platform,'agent environment','wsl');
 const env:any={PROOF_ROOT:guest,CODEX_HOME:guest+(mode.endsWith('worker')?'/codex-home':'/codex-supervisor-home'),CLAUDE_CONFIG_DIR:guest+(mode.endsWith('worker')?'/claude-home':'/claude-supervisor-home'),TESSERA_HOOK_PORT:String(port),TESSERA_SESSION_ID:session,TESSERA_PANE_TOKEN:token};
 async function run(label:string,command:string,args:string[],prompt:string,overrides:any={}){
  label+=process.argv[4]==='probe'?'-probe':'';
  fs.writeFileSync(root+'/'+label+'-argv.json',JSON.stringify({command,args}));
  fs.writeFileSync(root+'/'+label+'-launch.json',JSON.stringify({command,args}));
  fs.rmSync(root+'/'+label+'-abort',{force:true});
  const child=spawnCliProcess('node',[guest+'/group-wrapper.cjs'],{cwd:root+'/empty',stdio:'pipe'},'wsl',getSpawnCliCache(),{guestEnvironment:{...env,...overrides,PROOF_LABEL:label,CLAUDECODE:undefined}});
  let out='',err=''; child.stdout!.on('data',b=>out+=b);child.stderr!.on('data',b=>err+=b);child.stdin!.end(prompt);
  const timer=setTimeout(()=>fs.writeFileSync(root+'/'+label+'-abort','timeout'),120000);
  const code=await new Promise(r=>child.on('close',r));clearTimeout(timer);
  fs.writeFileSync(root+'/'+label+'-stdout.jsonl',out);fs.writeFileSync(root+'/'+label+'-stderr.txt',err);
  const closure=JSON.parse(fs.readFileSync(root+'/'+label+'-closed.json','utf8'));
  assert.equal(closure.quiescent,true);
  if(mode.endsWith('supervisor') && label.startsWith(mode)) {
   const packet=JSON.parse(fs.readFileSync(root+(process.argv[4]==='probe'?'/probe-packet.json':'/packet.json'),'utf8'));
   acceptSupervisorResult(command as 'claude'|'codex',Buffer.from(out),{exitCode:code as number|null,cancelled:closure.cancelled,timedOut:false,quiescent:closure.quiescent},packet);
   assert.equal(fs.existsSync(root+'/empty/PROBE_SENTINEL'),false);
  }
  if(mode.endsWith('cancel') && label===mode) assert.equal(code,124);
  console.log(label,code,'bytes',out.length,'hook-events',events.length);
  return out;
 }
 const providerName=mode.startsWith('claude')?'claude':'codex';
 const version=await run(providerName+'-version',providerName,['--version'],'');
 assert.equal(version.trim(),providerName==='claude'?'2.1.284 (Claude Code)':'codex-cli 0.159.2');
 if(mode.endsWith('supervisor')){
  const schema=fs.readFileSync(root+'/decision-schema.json','utf8');
  const packet=fs.readFileSync(root+(process.argv[4]==='probe'?'/probe-packet.json':'/packet.json'),'utf8');
  const prompt='Use only the supplied evidence packet to judge the goal. Return the required JSON decision. '+packet;
  const clean={TESSERA_HOOK_PORT:undefined,TESSERA_SESSION_ID:undefined,TESSERA_PANE_TOKEN:undefined,TESSERA_CLI_COMMAND:undefined,TESSERA_CODEX_HOME:undefined,CODEX_CI:undefined,CODEX_SESSION_ID:undefined,CODEX_THREAD_ID:undefined,CODEX_VERSION:undefined};
  if(mode==='claude-supervisor')await run(mode,'claude',['-p','--output-format','json','--no-session-persistence','--model','claude-sonnet-5-5','--effort','high','--safe-mode','--restricted','--tools','','--disable-slash-commands','--permission-prompts','none','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings','{"disableAllHooks":true,"enabledPlugins":{}}','--json-schema',schema],prompt,clean);
  if(mode==='codex-supervisor')await run(mode,'codex',['exec','--json','--strict-config','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','-m','gpt-6.1-sol','--output-schema',guest+'/decision-schema.json',...JSON.parse(fs.readFileSync(root+'/codex-controls-adapted.json','utf8')),'-'],prompt,clean);
 }
 if(mode.endsWith('cancel')){
  const provider=mode.startsWith('claude')?'claude':'codex';
  const prior=JSON.parse(fs.readFileSync(root+'/'+provider+'-supervisor-argv.json','utf8'));
  fs.writeFileSync(root+'/'+mode+'-launch.json',JSON.stringify(prior));
  setTimeout(()=>fs.writeFileSync(root+'/'+mode+'-abort','cancel'),2500);
  await run(mode,prior.command,prior.args,'Reply exactly CANCEL_PROOF.',{PROOF_LABEL:mode,TESSERA_PANE_TOKEN:undefined,TESSERA_CLI_COMMAND:undefined,TESSERA_SESSION_ID:undefined,TESSERA_HOOK_PORT:undefined,CODEX_THREAD_ID:undefined,CODEX_SESSION_ID:undefined,CODEX_CI:undefined});
 }
 if(mode==='claude-worker'){
  const args=['-p','--output-format','stream-json','--verbose','--model','claude-sonnet-5-5','--effort','high','--restricted','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings',JSON.stringify(hooks)];
  await run('claude-turn1','claude',[...args,'--session-id',session],'Reply exactly PROOF_OK. Do not use tools.');
  await run('claude-turn2','claude',[...args,'--resume',session],'Again reply exactly PROOF_OK. Do not use tools.');
 }
 if(mode==='codex-worker'){
  const common=['--json','--skip-git-repo-check','--ignore-rules','-m','gpt-6.1-sol','-c','model_reasoning_effort="high"','-c','service_tier="default"'];
  const out=await run('codex-turn1','codex',['exec',...common,'-'],'Reply exactly PROOF_OK. Do not use tools.');
  const id=out.split('\n').filter(Boolean).map(s=>JSON.parse(s)).find(e=>e.type==='thread.started')?.thread_id;
  if(id)await run('codex-turn2','codex',['exec','resume',...common,id,'-'],'Again reply exactly PROOF_OK. Do not use tools.');
 }
 fs.writeFileSync(root+'/'+mode+'-hooks.json',JSON.stringify(events));
 for(const e of events){if(!e.transcript_path)continue;const p=await resolveAgentReportedPath(e.transcript_path,'wsl');try{fs.readFileSync(p);if(e.hook_event_name==='Stop'){
    const proof={provider:mode.startsWith('claude')?'claude':'codex',sessionId:e.session_id,submitId:e.prompt_id??e.turn_id,stopId:e.prompt_id??e.turn_id,finalText:e.last_assistant_message,blocked:false} as const;
    const cut=correlateCompletedTurn(fs.readFileSync(p),proof);
    fs.writeFileSync(root+'/'+mode+'-'+proof.submitId+'-cutoff.json',JSON.stringify(cut));
   }
   console.log('Windows native read',e.hook_event_name,true);}catch(error){throw new Error('Native transcript proof failed: '+String(error));}}
 server.close();
}
main().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});
