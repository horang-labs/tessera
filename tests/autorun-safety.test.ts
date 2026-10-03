import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow, supervisorFinalFixture } from './fixtures/autorun-contracts';
import type { SupervisorResult } from '../src/lib/automation/autorun-contracts';

const continuation = (invocationId:string,prompt='Check the login edge case.'):SupervisorResult => ({...supervisorFinalFixture(),invocationId,
  decision:{...supervisorFinalFixture().decision,outcome:'continue',proposedPrompt:prompt,
    criterionResults:[{criterionId:'goal',status:'unmet',evidenceIds:['record-2']}]}} as SupervisorResult);

test('Delete before the first writer fence cancels a persisted proposal with zero bytes',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>continuation(args.invocationId);
    const a=(await f.service.create('owner-1','delete-before',f.input())).automation;
    const dispatch=f.runtime.dispatch;
    f.runtime.dispatch=async args=>{await f.service.pause('owner-1',a.id,true);return dispatch(args);};
    f.setNow(autorunNow+121_000);await f.engine.tick();
    assert.deepEqual(f.bytes,[]);
    assert.equal(f.service.history('owner-1',a.id,{}).items[0].state,'cancelled');
    assert.equal(f.service.detail('owner-1',a.id).automation.state,'deleted');
  }finally{await f.close();}
});

test('Pause after paste returns 202 and permits only the owned finishing Enter before input returns',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>continuation(args.invocationId);
    const a=(await f.service.create('owner-1','pause-after',f.input())).automation;
    const original=f.engine.withWriteFence.bind(f.engine);let paused:Promise<unknown>|null=null;
    f.engine.withWriteFence=(permit,phase,write)=>{
      original(permit,phase,write);
      if(phase==='begin') paused=f.service.pause('owner-1',a.id).then(result=>{
        assert.equal(result.status,202);assert.equal(result.body.inputOwnership?.mode,'draining');
        assert.throws(()=>f.manager.write('terminal-1','owner-1','panel','normal','unsafe'),/automation/);
      });
    };
    f.setNow(autorunNow+121_000);await f.engine.tick();await paused;
    assert.equal(f.bytes.length,2);assert.equal(f.bytes[1],'\r');
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    assert.equal(f.service.history('owner-1',a.id,{}).items[0].state,'delivered');
  }finally{await f.close();}
});

for(const kind of ['auth','timeout','uncertain','throw'] as const)test(`${kind} failure never retries and every attempted call consumes lifetime budget`,async()=>{
  const f=await autorunFixture();
  try{
    let calls=0;f.provider.generateSupervisorDecision=async args=>{
      calls++;if(kind==='throw')throw new Error('lost provider receipt');
      return kind==='uncertain'?{kind:'provider-error',code:'SUPERVISOR_PROCESS_UNCERTAIN',invocationId:args.invocationId,settlement:{exitCode:null,quiescent:false}}:
        {kind,code:kind==='auth'?'SUPERVISOR_AUTH':'SUPERVISOR_TIMEOUT',invocationId:args.invocationId,settlement:{exitCode:1,quiescent:true}};
    };
    const a=(await f.service.create('owner-1',kind,f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();f.setNow(autorunNow+241_000);await f.engine.tick();
    assert.equal(calls,1);assert.deepEqual(f.bytes,[]);
    const d=f.service.detail('owner-1',a.id).automation;
    assert.equal('analysisCount' in d&&d.analysisCount,1);assert.equal(d.state,'paused');
    if(kind==='uncertain'||kind==='throw'){
      assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
      assert.equal(f.service.repo.decisions(a.id)[0].active,true);
      f.manager.write('terminal-1','owner-1','panel','normal','manual input',f.runtime.ownership('owner-1','session-1').epoch);
      assert.deepEqual(f.bytes,['manual input']);
      await assert.rejects(f.service.enable('owner-1',a.id,d.revision),{code:'UNRESOLVED_RUN'});
    }
  }finally{await f.close();}
});

test('Pause during ignored supervisor cancellation restores manual input and rejects its late proposal',async()=>{
  const f=await autorunFixture();
  try{
    let release!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r);
    f.provider.generateSupervisorDecision=async args=>{started();await new Promise<void>(r=>release=r);return continuation(args.invocationId);};
    const a=(await f.service.create('owner-1','pause-analysis',f.input())).automation;
    f.setNow(autorunNow+121_000);const pending=f.engine.tick();await entered;
    const paused=await f.service.pause('owner-1',a.id);
    assert.equal(paused.status,200);assert.equal(paused.body.inputOwnership?.mode,'human');
    f.manager.write('terminal-1','owner-1','panel','normal','manual input',f.runtime.ownership('owner-1','session-1').epoch);
    release();await pending;
    assert.deepEqual(f.bytes,['manual input']);
    const [decision]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(decision.outcome,null);assert.equal(decision.phase,'cancelled');
    assert.equal(f.service.history('owner-1',a.id,{}).items.length,0);
  }finally{await f.close();}
});

test('three unchanged assistant/tool analyses stop even when the supervisor claims progress',async()=>{
  const f=await autorunFixture();
  try{
    let calls=0;f.provider.generateSupervisorDecision=async args=>continuation(args.invocationId,`Investigate edge case ${++calls}.`);
    const a=(await f.service.create('owner-1','no-progress',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    for(const at of [241_000,361_000]){f.complete(f.submit());f.setNow(autorunNow+at);await f.engine.tick();}
    const [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(calls,3);assert.equal(d.outcome,'needs-user');assert.equal(d.reason,'NO_PROGRESS');assert.equal(f.bytes.length,4);
  }finally{await f.close();}
});

test('a returned success for a different invocation cannot become a current completion',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async()=>supervisorFinalFixture() as SupervisorResult;
    const a=(await f.service.create('owner-1','foreign-invocation',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    const [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.outcome,null);assert.equal(d.reason,'SUPERVISOR_PROCESS_UNCERTAIN');assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});

test('untyped native input requirement preserves enabled intent and exposes manual waiting without inference',async()=>{
  const f=await autorunFixture();
  try{
    const a=(await f.service.create('owner-1','approval-attention',f.input())).automation;
    f.manager.automation.hook('owner-1','session-1','PermissionRequest','input_required',autorunNow+200,false);
    const current=f.service.detail('owner-1',a.id);
    assert.equal(current.automation.state,'enabled');assert.equal(current.activation?.reason,'approval-needs-user');
    assert.equal(f.service.list('owner-1',{}).items[0].activation?.reason,'approval-needs-user');
    assert.equal(f.calls(),0);assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items.length,0);assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});

test('saved worker selection drift pauses before any model call, including a would-be completion',async()=>{
  const f=await autorunFixture();
  try{
    const a=(await f.service.create('owner-1','worker-drift',f.input())).automation;
    const selected=(await f.service.deps.inspect('owner-1',a.target,'wsl')).selection;
    selected.model='changed-worker-model';
    f.setNow(autorunNow+121_000);await f.engine.tick();
    assert.equal(f.calls(),0);assert.equal(f.service.detail('owner-1',a.id).automation.state,'paused');
    assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items.length,0);assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});
