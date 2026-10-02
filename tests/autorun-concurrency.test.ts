import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { autorunNow, contextSnapshot, supervisorFinalFixture } from './fixtures/autorun-contracts';
import { AutomationRepository } from '../src/lib/automation/repository';
import { AutomationService } from '../src/lib/automation/service';
import { AutomationEngine } from '../src/lib/automation/engine';
import { DatabaseWrapper } from '../src/lib/db/database';
import type { SupervisorResult } from '../src/lib/automation/autorun-contracts';
const SQLite=require('better-sqlite3');

test('a real SQLite profile permits two owned supervisor calls and one per rule while a second host cannot claim work',async()=>{
  const f=await autorunFixture();let second:DatabaseWrapper|undefined;
  try{
    const ids:string[]=[];
    ids.push((await f.service.create('owner-1','one',f.input())).automation.id);
    for(const n of [2,3]){
      const sessionId=`session-${n}`,terminalId=`terminal-${n}`;
      await f.manager.create({userId:'owner-1',sessionId,terminalId,connectionId:'panel',surfaceId:'normal',providerId:'codex',agentEnvironment:'wsl',
        resolvedShell:{command:'fixture',args:[],cwd:process.cwd()}});
      f.manager.activateProviderSessionIdentity(terminalId,'owner-1','conversation-1');
      const generation=f.manager.automation.observe('owner-1',sessionId)!.generation;
      f.manager.automation.hook('owner-1',sessionId,'UserPromptSubmit','running',autorunNow+1,false);
      const {completionHookId:_hook,...submission}=contextSnapshot().correlation;void _hook;
      const evidence={...submission,serverInstanceId:f.manager.automation.serverInstanceId,terminalGeneration:generation,dedupKey:`submit-${n}`};
      f.runtime.autorun!.recordHookEvidence({kind:'submission',userId:'owner-1',agentEnvironment:'wsl',sessionId,terminalId,observedAt:autorunNow+1,evidence});
      f.runtime.autorun!.recordHookEvidence({kind:'completion',userId:'owner-1',agentEnvironment:'wsl',sessionId,terminalId,observedAt:autorunNow+2,
        evidence:{...evidence,completionHookId:`stop-${n}`,dedupKey:`stop-${n}`}});
      f.manager.automation.hook('owner-1',sessionId,'Stop','completed',autorunNow+3,false,'successful-lead-stop');
      ids.push((await f.service.create('owner-1',`key-${n}`,{...f.input(),target:{kind:'wake-session',sessionId}})).automation.id);
    }
    const filename=f.db.prepare('PRAGMA database_list').all()[0].file as string;
    second=new DatabaseWrapper(new SQLite(filename));const rival=new AutomationEngine(new AutomationService(new AutomationRepository(second),f.service.deps),'rival');
    let entered!:()=>void;const two=new Promise<void>(r=>entered=r),resolvers:Array<()=>void>=[];let active=0,max=0,calls=0;
    f.provider.generateSupervisorDecision=async args=>{
      calls++;active++;max=Math.max(max,active);if(calls===2)entered();
      await new Promise<void>(r=>resolvers.push(r));active--;
      return {...supervisorFinalFixture(),invocationId:args.invocationId} as SupervisorResult;
    };
    f.setNow(autorunNow+121_000);const tick=f.engine.tick();await two;await rival.tick();
    assert.equal(calls,2);assert.equal(max,2);
    for(const id of ids)assert.ok(f.service.autorun.decisions('owner-1',id,{}).items.length<=1);
    resolvers.splice(0).forEach(r=>r());await tick;
    const next=f.engine.tick();while(resolvers.length===0)await new Promise<void>(r=>setImmediate(r));
    resolvers.splice(0).forEach(r=>r());await next;
    assert.equal(calls,3);assert.equal(max,2);assert.deepEqual(f.bytes,[]);
  }finally{second?.close();await f.close();}
});
