import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { wakeInput } from './fixtures/automation';
import { bindNativeAutomationInteraction } from '../src/lib/automation/native-interaction';
import type { NativeApprovalRequest, SupervisorApprovalResult } from '../src/lib/automation/activation-contracts';

test('pending approval inference does not block another Session activation; Pause releases pending hook', async () => {
  const f = await autorunFixture();
  let release!: (value: SupervisorApprovalResult) => void;
  const pending = new Promise<SupervisorApprovalResult>(resolve => { release = resolve; });
  let invocation = '', deferred = 0, submitted = 0;
  try {
    f.manager.automation.dirty('owner-1','session-1',true); f.submit();
    const request: NativeApprovalRequest = {kind:'command',requestId:'request',nativeRequestId:'hook-nonce',requestHash:'a'.repeat(64),
      identity:{...f.manager.automation.readNativeState('owner-1','session-1')!.identity,observationRevision:1},
      operation:{command:'cat marker',cwd:'/owned'},context:{text:'Read owned task input',complete:true},
      options:[{id:'once',effect:'approve-once'},{id:'deny',effect:'deny'}],deadlineAt:f.service.deps.now()+120000};
    f.manager.automation.holdNativeApproval('owner-1','session-1',request);
    f.provider.generateSupervisorApprovalDecision = async args => {invocation=args.invocationId;return pending;};
    await f.manager.create({userId:'owner-1',sessionId:'session-2',terminalId:'terminal-2',connectionId:'peek',surfaceId:'peek',
      providerId:'codex',agentEnvironment:'wsl',resolvedShell:{command:'fixture',args:[],cwd:process.cwd()}});
    const ready = {kind:'ready' as const,empty:true as const,proofVersion:'fixture',
      identity:{...f.manager.automation.readNativeState('owner-1','session-2')!.identity,observationRevision:1}};
    bindNativeAutomationInteraction(f.manager, {
      observe:async scope=>scope.sessionId==='session-1'?{kind:'approval',request}:ready,
      assertCurrent() {},
      deferApproval({scope}) {if(scope.sessionId==='session-1') deferred++;},
      submitPrompt:async args=>{args.writeFence('begin',()=>{submitted++;});args.writeFence('complete',()=>{});
        return {kind:'delivered',sessionId:'session-2',terminalId:'terminal-2',at:f.service.deps.now()};},
      respondApproval:async()=>{throw Error('Paused judgment must not respond');},
    });
    const rule = (await f.service.create('owner-1','approval',f.input())).automation;
    await f.service.create('owner-1','other',{...wakeInput(),enabled:true,target:{kind:'wake-session',sessionId:'session-2'}});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([f.engine.tick(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('approval blocked scheduler')),1000);})]);}
    finally {clearTimeout(timer);}
    assert.equal(submitted,1); assert.ok(invocation);
    await f.service.pause('owner-1',rule.id);
    assert.equal(deferred,1,'Pause immediately releases pre-response hook');
    release({kind:'unavailable',reason:'cancelled',invocationId:invocation,settlement:{exitCode:0,quiescent:true}});
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.service.detail('owner-1',rule.id).automation.dispatchCount,0);
  } finally {
    release?.({kind:'unavailable',reason:'cancelled',invocationId:invocation,settlement:{exitCode:0,quiescent:true}});
    await f.close();
  }
});
