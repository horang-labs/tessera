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
    assert.equal(result.inputOwnership?.mode, 'armed');
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
    await assert.rejects(f.service.enable('owner-1',a.id,detail.automation.revision),{code:'INPUT_BOUNDARY_UNPROVEN'});
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});
