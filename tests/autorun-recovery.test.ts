import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow } from './fixtures/autorun-contracts';
import { AutomationEngine } from '../src/lib/automation/engine';

test('a different backend lease interrupts retained analysis and never replays its packet or completed boundary',async()=>{
  const f=await autorunFixture();
  try{
    let release!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r);
    const original=f.provider.generateSupervisorDecision;
    f.provider.generateSupervisorDecision=async args=>{started();await new Promise<void>(r=>release=r);return original(args);};
    const a=(await f.service.create('owner-1','restart',f.input())).automation;
    f.setNow(autorunNow+121_000);const pending=f.engine.tick();await entered;
    // Simulate a new backend claiming the durable lease; ordinary startup must not relaunch the model.
    f.setNow(autorunNow+151_000);const restarted=new AutomationEngine(f.service,'replacement');await restarted.tick();
    release();await pending;
    const [d]=f.service.autorun.decisions('owner-1',a.id,{}).items;
    assert.equal(d.phase,'interrupted');assert.equal(d.outcome,null);assert.deepEqual(f.bytes,[]);
    const current=f.service.detail('owner-1',a.id);
    assert.equal(current.automation.state,'paused');
    await assert.rejects(f.service.enable('owner-1',a.id,current.automation.revision),{code:'INPUT_BOUNDARY_UNPROVEN'});
    await restarted.tick();assert.equal(f.calls(),1);
  }finally{await f.close();}
});

test('editing a paused Autorun preserves failed call budget and prohibits Heartbeat conversion',async()=>{
  const f=await autorunFixture();
  try{
    f.provider.generateSupervisorDecision=async args=>({kind:'auth',code:'SUPERVISOR_AUTH',invocationId:args.invocationId,settlement:{quiescent:true,exitCode:1}});
    const a=(await f.service.create('owner-1','lifetime',f.input())).automation;
    f.setNow(autorunNow+121_000);await f.engine.tick();
    const current=f.service.detail('owner-1',a.id).automation;
    const edited=await f.service.edit('owner-1',a.id,current.revision,{...f.input(),enabled:false,autorun:{...f.input().autorun,maxAnalyses:1}});
    assert.equal('analysisCount' in edited.automation&&edited.automation.analysisCount,1);
    await assert.rejects(f.service.enable('owner-1',a.id,edited.automation.revision),{code:'ANALYSIS_LIMIT'});
    await assert.rejects(f.service.edit('owner-1',a.id,edited.automation.revision,{...f.input(),enabled:false,mode:'heartbeat',prompt:'Repeat'}),{code:'INVALID_AUTOMATION'});
    assert.equal(f.service.autorun.decisions('owner-1',a.id,{}).items.length,1);
  }finally{await f.close();}
});
