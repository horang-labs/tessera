import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow } from './fixtures/autorun-contracts';
import { AutomationEngine } from '../src/lib/automation/engine';
import type { SupervisorSettlementObservation } from '../src/lib/automation/autorun-contracts';

test('restart reconciliation releases only verified owned invocation capacity, retains counts/ledger and requires explicit fresh-turn Resume',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>({kind:'provider-error',code:'SUPERVISOR_PROCESS_UNCERTAIN',invocationId:args.invocationId,
      settlement:{exitCode:null,quiescent:false}});
    const a=(await f.service.create('owner-1','settlement',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    const invocation=f.service.repo.decisions(a.id)[0].detail.attempts[0].invocationId;
    let proof:SupervisorSettlementObservation={version:1,userId:'owner-1',agentEnvironment:'wsl',invocationId:invocation,observedAt:autorunNow+151_000,
      kind:'unknown',code:'SUPERVISOR_PROCESS_UNCERTAIN',reason:'active'};
    f.provider.observeSupervisorSettlement=async args=>{assert.deepEqual(args,{version:1,userId:'owner-1',agentEnvironment:'wsl',invocationId:invocation});return proof;};
    f.setNow(autorunNow+151_000);const replacement=new AutomationEngine(f.service,'replacement');await replacement.tick();
    assert.equal(f.service.repo.decisions(a.id)[0].active,true);assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    proof={version:1,userId:'owner-1',agentEnvironment:'wsl',invocationId:invocation,observedAt:autorunNow+151_000,kind:'quiescent',code:'SUPERVISOR_QUIESCENT',proof:{kind:'owned-invocation-closed',launchId:'owned-launch',closedAt:autorunNow+122_000,settledAt:autorunNow+150_000}};
    await replacement.tick();
    const retained=f.service.repo.decisions(a.id)[0];assert.equal(retained.active,false);assert.equal(retained.detail.attempts[0].quiescent,true);
    assert.equal(retained.settlementObservations?.[invocation].proof.launchId,'owned-launch');
    await replacement.tick();assert.deepEqual(f.service.repo.decisions(a.id)[0].settlementObservations,retained.settlementObservations);
    assert.equal(retained.detail.outcome,null);assert.equal(retained.detail.runId,null);assert.deepEqual(f.bytes,[]);
    const current=f.service.detail('owner-1',a.id).automation;assert.equal(current.state,'paused');
    assert.equal('analysisCount' in current&&current.analysisCount,1);
    await assert.rejects(f.service.enable('owner-1',a.id,current.revision),{code:'INPUT_BOUNDARY_UNPROVEN'});
    f.manager.automation.dirty('owner-1','session-1',true);f.submit();
    const resumed=await f.service.enable('owner-1',a.id,current.revision);assert.equal(resumed.body.automation.state,'enabled');
    await replacement.tick();assert.equal(f.service.repo.decisions(a.id).length,1);
    await replacement.stop();
  }finally{await f.close();}
});

test('a stalled settlement observation retains ownership of one read and cannot accumulate replacement requests',async t=>{
  const f=await autorunFixture();let release!:()=>void;
  try{
    f.provider.generateSupervisorDecision=async args=>({kind:'provider-error',code:'SUPERVISOR_PROCESS_UNCERTAIN',invocationId:args.invocationId,
      settlement:{exitCode:null,quiescent:false}});
    const a=(await f.service.create('owner-1','observe-timeout',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();await f.service.pause('owner-1',a.id,true);
    f.manager.automation.dirty('owner-1','session-1',true);f.complete(f.submit());
    let reads=0,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    f.provider.observeSupervisorSettlement=async args=>{reads++;entered();await new Promise<void>(r=>release=r);
      return {...args,observedAt:autorunNow+151_000,kind:'unknown',code:'SUPERVISOR_PROCESS_UNCERTAIN',reason:'incomplete'};
    };
    t.mock.timers.enable({apis:['setTimeout']});
    const create=f.service.create('owner-1','replacement-timeout',f.input());const rejected=assert.rejects(create,{code:'UNRESOLVED_RUN'});
    await started;t.mock.timers.tick(10_000);await rejected;
    await assert.rejects(f.service.create('owner-1','replacement-again',f.input()),{code:'UNRESOLVED_RUN'});
    assert.equal(reads,1);assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    release();await new Promise<void>(r=>setImmediate(r));assert.equal(f.service.repo.decisions(a.id)[0].active,true);
  }finally{release?.();t.mock.timers.reset();await f.close();}
});

test('supervisor quiescence never releases an existing unknown worker-write hold',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>({kind:'provider-error',code:'SUPERVISOR_PROCESS_UNCERTAIN',invocationId:args.invocationId,
      settlement:{exitCode:null,quiescent:false}});
    const a=(await f.service.create('owner-1','worker-hold',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    f.manager.automation.recover('owner-1','session-1','prior-worker-rule','unknown-worker-run');
    f.provider.observeSupervisorSettlement=async args=>({...args,observedAt:autorunNow+151_000,kind:'quiescent',code:'SUPERVISOR_QUIESCENT',
      proof:{kind:'owned-invocation-closed',launchId:'owned-launch',closedAt:autorunNow+122_000,settledAt:autorunNow+150_000}});
    await f.engine.tick();assert.equal(f.service.repo.decisions(a.id)[0].active,false);
    const ownership=f.runtime.ownership('owner-1','session-1');assert.equal(ownership.mode,'recovery-required');assert.equal(ownership.runId,'unknown-worker-run');
    assert.throws(()=>f.manager.write('terminal-1','owner-1','panel','normal','unsafe',ownership.epoch),{code:'INPUT_OWNED_BY_AUTOMATION'});
  }finally{await f.close();}
});

for(const disposition of ['wrong-owner','wrong-environment','wrong-invocation','malformed','old-proof','throw'] as const)test(`${disposition} observation cannot release quarantine or authorize a replacement rule`,async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>({kind:'provider-error',code:'SUPERVISOR_PROCESS_UNCERTAIN',invocationId:args.invocationId,
      settlement:{exitCode:null,quiescent:false}});
    const a=(await f.service.create('owner-1',disposition,f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();await f.service.pause('owner-1',a.id,true);
    f.provider.observeSupervisorSettlement=async args=>{
      if(disposition==='throw')throw new Error('unavailable');
      return {version:1,userId:disposition==='wrong-owner'?'foreign':args.userId,agentEnvironment:disposition==='wrong-environment'?'native':args.agentEnvironment,
        invocationId:disposition==='wrong-invocation'?'foreign':args.invocationId,observedAt:autorunNow+151_000,kind:'quiescent',code:'SUPERVISOR_QUIESCENT',
        proof:{kind:disposition==='malformed'?'empty-scan':'owned-invocation-closed',launchId:'owned-launch',closedAt:disposition==='old-proof'?autorunNow:autorunNow+122_000,settledAt:autorunNow+150_000}} as SupervisorSettlementObservation;
    };
    f.manager.automation.dirty('owner-1','session-1',true);f.complete(f.submit());
    await assert.rejects(f.service.create('owner-1',`replacement-${disposition}`,f.input()),{code:'UNRESOLVED_RUN'});
    assert.equal(f.service.repo.decisions(a.id)[0].active,true);assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});
