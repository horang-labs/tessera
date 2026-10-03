import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';

test('preview can omit both inventories while still reading fresh evidence and attesting the exact selected supervisor',async()=>{
  const f=await autorunFixture();
  try{
    let inventories=0,contexts=0;const selections:unknown[]=[];
    const read=f.provider.readAnalysisContext,check=f.provider.checkSupervisorCapability;
    f.provider.discoverSupervisors=async()=>{inventories++;throw Error('inventory must be skipped');};
    f.provider.readAnalysisContext=async args=>{contexts++;return read(args);};
    f.provider.checkSupervisorCapability=async args=>{selections.push(args.selection);assert.equal(args.userId,'owner-1');assert.equal(args.agentEnvironment,'wsl');return check(args);};
    const selected={...f.input().autorun.supervisor,model:'gpt-6-astra',reasoningEffort:'xhigh'};
    const preview=await f.service.autorun.preview('owner-1','session-1',{includeSupervisorDiscovery:false,supervisor:selected});
    assert.equal(inventories,0);assert.equal(contexts,1);assert.deepEqual(selections,[selected]);
    assert.deepEqual(preview.supervisorDiscovery,{candidates:[],complete:false});
    assert.deepEqual(preview.supervisorCheck,{selection:selected,status:'available',reason:null});
    assert.deepEqual(preview.supervisorOptions[0].selection,selected);assert.equal(preview.readiness.kind,'completed');assert.equal(f.calls(),0);
  }finally{await f.close();}
});
test('omitted inventory with no concrete saved/requested/worker supervisor preserves running readiness and returns unselected',async()=>{
  const f=await autorunFixture();
  try{
    const inspect=f.service.deps.inspect;
    f.service.deps.inspect=async(...args)=>{const current=await inspect(...args);return {...current,selection:{...current.selection,model:null,reasoningEffort:null,serviceTier:null}};};
    let checks=0;f.provider.checkSupervisorCapability=async()=>{checks++;throw Error('no chosen supervisor');};
    f.manager.automation.dirty('owner-1','session-1',true);f.submit();
    const preview=await f.service.autorun.preview('owner-1','session-1',{includeSupervisorDiscovery:false});
    assert.equal(checks,0);assert.equal(preview.readiness.kind,'running');
    assert.deepEqual(preview.supervisorCheck,{selection:null,status:'unselected',reason:null});
    assert.deepEqual(preview.supervisorDiscovery,{candidates:[],complete:false});
    assert.deepEqual(preview.supervisorOptions,[]);assert.equal(preview.recommendedSupervisor,null);
  }finally{await f.close();}
});
test('Start and Resume save selected intent without inventories or execution attestation',async()=>{
  const f=await autorunFixture();
  try{
    let inventories=0;const selections:unknown[]=[],check=f.provider.checkSupervisorCapability;
    f.provider.discoverSupervisors=async()=>{inventories++;throw Error('admission inventory');};
    f.provider.checkSupervisorCapability=async args=>{selections.push(args.selection);return check(args);};
    const input=f.input();input.autorun.supervisor={...input.autorun.supervisor,model:'gpt-6-astra',reasoningEffort:'xhigh'};
    const rule=(await f.service.create('owner-1','fast-start',input)).automation;
    assert.equal(inventories,0);assert.deepEqual(selections,[]);
    const paused=await f.service.pause('owner-1',rule.id);
    const resumed=await f.service.enable('owner-1',rule.id,paused.body.automation.revision);
    assert.equal(resumed.body.automation.state,'enabled');assert.equal(inventories,0);
    assert.deepEqual(selections,[]);
    const again=await f.service.pause('owner-1',rule.id);
    f.provider.checkSupervisorCapability=async args=>{selections.push(args.selection);return {kind:'unavailable',code:'SUPERVISOR_UNSUPPORTED',reason:'metadata-drift'};};
    const waiting=await f.service.enable('owner-1',rule.id,again.body.automation.revision);
    assert.equal(waiting.body.automation.state,'enabled');
    assert.equal(inventories,0);assert.deepEqual(selections,[]);assert.equal(f.calls(),0);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});
test('existing preview callers retain inventory discovery by default and can still explicitly request it',async()=>{
  const f=await autorunFixture();
  try{
    let inventories=0;const discover=f.provider.discoverSupervisors!;
    f.provider.discoverSupervisors=async args=>{inventories++;return discover(args);};
    for(const overrides of [{},{includeSupervisorDiscovery:true}]){
      const preview=await f.service.autorun.preview('owner-1','session-1',overrides);
      assert.equal(preview.supervisorDiscovery.complete,true);assert.equal(preview.supervisorDiscovery.candidates.length,1);
      assert.equal(preview.supervisorCheck.status,'available');
    }
    assert.equal(inventories,4);
  }finally{await f.close();}
});
test('saving and Start while idle need no accepted turn; execution readiness remains separate',async()=>{
  const f=await autorunFixture();
  try{
    let inventories=0;f.provider.discoverSupervisors=async()=>{inventories++;throw Error('admission inventory');};
    f.manager.automation.dirty('owner-1','session-1');
    const input=f.input();
    const preview=await f.service.autorun.preview('owner-1','session-1',{includeSupervisorDiscovery:false,supervisor:input.autorun.supervisor,objectiveOverride:input.autorun.objective.text});
    assert.deepEqual(preview.readiness,{kind:'idle',reason:'no-accepted-turn'});assert.equal(preview.supervisorCheck.status,'available');
    const started=await f.service.create('owner-1','idle-start',input);
    assert.equal(started.automation.state,'enabled'); assert.equal(started.activation?.phase,'waiting');
    await f.service.pause('owner-1',started.automation.id,true);
    const saved=(await f.service.create('owner-1','idle-save',{...input,enabled:false})).automation;
    assert.equal(saved.state,'disabled');assert.equal(inventories,0);assert.equal(f.calls(),0);
    assert.equal(f.runtime.ownership('owner-1','session-1').mode,'human');
  }finally{await f.close();}
});
