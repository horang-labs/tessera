import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input, selection } from './automation-fixture';

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
