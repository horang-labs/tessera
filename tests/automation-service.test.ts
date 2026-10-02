import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input, selection } from './automation-fixture';

test('owner lists sort newest updates first with stable ID ties before cursor pagination',async()=>{
  const f=fixture();
  try{
    for(const key of ['one','two','three'])await f.service.create('owner',key,input());
    const values=f.service.repo.all().sort((a,b)=>a.automation.id.localeCompare(b.automation.id));
    values.forEach((value,index)=>{value.automation.updatedAt=value.automation.createdAt+(index===0?0:20);f.service.repo.save(value);});
    f.service.repo.save({...values[0],automation:{...values[0].automation,id:'foreign',ownerUserId:'other',updatedAt:values[0].automation.createdAt+100}});
    const expected=[values[1].automation.id,values[2].automation.id,values[0].automation.id];
    assert.deepEqual(f.service.list('owner',{}).items.map(a=>a.id),expected);
    const first=f.service.list('owner',{limit:1});assert.equal(first.items[0].id,expected[0]);
    const second=f.service.list('owner',{limit:1,cursor:first.nextCursor!});assert.equal(second.items[0].id,expected[1]);
    const last=f.service.list('owner',{limit:1,cursor:second.nextCursor!});assert.equal(last.items[0].id,expected[2]);assert.equal(last.nextCursor,null);
    assert.deepEqual(f.service.list('other',{}).items.map(a=>a.id),['foreign']);
  }finally{f.close();}
});

test('creation retries retain original response across edits and deletion; foreign owners cannot read', async () => {
  const f = fixture();
  try {
    const created = await f.service.create('owner', 'key', input());
    assert.equal(created.automation.agentEnvironment, 'wsl');
    await f.service.pause('owner', created.automation.id, true);
    assert.deepEqual(await f.service.create('owner', 'key', input()), created);
    await assert.rejects(f.service.create('owner', 'key', { ...input(), prompt: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.service.list('owner', {}).items.length, 0);
    assert.equal(f.service.list('owner', { includeDeleted: true }).items.length, 1);
    assert.throws(() => f.service.detail('other', created.automation.id), { code: 'NOT_FOUND' });
  } finally { f.close(); }
});

test('editing requires pause and enable uses a new proven takeover; pause/delete remain idempotent while draining', async () => {
  const f = fixture();
  try {
    const wake = { ...input(), target: { kind: 'wake-session' as const, sessionId: 's' }, trigger: { kind: 'turn-complete' as const, delayMs: 30_000 } };
    const created = await f.service.create('owner', 'wake', wake);
    assert.equal(created.inputOwnership?.mode, 'armed');
    await assert.rejects(f.service.edit('owner', created.automation.id, 1, { ...wake, enabled: false }), { code: 'PAUSE_REQUIRED' });
    f.runtime.drain = () => ({ ...f.runtime.ownership('owner', 's'), mode: 'draining' });
    const paused = await f.service.pause('owner', created.automation.id);
    assert.equal(paused.status, 202);
    assert.equal((await f.service.pause('owner', created.automation.id)).body.automation.revision, paused.body.automation.revision);
    await assert.rejects(f.service.enable('owner', created.automation.id, paused.body.automation.revision), { code: 'UNRESOLVED_RUN' });
    f.runtime.drain = () => ({ ...f.runtime.ownership('owner', 's'), mode: 'human', automationId: null });
    const unlocked = await f.service.pause('owner', created.automation.id);
    const edited = await f.service.edit('owner', created.automation.id, unlocked.body.automation.revision, { ...wake, enabled: false, prompt: 'new prompt' });
    const enabled = await f.service.enable('owner', created.automation.id, edited.automation.revision);
    assert.equal(enabled.body.inputOwnership?.mode, 'armed');
    assert.equal(enabled.body.automation.prompt, 'new prompt');
    const deleted = await f.service.pause('owner', created.automation.id, true);
    assert.equal((await f.service.pause('owner', created.automation.id, true)).body.automation.revision, deleted.body.automation.revision);
    await assert.rejects(f.service.enable('owner', created.automation.id, deleted.body.automation.revision), { code: 'NOT_FOUND' });
  } finally { f.close(); }
});

test('concurrent identical creation requests both return the same retained response', async () => {
  const f = fixture();
  try {
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.service.deps.inspect = async () => { waiting++; if (waiting === 2) release(); await gate; return { selection, canonicalWorktreeId: 'wt_test', assertCurrent() {} }; };
    const [a, b] = await Promise.all([f.service.create('owner', 'same', input()), f.service.create('owner', 'same', input())]);
    assert.deepEqual(a, b); assert.equal(f.service.list('owner', {}).items.length, 1);
  } finally { f.close(); }
});
