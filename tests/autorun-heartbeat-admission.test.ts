import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow } from './fixtures/autorun-contracts';

function heartbeat(f:Awaited<ReturnType<typeof autorunFixture>>,enabled=true){
  const {autorun:_autorun,...base}=f.input();void _autorun;
  return {...base,enabled,mode:'heartbeat',prompt:'Continue with the fixed instruction.'};
}

test('eligible Heartbeat admission and delivery remain usable when Autorun supervisor capability is absent',async()=>{
  const f=await autorunFixture();
  try{
    f.service.deps.provider=()=>null;
    const a=(await f.service.create('owner-1','heartbeat-only',heartbeat(f))).automation;
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    f.setNow(autorunNow+121_000);await f.engine.tick();
    assert.equal(f.service.history('owner-1',a.id,{}).items[0].state,'delivered');
    assert.equal(f.calls(),0);assert.equal(f.bytes.length,2);
  }finally{await f.close();}
});

test('a consumed Autorun idle boundary cannot be rearmed by Heartbeat replacement even with absent supervisor',async()=>{
  const f=await autorunFixture();
  try{
    const a=(await f.service.create('owner-1','complete-autorun',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();await f.service.pause('owner-1',a.id,true);
    f.service.deps.provider=()=>null;
    const replacement=(await f.service.create('owner-1','replacement',heartbeat(f,false))).automation;
    const enabled=await f.service.enable('owner-1',replacement.id,replacement.revision);
    assert.equal(enabled.body.automation.state,'enabled');
    await f.engine.tick(); assert.equal(f.service.history('owner-1',replacement.id,{}).items.length,0);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');assert.deepEqual(f.bytes,[]);
  }finally{await f.close();}
});
