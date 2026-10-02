import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { autorunFixture } from './autorun-fixture';
import { autorunInput } from './fixtures/autorun-contracts';

test('authenticated HTTP admits genuine v2 Autorun and rejects forged, unauthorized and unavailable configurations', async () => {
  const f = await autorunFixture('electron-local-user');
  const dir = await fs.mkdtemp(path.resolve('tmp/autorun-auth-'));
  const previous = { data: process.env.TESSERA_DATA_DIR, electron: process.env.TESSERA_ELECTRON_RUNTIME };
  process.env.TESSERA_DATA_DIR = dir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  try {
    const { NextRequest } = await import('next/server');
    const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
    const { handleAutomationRequest } = await import('../src/app/api/automations/handler');
    const secret = await ensureAppSecret();
    f.service.deps.owner = async () => ({ userId: 'electron-local-user', agentEnvironment: 'wsl' });
    const request = new NextRequest('http://localhost:3100/api/automations', { method: 'POST',
      headers: { host: 'localhost:3100', origin: 'http://localhost:3100', 'content-type': 'application/json',
        'idempotency-key': 'autorun-contract-characterization', [APP_SECRET_HEADER]: secret },
      body: JSON.stringify({ ...autorunInput(), enabled:true }) });
    const result = await handleAutomationRequest(request, { action: 'create' }, f.service);
    assert.equal(result.status,201);
    const saved=await result.json();assert.equal(saved.automation.mode,'autorun');assert.equal(saved.inputOwnership.mode,'armed');
    assert.equal(f.calls(),0);
    const make=(value:unknown,authenticated=true)=>new NextRequest('http://localhost:3100/api/automations',{method:'POST',headers:{
      host:'localhost:3100',origin:'http://localhost:3100','content-type':'application/json','idempotency-key':'other',
      ...(authenticated?{[APP_SECRET_HEADER]:secret}:{})},body:JSON.stringify(value)});
    assert.equal((await handleAutomationRequest(make(autorunInput(),false),{action:'create'},f.service)).status,401);
    const forged={...autorunInput(),autorun:{...autorunInput().autorun,objective:{kind:'verified-human',text:'fake',revision:1,sources:[]}}};
    assert.equal((await handleAutomationRequest(make(forged),{action:'create'},f.service)).status,400);
    f.service.deps.provider=()=>null;
    assert.equal((await handleAutomationRequest(make(autorunInput()),{action:'create'},f.service)).status,422);
    const list=f.service.list('electron-local-user',{}).items;assert.equal(list.length,1);assert.equal('autorun' in list[0],false);
  } finally {
    if (previous.data === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous.data;
    if (previous.electron === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME; else process.env.TESSERA_ELECTRON_RUNTIME = previous.electron;
    await f.close(); await fs.rm(dir, { recursive: true });
  }
});

test('owner-only preview/history/detail use production auth and origin gates; only decision detail includes the packet',async()=>{
  const f=await autorunFixture('electron-local-user');
  const dir=await fs.mkdtemp(path.resolve('tmp/autorun-http-'));
  const previous={data:process.env.TESSERA_DATA_DIR,electron:process.env.TESSERA_ELECTRON_RUNTIME};
  process.env.TESSERA_DATA_DIR=dir;process.env.TESSERA_ELECTRON_RUNTIME='1';
  try{
    const {NextRequest}=await import('next/server');
    const {ensureAppSecret,APP_SECRET_HEADER}=await import('../src/lib/auth/app-secret');
    const {handleAutomationRequest}=await import('../src/app/api/automations/handler');
    const secret=await ensureAppSecret();
    const req=(method='GET',body?:unknown,origin='http://localhost:3100')=>new NextRequest('http://localhost:3100/api/automations',{
      method,headers:{host:'localhost:3100',origin,[APP_SECRET_HEADER]:secret,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const preview=await handleAutomationRequest(req('POST',{}),{action:'preview',id:'session-1'},f.service);
    assert.equal(preview.status,200);assert.equal(f.calls(),0);assert.equal(f.runtime.ownership('electron-local-user','session-1').mode,'human');
    assert.equal((await handleAutomationRequest(req('POST',{} ,'https://foreign.test'),{action:'preview',id:'session-1'},f.service)).status,403);
    assert.equal((await handleAutomationRequest(req('POST',{ownerUserId:'fake'}),{action:'preview',id:'session-1'},f.service)).status,400);
    const a=(await f.service.create('electron-local-user','http-decision',f.input())).automation;
    f.setNow(a.createdAt+121_000);await f.engine.tick();
    const history=await handleAutomationRequest(req(),{action:'decisions',id:a.id},f.service);
    assert.equal(history.status,200);const page=await history.json();assert.equal('packet' in page.items[0],false);assert.equal('decision' in page.items[0],false);
    const detail=await handleAutomationRequest(req(),{action:'decision',id:a.id,decisionId:page.items[0].id},f.service);
    assert.equal(detail.status,200);assert.equal((await detail.json()).packet.objective.kind,'explicit');
    assert.equal((await handleAutomationRequest(req(),{action:'decision',id:'foreign',decisionId:page.items[0].id},f.service)).status,404);
    f.service.deps.owner=async()=>({userId:'another-owner',agentEnvironment:'wsl'});
    assert.equal((await handleAutomationRequest(req(),{action:'decision',id:a.id,decisionId:page.items[0].id},f.service)).status,403);
    f.service.deps.owner=async()=>({userId:'electron-local-user',agentEnvironment:'wsl'});
  }finally{
    if(previous.data===undefined)delete process.env.TESSERA_DATA_DIR;else process.env.TESSERA_DATA_DIR=previous.data;
    if(previous.electron===undefined)delete process.env.TESSERA_ELECTRON_RUNTIME;else process.env.TESSERA_ELECTRON_RUNTIME=previous.electron;
    await f.close();await fs.rm(dir,{recursive:true});
  }
});
