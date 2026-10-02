import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { AutomationInput } from '../src/lib/automation/contracts';

const root=fs.mkdtempSync(path.resolve('tmp/automation-target-'));
process.env.TESSERA_DATA_DIR=path.join(root,'data');
process.env.TESSERA_PRODUCTION_DB='1';process.env.TESSERA_ELECTRON_RUNTIME='1';
const owner='electron-local-user';let now=Date.UTC(2030,0,1),sequence=0;
async function setup(){
  const db=await import('../src/lib/db/database');await db.initDatabase();
  db.getDb().exec('DELETE FROM session_automation_runs; DELETE FROM session_automations; DELETE FROM session_automation_scheduler; DELETE FROM session_automation_idempotency;');
  const tag=++sequence;
  const projects=await import('../src/lib/db/projects'),tasks=await import('../src/lib/db/tasks');
  const settings=await import('../src/lib/settings/manager');
  const {DEFAULT_SETTINGS}=await import('../src/lib/settings/defaults');
  await settings.SettingsManager.save(owner,{...DEFAULT_SETTINGS,agentEnvironment:'native'});
  const {AutomationRepository}=await import('../src/lib/automation/repository');
  const {AutomationService}=await import('../src/lib/automation/service');
  const {inspectAutomationTarget}=await import('../src/lib/automation/startup');
  const catalog=async()=>({modelOptions:[{value:'fixture-model',label:'Fixture',isDefault:true,
    supportedReasoningEfforts:[{value:'high',label:'High',description:'Fixture'}],serviceTiers:[{value:'priority',label:'Fast',description:'Fixture'}],defaultServiceTier:null}]});
  const repo=new AutomationRepository(db.getDb());
  const service=new AutomationService(repo,{now:()=>now,owner:async()=>({userId:owner,agentEnvironment:'native'}),publish(){},
    runtime:()=>({}) as never,inspect:(user,target,environment)=>inspectAutomationTarget(user,target,environment,catalog)});
  function checkout(name:string){const dir=path.join(root,name);execFileSync('git',['init','-q',dir]);return dir;}
  const workDir=checkout(`root-${tag}`),projectId=workDir;
  projects.registerProject(projectId,workDir,'Root');
  const rootId=projects.getProjectWorktree(projectId)!.id;
  const managedDir=checkout(`managed-${tag}`);
  const managedId=tasks.createTask({id:`task-${rootId}`,projectId,title:'Managed',worktreePath:managedDir,worktreeBranch:'fixture'});
  const input=(worktreeId:string):AutomationInput=>({name:'Scheduled',enabled:true,target:{kind:'create-session',worktreeId,title:'Fixture',
    selection:{provider:'codex',model:'fixture-model',reasoningEffort:'high',serviceTier:'default',settings:{permissionPolicy:'inherit-cli',allowPreparationFailure:false}}},
    trigger:{kind:'once',at:now+60_000},prompt:'Read fixture',limits:{maxDispatches:1,expiresAt:now+120_000}});
  return {db:db.getDb(),repo,service,catalog,rootId,managedId,workDir,managedDir,projectId,input,setNow:(value:number)=>now=value};
}

test('public schedule admission accepts existing root and managed Worktrees with exact saved selection',async()=>{
  const f=await setup();
  for(const id of [f.rootId,f.managedId])for(const tier of ['default','fast'] as const){
    const input=f.input(id);if(input.target.kind==='create-session')input.target.selection.serviceTier=tier;
    const result=await f.service.create(owner,`${id}-${tier}`,input);
    assert.equal(result.automation.state,'enabled');assert.deepEqual(result.automation.target,input.target);
    assert.equal(f.service.list(owner,{worktreeId:id}).items.length,tier==='default'?1:2);
  }
});

test('native catalog capabilities reject unoffered Fast, unknown tiers and inherited model/effort',async()=>{
  const f=await setup();const {inspectAutomationTarget}=await import('../src/lib/automation/startup');
  f.service.deps.inspect=(user,target,environment)=>inspectAutomationTarget(user,target,environment,async()=>{
    const options=await f.catalog();return {modelOptions:options.modelOptions.map(model=>({...model,serviceTiers:[]}))};
  });
  for(const [field,value] of [['serviceTier','fast'],['serviceTier','urgent'],['model','absent'],['reasoningEffort','auto']] as const){
    const input=f.input(f.rootId);if(input.target.kind==='create-session')Object.assign(input.target.selection,{[field]:value});
    await assert.rejects(f.service.create(owner,field+value,input));
  }
  const {createReservedAutomationSession}=await import('../src/lib/automation/worktree-target');
  const {readSavedSessionSelection}=await import('../src/lib/automation/runtime-adapter');
  const target=f.input(f.rootId).target;if(target.kind==='create-session')createReservedAutomationSession('unsupported-native',target);
  f.db.prepare('UPDATE sessions SET service_tier=? WHERE id=?').run('urgent','unsupported-native');
  assert.throws(()=>readSavedSessionSelection('unsupported-native'),{code:'UNSUPPORTED_SELECTION'});
  assert.equal(f.service.list(owner,{}).items.length,0);
});

test('invalid, archived, deleted and foreign targets cannot create a schedule or manufacture ownership',async()=>{
  const f=await setup();
  await assert.rejects(f.service.create('foreign','foreign',f.input(f.rootId)),{code:'OWNER_NOT_ALLOWED'});
  await assert.rejects(f.service.create(owner,'missing',f.input('wt_missing')),{code:'NOT_FOUND'});
  f.db.prepare('UPDATE tasks SET archived=1 WHERE public_worktree_id=?').run(f.managedId);
  await assert.rejects(f.service.create(owner,'archived',f.input(f.managedId)),{code:'NOT_FOUND'});
  f.db.prepare('UPDATE tasks SET archived=0,worktree_deleted_at=? WHERE public_worktree_id=?').run('deleted',f.managedId);
  await assert.rejects(f.service.create(owner,'deleted-managed',f.input(f.managedId)),{code:'NOT_FOUND'});
  fs.rmSync(f.workDir,{recursive:true});
  await assert.rejects(f.service.create(owner,'deleted-root',f.input(f.rootId)),{code:'NOT_FOUND'});
  assert.equal(f.service.list(owner,{}).items.length,0);
});

test('admission revalidates registered project ownership after asynchronous selection lookup',async()=>{
  const f=await setup(),inspect=f.service.deps.inspect;
  f.service.deps.inspect=async(...args)=>{
    const result=await inspect(...args);
    f.db.prepare('UPDATE projects SET project_worktree_id=NULL WHERE id=?').run(f.projectId);
    return result;
  };
  await assert.rejects(f.service.create(owner,'project-rebound',f.input(f.rootId)),{code:'NOT_FOUND'});
  assert.equal(f.service.list(owner,{}).items.length,0);
});

for(const kind of ['root','managed'] as const)test(`${kind} lifecycle changes after admission prevent due reservation and launch`,async()=>{
  const f=await setup();const {AutomationEngine}=await import('../src/lib/automation/engine');
  const engine=new AutomationEngine(f.service,`lifecycle-${kind}`);let launches=0;
  f.service.deps.runtime=()=>({dispatch:async()=>{launches++;throw new Error('must not launch');}}) as never;
  try{
    await engine.tick();const id=kind==='root'?f.rootId:f.managedId;
    const rule=(await f.service.create(owner,'late-lifecycle',f.input(id))).automation;
    const before=f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    if(kind==='root')f.db.prepare('UPDATE projects SET project_worktree_id=NULL WHERE id=?').run(f.projectId);
    else f.db.prepare('UPDATE tasks SET archived=1 WHERE public_worktree_id=?').run(f.managedId);
    f.setNow(now+60_000);await engine.tick();
    assert.equal(launches,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,before);
    assert.equal(f.service.history(owner,rule.id,{}).items[0].sessionId,null);
  }finally{await engine.stop();}
});


test('due root and managed schedules reserve existing ownership and launch from the authoritative checkout',async()=>{
  const f=await setup();
  const {AutomationEngine}=await import('../src/lib/automation/engine');
  const {TerminalManager}=await import('../src/lib/terminal/terminal-manager');
  const {createAutomationRuntime,readAutomationSessionSelection}=await import('../src/lib/automation/runtime-adapter');
  const {createReservedAutomationSession}=await import('../src/lib/automation/worktree-target');
  const sessions=await import('../src/lib/db/sessions');
  const {resolveSessionWorkspaceRoot}=await import('../src/lib/session/session-workspace-root');
  const manager=new TerminalManager(()=>{}),engine=new AutomationEngine(f.service,'d003');let spawns=0;
  const runtime=createAutomationRuntime({manager,authority:()=>engine,readSelection:readAutomationSessionSelection,
    createSession:createReservedAutomationSession,
    launch:async request=>{
      const row=sessions.getSession(request.sessionId)!;
      const expected=row.worktree_id===f.rootId?f.workDir:f.managedDir;
      assert.equal(resolveSessionWorkspaceRoot(row.id),expected);assert.equal(row.project_id,f.projectId);
      assert.equal(row.task_id===null,row.worktree_id===f.rootId);assert.equal(row.model,'fixture-model');
      assert.equal(row.service_tier,row.worktree_id===f.rootId?null:'priority');
      const {buildProviderTerminalLaunch}=await import('../src/lib/terminal/provider-launch');
      const launch=buildProviderTerminalLaunch({providerId:row.provider,sessionId:row.id,resume:false,serviceTier:row.service_tier});
      assert.deepEqual(launch.args,row.worktree_id===f.rootId?[]:['--config','service_tier="priority"']);
      assert.equal(sessions.getManagedSessionCallerContext(row.id)?.projectId,f.projectId);
      assert.equal(request.userId,owner);assert.equal(request.expectedAgentEnvironment,'native');assert.equal(request.initialPrompt,'Read fixture');
      request.spawnFence!(()=>spawns++);return {terminalId:`session-${row.id}`,attachedToExistingRuntime:false};
    }});
  f.service.deps.runtime=()=>runtime;
  try{
    await engine.tick();const ids=[];
    for(const id of [f.rootId,f.managedId]){const input=f.input(id);if(id===f.managedId&&input.target.kind==='create-session')input.target.selection.serviceTier='fast';
      ids.push((await f.service.create(owner,id,input)).automation.id);}
    f.setNow(now+60_000);await engine.tick();
    for(const id of ids)assert.equal(f.service.history(owner,id,{}).items[0].state,'delivered');
    assert.equal(spawns,2);
  }finally{await engine.stop();await manager.shutdownAll();}
});

test('restart recovery keeps root/managed reserved Session identity and never resends the scheduled prompt',async()=>{
  const f=await setup();
  const {AutomationEngine}=await import('../src/lib/automation/engine');
  const {TerminalManager}=await import('../src/lib/terminal/terminal-manager');
  const {createAutomationRuntime,readAutomationSessionSelection}=await import('../src/lib/automation/runtime-adapter');
  const {createReservedAutomationSession}=await import('../src/lib/automation/worktree-target');
  const {resolveSessionWorkspaceRoot}=await import('../src/lib/session/session-workspace-root');
  const {recordSessionRuntime}=await import('../src/lib/session/session-runtime-recovery');
  const original=new AutomationEngine(f.service,'original'),oldManager=new TerminalManager(()=>{});
  const runtime=createAutomationRuntime({manager:oldManager,authority:()=>original,readSelection:readAutomationSessionSelection,
    createSession:createReservedAutomationSession,launch:async request=>{
      request.spawnFence!(()=>recordSessionRuntime({sessionId:request.sessionId,userId:owner,running:true}));
      throw new Error('lost owned launch receipt');
    }});
  f.service.deps.runtime=()=>runtime;await original.tick();const ids=[];
  for(const id of [f.rootId,f.managedId]){const input=f.input(id);if(id===f.managedId&&input.target.kind==='create-session')input.target.selection.serviceTier='fast';
      ids.push((await f.service.create(owner,id,input)).automation.id);}
  f.setNow(now+60_000);await original.tick();
  const before=ids.map(id=>f.service.history(owner,id,{}).items[0]);assert.ok(before.every(run=>run.state==='unknown'));
  // Older reserved rows used the frozen names; recovery must launch native semantics.
  for(const run of before)f.db.prepare('UPDATE sessions SET service_tier=? WHERE id=?').run(run.effectiveSelection.serviceTier,run.sessionId!);
  const resumed:string[]=[];
  const manager=new TerminalManager(()=>{},async()=>({spawn:()=>({write(){throw new Error('must not resend');},resize(){},kill(){},onData(){},onExit(){}})}));
  const replacement=new AutomationEngine(f.service,'replacement');
  f.service.deps.runtime=()=>createRuntime;
  const createRuntime=createAutomationRuntime({manager,authority:()=>replacement,readSelection:readAutomationSessionSelection,
    createSession(){throw new Error('must not reserve another Session');},
    canResume:async id=>Boolean(f.db.prepare('SELECT 1 FROM session_runtime_recovery WHERE session_id=? AND user_id=?').get(id,owner)),
    launch:async request=>{
      assert.equal(request.initialPrompt,undefined);assert.equal(request.userId,owner);assert.equal(request.expectedAgentEnvironment,'native');
      const workDir=resolveSessionWorkspaceRoot(request.sessionId)!;assert.ok([f.workDir,f.managedDir].includes(workDir));
      const {buildProviderTerminalLaunch}=await import('../src/lib/terminal/provider-launch');
      const row=f.db.prepare('SELECT service_tier FROM sessions WHERE id=?').get(request.sessionId);
      assert.deepEqual(buildProviderTerminalLaunch({providerId:'codex',sessionId:request.sessionId,resume:false,serviceTier:row.service_tier}).args,workDir===f.workDir?[]:['--config','service_tier="priority"']);
      await manager.startDetached({sessionId:request.sessionId,terminalId:`session-${request.sessionId}`,userId:owner,providerId:'codex',agentEnvironment:'native',
        resolvedShell:{command:'fixture-only',args:[],cwd:workDir},spawnFence:request.spawnFence});
      resumed.push(request.sessionId);return {terminalId:`session-${request.sessionId}`,attachedToExistingRuntime:false};
    }});
  try{
    f.setNow(now+21_000);await replacement.tick();
    assert.deepEqual(resumed.sort(),before.map(run=>run.sessionId!).sort());
    for(const id of ids){const runs=f.service.history(owner,id,{}).items;assert.equal(runs.length,1);assert.equal(runs[0].state,'unknown');
      assert.equal(f.service.detail(owner,id).automation.dispatchCount,1);}
  }finally{await replacement.stop();await original.stop();await manager.shutdownAll();await oldManager.shutdownAll();}
});

test('legacy nullable wake selection can Resume and dispatch unchanged through the public service',async()=>{
  const f=await setup();const {createReservedAutomationSession}=await import('../src/lib/automation/worktree-target');
  const {createAutomationRuntime,readSavedSessionSelection}=await import('../src/lib/automation/runtime-adapter');
  const {sameSessionSelection}=await import('../src/lib/automation/contracts');
  const {TerminalManager}=await import('../src/lib/terminal/terminal-manager');const {AutomationEngine}=await import('../src/lib/automation/engine');
  const {classifyCodexAutomationCompletion}=await import('../src/lib/cli/providers/codex/terminal-hook-lifecycle');
  const target=f.input(f.rootId).target;if(target.kind==='create-session')createReservedAutomationSession('legacy-wake',target);
  f.db.prepare('UPDATE sessions SET model=NULL,reasoning_effort=NULL,service_tier=NULL WHERE id=?').run('legacy-wake');
  assert.equal(readSavedSessionSelection('legacy-wake').serviceTier,null);
  const writes:string[]=[];const manager=new TerminalManager(()=>{},async()=>({spawn:()=>({write:(text:string)=>writes.push(text),resize(){},kill(){},onData(){},onExit(){}})}),undefined,{semanticPromptSubmitDelayMs:1});
  const engine=new AutomationEngine(f.service,'legacy-null');
  const runtime=createAutomationRuntime({manager,authority:()=>engine,readSelection:async(_user,id)=>readSavedSessionSelection(id),
    verifySelection:(_user,id,saved)=>assert.equal(sameSessionSelection(saved,readSavedSessionSelection(id)),true)});
  f.service.deps.runtime=()=>runtime;
  try{
    const rule=(await f.service.create(owner,'legacy-wake',{name:'Legacy',enabled:false,target:{kind:'wake-session',sessionId:'legacy-wake'},
      trigger:{kind:'turn-complete',delayMs:30000},prompt:'Legacy continue',limits:{maxDispatches:2,expiresAt:now+120000}})).automation;
    const stored=f.repo.get(rule.id)!;stored.automation.savedSelection.serviceTier=null;f.repo.save(stored);
    await engine.tick();await manager.create({userId:owner,sessionId:'legacy-wake',terminalId:'legacy-terminal',connectionId:'fixture',surfaceId:'normal',providerId:'codex',agentEnvironment:'native',resolvedShell:{command:'fixture-only',args:[],cwd:f.workDir}});
    let at=Date.now();for(const [hookEvent,status] of [['UserPromptSubmit','running'],['Stop','completed']] as const)
      manager.recordSessionState({type:'session_state',sessionId:'legacy-wake',terminalId:'legacy-terminal',hookEvent,status,stateAt:++at,hasWorkingSubagents:false},owner,classifyCodexAutomationCompletion(hookEvent,status));
    const resumed=await f.service.enable(owner,rule.id,rule.revision);assert.equal(resumed.body.automation.savedSelection.serviceTier,null);
    f.setNow(now+30000);await engine.tick();const run=f.service.history(owner,rule.id,{}).items[0];
    assert.equal(run.state,'delivered');assert.equal(run.effectiveSelection.serviceTier,null);
    assert.deepEqual(writes,['\x1b[200~Legacy continue\x1b[201~','\r']);
  }finally{await engine.stop();await manager.shutdownAll();}
});

test.after(async()=>{const {getDb}=await import('../src/lib/db/database');getDb().close();fs.rmSync(root,{recursive:true,force:true});});
