import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSupervisorCandidates, defaultSupervisorDependencies } from '../src/lib/cli/providers/autorun-supervisor';
import { AUTORUN_GROUP_WRAPPER } from '../src/lib/cli/providers/autorun-process';
import { autorunInput } from './fixtures/autorun-contracts';
import catalog from '../src/lib/cli/providers/codex/autorun-catalog.json';

test('owned discovery projects large native instructions before the unchanged stdout bound; selected metadata remains complete',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'autorun-discovery-'));
  const command=path.join(root,'fixture-codex.cjs');
  const models=Array.from({length:10},(_,i)=>({...catalog.models[0],slug:i===0?'gpt-6.1-sol':'discovered-'+i,
    base_instructions:'native fixture instruction '.repeat(1600)}));
  assert.ok(Buffer.byteLength(JSON.stringify({models}))>262144);
  const workspace={root,guestRoot:root,command,environment:{},cleanup:async()=>{}};
  const request={userId:'discovery-regression-owner',agentEnvironment:'wsl' as const,provider:'codex' as const};
  try{
    await fs.mkdir(root+'/empty');await fs.writeFile(root+'/group.cjs',AUTORUN_GROUP_WRAPPER);
    await fs.writeFile(command,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify({models}))+');',{mode:0o700});
    const found=await discoverSupervisorCandidates(request,{...defaultSupervisorDependencies,prepare:async()=>workspace});
    assert.equal(found.complete,true);assert.equal(found.candidates.length,10);
    assert.equal(found.candidates[0].model,'gpt-6.1-sol');assert.equal(found.candidates[9].model,'discovered-9');
    const selected=await defaultSupervisorDependencies.probe({...request,selection:autorunInput().autorun.supervisor},workspace,['debug','models']);
    assert.equal(selected.ok,true);
    assert.deepEqual(JSON.parse(selected.stdout).models,[models[0]]);
    const settlement=JSON.parse(await fs.readFile(root+'/settled.json','utf8'));
    assert.equal(settlement.quiescent,true);assert.equal(settlement.containment.terminal,'ECHILD');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
