import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow } from './fixtures/autorun-contracts';

for(const change of ['cutoff','parser','version'] as const)test(`fresh ${change} identity drift rejects even an equal captured digest`,async()=>{
  const f=await autorunFixture();
  try{
    const read=f.provider.readAnalysisContext,generate=f.provider.generateSupervisorDecision;let changed=false;
    f.provider.generateSupervisorDecision=async args=>{const result=await generate(args);changed=true;return result;};
    f.provider.readAnalysisContext=async args=>{
      const result=await read(args);if(result.kind!=='ok'||!changed)return result;
      return {...result,snapshot:{...result.snapshot,
        ...(change==='cutoff'?{cutoff:{...result.snapshot.cutoff,terminalRecordId:'different-final-record'}}:
          change==='parser'?{parserVersion:'different-parser'}:{cliVersion:'different-cli-version'})}};
    };
    const a=(await f.service.create('owner-1',change,f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items[0].outcome,null);
    assert.deepEqual(f.bytes,[]);assert.equal(f.service.history('owner-1',a.id,{}).items.length,0);
  }finally{await f.close();}
});
