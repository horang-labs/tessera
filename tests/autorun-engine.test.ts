import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow, supervisorFinalFixture } from './fixtures/autorun-contracts';

test('qualified completion reserves one persisted supervisor judgment; complete sends no bytes and releases input', async () => {
  const f = await autorunFixture();
  try {
    const created = await f.service.create('owner-1', 'complete', f.input());
    f.setNow(autorunNow+120_110);
    await Promise.all([f.engine.tick(),f.engine.tick()]);await f.engine.tick();
    assert.equal(f.calls(),1);
    const decisions=f.service.autorun.decisions('owner-1',created.automation.id,{}).items;
    assert.equal(decisions.length,1);
    assert.equal(decisions[0].outcome,'complete');
    assert.equal(decisions[0].delivery,'not-requested');
    assert.deepEqual(f.bytes,[]);
    assert.equal(f.service.history('owner-1',created.automation.id,{}).items.length,0);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    const detail=f.service.autorun.decision('owner-1',created.automation.id,decisions[0].id);
    assert.equal(detail.attempts.length,1);
    assert.equal(detail.attempts[0].quiescent,true);
    assert.equal(detail.attention?.identity.outcome,'complete');
  } finally { await f.close(); }
});

for(const outcome of ['continue','complete','needs-user'] as const)test(`changed native captured-content hash rejects a late ${outcome} outcome`,async()=>{
  const f=await autorunFixture();
  try{
    const read=f.provider.readAnalysisContext;let changed=false;
    f.provider.readAnalysisContext=async args=>{
      const result=await read(args);return result.kind==='ok'&&changed?{...result,snapshot:{...result.snapshot,contentHash:'f'.repeat(64)}}:result;
    };
    f.provider.generateSupervisorDecision=async args=>{changed=true;const result=supervisorFinalFixture();
      return {...result,invocationId:args.invocationId,decision:{...result.decision,outcome,
        proposedPrompt:outcome==='continue'?'Verify the remaining login case.':null,blocker:outcome==='needs-user'?'Human clarification needed.':null}};
    };
    const a=(await f.service.create('owner-1',`changed-${outcome}`,f.input())).automation;
    const attention:unknown[]=[];f.service.deps.publishAttention=(_owner,item)=>attention.push(item);
    f.setNow(autorunNow+121_000);await f.engine.tick();
    const [decision]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(decision.outcome,null);assert.equal(decision.reason,'ANALYSIS_STALE');
    assert.deepEqual(f.bytes,[]);assert.equal(f.service.history('owner-1',a.id,{}).items.length,0);
    assert.ok(attention.every(item=>(item as {kind:string}).kind==='rule'));
  }finally{await f.close();}
});

test('continue atomically links one immutable proposal to the existing paste/Enter writer receipt', async () => {
  const f=await autorunFixture();
  try {
    const {supervisorFinalFixture}=await import('./fixtures/autorun-contracts');
    f.provider.generateSupervisorDecision=async args=>({...supervisorFinalFixture(),invocationId:args.invocationId,
      decision:{...supervisorFinalFixture().decision,outcome:'continue',proposedPrompt:'Investigate the remaining login edge case.',
        criterionResults:[{criterionId:'goal',status:'unmet',evidenceIds:['record-2']}]}} as Awaited<ReturnType<typeof f.provider.generateSupervisorDecision>>);
    const a=(await f.service.create('owner-1','continue',f.input())).automation;
    f.setNow(autorunNow+120_110);await f.engine.tick();
    const [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.outcome,'continue');
    const [r]=f.service.history('owner-1',a.id,{}).items;
    assert.equal(r.decisionId,d.id);assert.equal(d.runId,r.id);assert.equal(r.state,'delivered');
    assert.equal(f.engine.loadRun(r.id).prompt,'Investigate the remaining login edge case.');
    assert.deepEqual(f.bytes,['\x1b[200~Investigate the remaining login edge case.\x1b[201~','\r']);
    assert.equal(f.service.detail('owner-1',a.id).automation.dispatchCount,1);
    await f.engine.tick();assert.equal(f.bytes.length,2);
  }finally{await f.close();}
});

test('Pause invalidates an unresolved model promise before a late complete result can publish or write', async () => {
  const f=await autorunFixture();
  try {
    let release!: (value: Awaited<ReturnType<typeof f.provider.generateSupervisorDecision>>)=>void;
    let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);
    f.provider.generateSupervisorDecision=async()=>{started();return new Promise(resolve=>release=resolve);};
    const a=(await f.service.create('owner-1','pause-model',f.input())).automation;
    const attention: unknown[]=[];f.service.deps.publishAttention=(_owner,item)=>attention.push(item);
    f.setNow(autorunNow+120_110);const tick=f.engine.tick();await entered;
    const paused=await f.service.pause('owner-1',a.id);
    assert.equal(paused.status,200);assert.equal(paused.body.inputOwnership?.mode,'human');
    const {supervisorFinalFixture}=await import('./fixtures/autorun-contracts');
    release(supervisorFinalFixture() as Awaited<ReturnType<typeof f.provider.generateSupervisorDecision>>);await tick;
    const [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.phase,'cancelled');assert.equal(d.outcome,null);assert.deepEqual(attention,[]);assert.deepEqual(f.bytes,[]);
    assert.equal(f.service.detail('owner-1',a.id).automation.state,'paused');
  }finally{await f.close();}
});

test('only confirmed exited capacity/service failures retry the same packet and selection after durable 15/60 second backoff', async () => {
  const f=await autorunFixture();
  try{
    const packets:unknown[]=[],selections:unknown[]=[];let calls=0;
    f.provider.generateSupervisorDecision=async args=>{calls++;packets.push(args.packet);selections.push(args.selection);
      return {kind:'capacity',code:'SUPERVISOR_CAPACITY',invocationId:args.invocationId,settlement:{exitCode:1,quiescent:true}};};
    const a=(await f.service.create('owner-1','retry',f.input())).automation;
    f.setNow(autorunNow+120_110);await f.engine.tick();
    let [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.retryAt,autorunNow+135_110);assert.equal(calls,1);
    f.setNow(autorunNow+135_109);await f.engine.tick();assert.equal(calls,1);
    f.setNow(autorunNow+135_110);await f.engine.tick();[d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.retryAt,autorunNow+195_110);assert.equal(calls,2);
    for (let at=145_110;at<=195_110;at+=10_000) { f.setNow(autorunNow+at);f.engine.heartbeat(); }
    await f.engine.tick();assert.equal(calls,3);
    assert.deepEqual(packets[0],packets[1]);assert.deepEqual(packets[1],packets[2]);assert.deepEqual(selections[0],selections[2]);
    const detail=f.service.autorun.decision('owner-1',a.id,d.id);assert.equal(detail.attempts.length,3);
    assert.equal(f.service.detail('owner-1',a.id).automation.state,'paused');assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});

test('a whitespace-equivalent recent delivered proposal escalates to needs-user instead of sending twice', async () => {
  const f=await autorunFixture();
  try{
    const {supervisorFinalFixture}=await import('./fixtures/autorun-contracts');let calls=0;
    f.provider.generateSupervisorDecision=async args=>({...supervisorFinalFixture(),invocationId:args.invocationId,
      decision:{...supervisorFinalFixture().decision,outcome:'continue',proposedPrompt:++calls===1?'Check the login edge case.':'Check  the\nlogin edge case.',
        criterionResults:[{criterionId:'goal',status:'unmet',evidenceIds:['record-2']}]}} as Awaited<ReturnType<typeof f.provider.generateSupervisorDecision>>);
    const a=(await f.service.create('owner-1','loop',f.input())).automation;
    f.setNow(autorunNow+120_110);await f.engine.tick();
    f.complete(f.submit());f.setNow(autorunNow+240_020);await f.engine.tick();
    const decisions=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(decisions.length,2);assert.equal(decisions[0].outcome,'needs-user');assert.equal(decisions[0].reason,'REPEATED_PROPOSAL');
    assert.equal(f.bytes.length,2);assert.equal(f.service.history('owner-1',a.id,{}).items.length,1);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});

test('read accounting or bookkeeping after the cutoff cannot stale an unchanged captured native prefix',async()=>{
  const f=await autorunFixture();
  try{
    const read=f.provider.readAnalysisContext;let completed=false;
    f.provider.readAnalysisContext=async args=>{
      const result=await read(args);return result.kind==='ok'&&completed?{...result,snapshot:{...result.snapshot,
        source:{...result.snapshot.source,bytesScanned:628,scannedRanges:[{startByte:0,endByte:628}]}}}:result;
    };
    const generate=f.provider.generateSupervisorDecision;
    f.provider.generateSupervisorDecision=async args=>{const result=await generate(args);completed=true;return result;};
    const a=(await f.service.create('owner-1','append-bookkeeping',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items[0].outcome,'complete');
    assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});
