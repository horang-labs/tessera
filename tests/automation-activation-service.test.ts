import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { wakeInput } from './fixtures/automation';

test('valid fresh Heartbeat and explicit Autorun enable intent without taking input or reading a transcript', async () => {
  for (const mode of ['heartbeat', 'autorun']) {
    const f = await autorunFixture();
    try {
      f.manager.automation.started('owner-1', 'session-1', 'terminal-1', 2, 'codex', 'wsl');
      f.provider.readAutorunEvidence = async () => { throw Error('no worker transcript required'); };
      f.provider.checkSupervisorCapability = async () => { throw Error('execution check belongs to engine'); };
      const input = mode === 'autorun' ? f.input() : { ...wakeInput(), enabled: true };
      const created = await f.service.create('owner-1', mode, input);
      assert.equal(created.automation.state, 'enabled');
      assert.equal(created.inputOwnership?.mode, 'human');
      assert.equal(created.activation?.phase, 'waiting');
      assert.equal(f.calls(), 0);
      const paused = await f.service.pause('owner-1', created.automation.id);
      const resumed = await f.service.enable('owner-1', created.automation.id, paused.body.automation.revision);
      assert.equal(resumed.body.automation.state, 'enabled');
      assert.equal(resumed.body.inputOwnership?.mode, 'human');
      assert.notEqual(resumed.body.activation?.activationId, created.activation?.activationId);
    } finally { await f.close(); }
  }
});
