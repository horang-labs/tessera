import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunPreviewInputSchema, autorunPreviewSchema } from '../src/lib/automation/autorun-contracts';
import { autorunPreviewFixture, autorunInput } from './fixtures/autorun-contracts';

test('preview accepts an explicit alternate supervisor and distinguishes candidates from checked authority', () => {
  const selection = { ...autorunInput().autorun.supervisor, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  assert.equal(autorunPreviewInputSchema.safeParse({ supervisor: selection }).success, true);
  const preview = { ...autorunPreviewFixture(), supervisorOptions: [], recommendedSupervisor: null,
    supervisorDiscovery: { candidates: [{ provider: 'codex', model: selection.model, label: 'Astra',
      reasoningEfforts: ['high', 'xhigh'], serviceTiers: ['default'], source: 'native', unavailableReason: null }], complete: true },
    supervisorCheck: { selection, status: 'unavailable', reason: 'metadata-drift' } };
  assert.equal(autorunPreviewSchema.safeParse(preview).success, true);
  assert.equal(autorunPreviewSchema.safeParse({ ...preview, supervisorCheck: { selection, status: 'available', reason: null } }).success, false);
});

import { autorunFixture } from './autorun-fixture';
test('preview attests only the explicit choice; rejected choices remain selected without fallback',async()=>{
  const f=await autorunFixture();
  try{
    const requested={...autorunInput().autorun.supervisor,model:'gpt-6-astra',reasoningEffort:'xhigh',serviceTier:'fast' as const};
    const original=f.provider.checkSupervisorCapability,calls:unknown[]=[];
    f.provider.checkSupervisorCapability=async args=>{calls.push(args.selection);return original(args);};
    const preview=await f.service.autorun.preview('owner-1','session-1',{supervisor:requested});
    assert.deepEqual(calls,[requested]);assert.deepEqual(preview.supervisorOptions[0].selection,requested);
    assert.equal(preview.recommendedSupervisor,null);assert.equal(preview.supervisorCheck.status,'available');
    f.provider.checkSupervisorCapability=async args=>{calls.push(args.selection);return {kind:'unavailable',code:'SUPERVISOR_UNSUPPORTED',reason:'metadata-drift'};};
    const rejected=await f.service.autorun.preview('owner-1','session-1',{supervisor:requested});
    assert.deepEqual(rejected.supervisorCheck,{selection:requested,status:'unavailable',reason:'metadata-drift'});
    assert.deepEqual(rejected.supervisorOptions,[]);assert.equal(rejected.recommendedSupervisor,null);assert.equal(calls.length,2);
    const input=f.input();input.autorun.supervisor=requested;
    await assert.rejects(f.service.create('owner-1','reject-selected',input),{code:'SUPERVISOR_UNSUPPORTED'});
    assert.equal(f.calls(),0);assert.deepEqual(calls[2],requested);
  }finally{await f.close();}
});
test('admission and each judgment reattest alternate selection and bind final metadata to the exact capability',async()=>{
  const f=await autorunFixture();
  try{
    const input=f.input(),selected={...input.autorun.supervisor,model:'gpt-6-astra',reasoningEffort:'xhigh'};
    input.autorun.supervisor=selected;
    const check=f.provider.checkSupervisorCapability,generate=f.provider.generateSupervisorDecision,checks:unknown[]=[];
    f.provider.checkSupervisorCapability=async args=>{checks.push(args.selection);return check(args);};
    f.provider.generateSupervisorDecision=async args=>{
      assert.deepEqual(args.selection,selected);assert.deepEqual(args.capability.selection,selected);
      const result=await generate(args);
      assert.ok(result.kind==='ok');return {...result,capability:{...result.capability,metadataHash:'e'.repeat(64)}};
    };
    const rule=(await f.service.create('owner-1','alternate',input)).automation;
    assert.deepEqual(checks,[selected]);f.setNow(rule.createdAt+121000);await f.engine.tick();
    assert.deepEqual(checks,[selected,selected]);assert.equal(f.bytes.length,0);
    assert.equal(f.service.autorun.decisions('owner-1',rule.id,{}).items[0].reason,'SUPERVISOR_INVALID_OUTPUT');
    assert.equal(f.service.detail('owner-1',rule.id).automation.state,'paused');
  }finally{await f.close();}
});
test('Resume rechecks the saved alternate selection and retains it when compatibility disappears',async()=>{
  const f=await autorunFixture();
  try{
    const input=f.input();input.autorun.supervisor={...input.autorun.supervisor,model:'gpt-6-astra',reasoningEffort:'xhigh'};
    const rule=(await f.service.create('owner-1','saved-alternate',input)).automation;
    const paused=await f.service.pause('owner-1',rule.id),calls:unknown[]=[];
    f.provider.checkSupervisorCapability=async args=>{calls.push(args.selection);return {kind:'unavailable',code:'SUPERVISOR_UNSUPPORTED',reason:'version'};};
    const preview=await f.service.autorun.preview('owner-1','session-1');
    assert.deepEqual(preview.supervisorCheck.selection,input.autorun.supervisor);assert.equal(preview.supervisorCheck.reason,'version');
    await assert.rejects(f.service.enable('owner-1',rule.id,paused.body.automation.revision),{code:'SUPERVISOR_UNSUPPORTED'});
    assert.deepEqual(calls,[input.autorun.supervisor,input.autorun.supervisor]);assert.equal(f.calls(),0);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});
