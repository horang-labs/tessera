import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { decodeAutomation } from '../src/lib/automation/autorun-contracts';

test('owner can admit a v2 Autorun with server-authored objective and no model call on Start', async () => {
  const f = await autorunFixture();
  try {
    const result = await f.service.create('owner-1', 'start', f.input());
    const decoded = decodeAutomation(result.automation);
    assert.equal(decoded.success, true);
    if (!decoded.success || decoded.data.mode !== 'autorun') throw new Error('Autorun expected');
    assert.deepEqual(decoded.data.autorun.objective, { kind: 'explicit', text: 'Fix login and verify the regression.', revision: 1 });
    assert.equal(result.inputOwnership?.mode, 'human');
    assert.equal(f.calls(), 0);
    assert.equal((await f.service.create('owner-1', 'start', f.input())).automation.id, result.automation.id);
  } finally { await f.close(); }
});

test('first accepted running turn can Start without a completed snapshot; consumed idle Resume retains human ownership', async () => {
  const f=await autorunFixture();
  try {
    f.manager.automation.dirty('owner-1','session-1',true);f.submit();
    let reads=0;const original=f.provider.readAnalysisContext;
    f.provider.readAnalysisContext=async args=>{reads++;return original(args);};
    const preview=await f.service.autorun.preview('owner-1','session-1');
    assert.equal(preview.readiness.kind,'running');assert.equal(reads,0);
    const a=(await f.service.create('owner-1','first-running',f.input())).automation;
    assert.equal(reads,0);
    const turn=f.runtime.autorun!.readTurnEvidence({userId:'owner-1',agentEnvironment:'wsl',sessionId:'session-1'});
    if(turn.kind!=='running') throw new Error('running required');
    f.complete({...turn.submission,completionHookId:'stop'});
    f.setNow(a.createdAt+121_000);await f.engine.tick();
    const detail=f.service.detail('owner-1',a.id);
    const idle=await f.service.autorun.preview('owner-1','session-1');
    assert.equal(idle.readiness.kind,'idle');
    const resumed = await f.service.enable('owner-1',a.id,detail.automation.revision);
    assert.equal(resumed.body.automation.state,'enabled');
    assert.equal(resumed.body.activation?.phase,'waiting');
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});

test('Resume preserves explicitly authorized intent without requiring a new transcript read',async()=>{
  const f=await autorunFixture();
  try{
    const a=(await f.service.create('owner-1','conflict',f.input())).automation;
    const paused=await f.service.pause('owner-1',a.id);
    const evidence=f.provider.readAutorunEvidence;
    f.provider.readAutorunEvidence=async args=>{
      const value=await evidence(args);if(value.kind!=='ok'||value.goal.kind!=='verified')throw new Error('verified fixture');
      return {...value,goal:{kind:'conflicting',sources:value.goal.objective.sources},newHumanInstructions:value.goal.objective.sources};
    };
    const resumed = await f.service.enable('owner-1',a.id,paused.body.automation.revision);
    assert.equal(resumed.body.automation.state,'enabled');
    const pausedAgain = await f.service.pause('owner-1',a.id);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
    const edited=await f.service.edit('owner-1',a.id,pausedAgain.body.automation.revision,{...f.input(),enabled:false,
      autorun:{...f.input().autorun,objective:{kind:'explicit',text:'Resolved objective: preserve the new human correction.'}}});
    assert.equal(edited.automation.state,'disabled');
  }finally{await f.close();}
});

test('unchanged explicit objective Resume preserves saved revision without reading native records',async()=>{
  const f=await autorunFixture();
  try{
    const a=(await f.service.create('owner-1','source-identity',f.input())).automation;
    const paused=await f.service.pause('owner-1',a.id);
    f.provider.readAutorunEvidence=async()=>{throw Error('explicit Resume must not read transcript');};
    const resumed=await f.service.enable('owner-1',a.id,paused.body.automation.revision);
    if(resumed.body.automation.mode!=='autorun')throw new Error('Autorun expected');
    assert.deepEqual(resumed.body.automation.autorun.objective,{kind:'explicit',text:'Fix login and verify the regression.',revision:1});
    assert.equal(f.calls(),0);
  }finally{await f.close();}
});
