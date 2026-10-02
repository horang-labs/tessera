import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow } from './fixtures/autorun-contracts';

for(const allowance of [10_000,25])test(`a stalled final capture ends within ${allowance}ms, retains its read and rejects late resolution`,async t=>{
  const f=await autorunFixture();let release!:()=>void,pending:Promise<void>|undefined;
  try{
    const a=(await f.service.create('owner-1','read-timeout',f.input())).automation;
    const read=f.provider.readAnalysisContext,generate=f.provider.generateSupervisorDecision;
    let final=false,reads=0,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    f.provider.generateSupervisorDecision=async args=>{const result=await generate(args);if(allowance===25)f.setNow(args.deadlineAt-allowance);final=true;return result;};
    f.provider.readAnalysisContext=async args=>{
      if(final){reads++;entered();await new Promise<void>(r=>release=r);}return read(args);
    };
    t.mock.timers.enable({apis:['setTimeout']});
    f.setNow(autorunNow+121_000);pending=f.engine.tick();let ended=false;void pending.then(()=>ended=true);await started;
    t.mock.timers.tick(allowance);await new Promise<void>(r=>setImmediate(r));assert.equal(ended,true);await pending;
    const current=f.service.detail('owner-1',a.id).automation;
    assert.equal(current.state,'paused');assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    f.manager.automation.dirty('owner-1','session-1',true);f.complete(f.submit());
    await assert.rejects(f.service.enable('owner-1',a.id,current.revision),{code:'CONTEXT_UNAVAILABLE'});
    assert.equal(reads,1);release();await new Promise<void>(r=>setImmediate(r));
    assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items[0].outcome,null);assert.deepEqual(f.bytes,[]);
    assert.equal(f.service.history('owner-1',a.id,{}).items.length,0);
  }finally{release?.();await pending;t.mock.timers.reset();await f.close();}
});
