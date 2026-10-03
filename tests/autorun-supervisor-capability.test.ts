import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSupervisorCapability, discoverSupervisorCandidates, supervisorArgs, codexSupervisorControls, type SupervisorDependencies } from '../src/lib/cli/providers/autorun-supervisor';
import { autorunInput, contextSnapshot } from './fixtures/autorun-contracts';
import catalog from '../src/lib/cli/providers/codex/autorun-catalog.json';
import controls from '../src/lib/cli/providers/codex/autorun-controls.json';
function fixture(drift: 'version'|'tool'|'template'|'mcp'|'effort'|'transport'|null=null, model='gpt-6.1-sol') {
  let adapted: Record<string,unknown> = {}, writes=0;
  const native={...catalog.models[0],slug:model,shell_type:'unified_exec',apply_patch_tool_type:'freeform',tool_mode:'code_mode_only',
    experimental_supported_tools:['send_user_message_async','clock'],supports_search_tool:true,node_repl_disabled:false};
  const deps: SupervisorDependencies={
    prepare:async()=>({root:'/owned',guestRoot:'/owned',command:'codex',environment:{},cleanup:async()=>{}}),
    claudeModelMetadata:async()=>null,
    writeCatalog:async(_w,value)=>{adapted=value;writes++;},
    probe:async(r,_w,args)=>{
      let stdout='';
      if(args[0]==='--version')stdout=`codex-cli ${drift==='version'?'0.160.0':'0.159.2'}`;
      else if(args.at(-1)==='list')stdout=controls.filter((_,i)=>i%2).flatMap(s=>{
        const m=s.match(/^features\.([a-z_]+)=(true|false)$/);
        return m?[`${m[1]} stable ${drift==='tool'&&m[1]==='shell_tool'?'true':m[2]}`]:[];
      }).join('\n');
      else if(args[0]==='--tessera-discovery-models')stdout=JSON.stringify({models:[native],complete:true});
      else if(args.at(-1)==='models')stdout=JSON.stringify({models:[args.length===2?native:{...adapted,
        ...(drift==='template'?{model_messages:{instructions_template:'unexpected',permissions:'execute'}}:{}),
        ...(drift==='transport'?{use_responses_lite:!native.use_responses_lite}:{})}]});
      else if(args.at(-1)==='--json')stdout=JSON.stringify(drift==='mcp'?[{name:'server'}]:[]);
      else if(args[0]==='--tessera-config-attestation'){
        const effective:Record<string,any>={};
        for(const c of controls.filter((_,i)=>i%2)){
          const at=c.indexOf('='),keys=c.slice(0,at).split('.');let target=effective;
          for(const key of keys.slice(0,-1))target=target[key]??={};
          target[keys.at(-1)!]=JSON.parse(c.slice(at+1).replace('<scratch>','/owned'));
        }
        if('selection'in r){effective.model_reasoning_effort=drift==='effort'?'low':r.selection.reasoningEffort;effective.service_tier=r.selection.serviceTier;}
        stdout=JSON.stringify({config:effective,layers:[],origins:{}});
      }
      return {ok:true,stdout,stderr:''};
    },
  };
  return {deps,native,writes:()=>writes};
}
const request={userId:'owner',agentEnvironment:'wsl' as const,selection:autorunInput().autorun.supervisor};
test('fresh pinned capability accepts isolation and refuses version/tool/template/MCP/config/transport drift without inference',async()=>{
  assert.equal((await checkSupervisorCapability(request,fixture().deps)).kind,'available');
  for(const drift of ['version','tool','template','mcp','effort','transport'] as const)
    assert.equal((await checkSupervisorCapability(request,fixture(drift).deps)).kind,'unavailable',drift);
});
test('nonhistorical selected model/effort/tier reach adapted catalog and actual invocation argv exactly once',async()=>{
  const f=fixture(null,'gpt-6-astra'),selection={...request.selection,model:'gpt-6-astra',reasoningEffort:'xhigh',serviceTier:'fast' as const};
  const capability=await checkSupervisorCapability({...request,selection},f.deps);
  assert.ok(capability.kind==='available');assert.equal(f.writes(),1);
  const workspace=await f.deps.prepare(request);
  const args=supervisorArgs({...request,selection,capability:capability.capability,invocationId:'inspect-argv',deadlineAt:Date.now()+1000,
    signal:new AbortController().signal,packet:{version:1,objective:{kind:'explicit',text:'Fix',revision:1},criteria:[{id:'goal',text:'Test'}],criterionOrigin:'explicit',constraints:[],context:contextSnapshot(),priorDecisions:[]},outputSchema:{},trustedInstructions:'Judge'},workspace);
  assert.equal(args[args.indexOf('-m')+1],selection.model);
  for(const value of ['model_reasoning_effort="xhigh"','service_tier="fast"'])assert.equal(args.filter(a=>a===value).length,1);
  assert.ok(!args.includes('model_reasoning_effort="high"'));assert.ok(!args.includes('service_tier="default"'));
  assert.deepEqual(args.slice(args.indexOf('-c'),-1),codexSupervisorControls('/owned',selection));
  for(const bad of [{...selection,model:'astra'},{...selection,reasoningEffort:'persistent'}])
    assert.equal((await checkSupervisorCapability({...request,selection:bad},f.deps)).kind,'unavailable');
  const second=await checkSupervisorCapability({...request,selection:{...selection,reasoningEffort:'high'}},f.deps);
  assert.ok(second.kind==='available');assert.notEqual(second.capability.metadataHash,capability.capability.metadataHash);
});
test('discovery returns native candidates without asserting capability, truncates and preserves partial provenance',async()=>{
  const f=fixture();
  const discovered=await discoverSupervisorCandidates({userId:'owner',agentEnvironment:'wsl',provider:'codex'},f.deps);
  assert.equal(discovered.candidates[0].source,'native');assert.equal(f.writes(),0);assert.equal(discovered.complete,true);
  f.deps.probe=async()=>({ok:true,stderr:'',stdout:JSON.stringify({models:Array.from({length:201},(_,i)=>({...f.native,slug:'model-'+i})),complete:true})});
  const truncated=await discoverSupervisorCandidates({userId:'owner',agentEnvironment:'wsl',provider:'codex'},f.deps);
  assert.equal(truncated.candidates.length,200);assert.equal(truncated.complete,false);
});
test('Claude requires exact curated canonical metadata and an audited explicit effort, never a configured alias',async()=>{
  const f=fixture(),selection={provider:'claude-code' as const,model:'claude-opus-4-6',reasoningEffort:'max',serviceTier:null};
  f.deps.probe=async(_r,_w,args)=>({ok:true,stdout:args[0]==='--version'?'2.1.284':'--safe-mode --restricted --tools --strict-mcp-config --permission-prompts',stderr:''});
  f.deps.claudeModelMetadata=async()=>({value:selection.model,label:'Opus',isDefault:false,supportedReasoningEfforts:[{value:'max',label:'Max',description:'Maximum',requiresRestart:true}]});
  assert.equal((await checkSupervisorCapability({...request,selection},f.deps)).kind,'available');
  for(const bad of [{...selection,model:'opus'},{...selection,reasoningEffort:'persistent'}])
    assert.equal((await checkSupervisorCapability({...request,selection:bad},f.deps)).kind,'unavailable');
  f.deps.claudeModelMetadata=async r=>({value:r.selection.model,label:'Custom',isDefault:false,supportedReasoningEfforts:[{value:'persistent',label:'Persistent',description:'Unknown semantics'}]});
  assert.equal((await checkSupervisorCapability({...request,selection:{...selection,reasoningEffort:'persistent'}},f.deps)).kind,'unavailable');
});
test('metadata changing between engine attestation and invocation rejects before any inference launch',async()=>{
  const {generateSupervisorDecision}=await import('../src/lib/cli/providers/autorun-supervisor');
  const f=fixture(),checked=await checkSupervisorCapability(request,f.deps);
  assert.ok(checked.kind==='available');
  const context=contextSnapshot();
  const result=await generateSupervisorDecision({...request,capability:{...checked.capability,metadataHash:'f'.repeat(64)},invocationId:'metadata-drift',
    deadlineAt:Date.now()+10000,signal:new AbortController().signal,trustedInstructions:'Judge',outputSchema:{},
    packet:{version:1,objective:{kind:'explicit',text:'Fix',revision:1},constraints:[],criteria:[{id:'goal',text:'Test'}],criterionOrigin:'explicit',context,priorDecisions:[]}},f.deps);
  assert.equal(result.kind,'unsupported');assert.equal(result.settlement.quiescent,true);
});
