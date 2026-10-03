import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { wakeInput } from './fixtures/automation';
import { automationPageV2Schema } from '../src/lib/automation/autorun-contracts';

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
      assert.equal(automationPageV2Schema.safeParse(f.service.list('owner-1',{})).success,true,'real list DTO accepts backend activation projection');
      assert.equal(f.calls(), 0);
      const paused = await f.service.pause('owner-1', created.automation.id);
      const resumed = await f.service.enable('owner-1', created.automation.id, paused.body.automation.revision);
      assert.equal(resumed.body.automation.state, 'enabled');
      assert.equal(resumed.body.inputOwnership?.mode, 'human');
      assert.notEqual(resumed.body.activation?.activationId, created.activation?.activationId);
    } finally { await f.close(); }
  }
});

test('no-runtime activation uses the existing fenced same-Session launch; resumed startup has no initial prompt', async () => {
  for (const resume of [false, true]) {
    const f = await autorunFixture();
    try {
      await f.manager.shutdownAll();
      const { TerminalManager } = await import('../src/lib/terminal/terminal-manager');
      const { createAutomationRuntime } = await import('../src/lib/automation/runtime-adapter');
      const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }) }));
      const launches: Array<string | undefined> = [];
      const runtime = createAutomationRuntime({ manager, authority: () => f.engine, now: f.service.deps.now,
        readSelection: async () => (await f.service.deps.inspect('owner-1', {kind:'wake-session',sessionId:'session-1'}, 'wsl')).selection,
        // Native conversation resume identity is queried, independent of historical recovery intent.
        startupCanResume: async () => resume,
        launch: async request => {
          launches.push(request.initialPrompt);
          assert.equal(request.sessionId, 'session-1'); assert.equal(request.mode, 'detached');
          await manager.startDetached({ sessionId: request.sessionId, terminalId: 'session-session-1', userId: request.userId,
            providerId: 'codex', agentEnvironment: 'wsl', resolvedShell: {command:'fixture',args:[],cwd:process.cwd()}, spawnFence: request.spawnFence });
          return {terminalId:'session-session-1',attachedToExistingRuntime:false};
        },
      });
      f.service.deps.runtime = () => runtime;
      const rule = (await f.service.create('owner-1', 'startup', {...wakeInput(), enabled:true})).automation;
      await f.engine.tick(); await f.engine.tick();
      assert.deepEqual(launches, [resume ? undefined : 'Continue the task.']);
      assert.equal(f.service.detail('owner-1', rule.id).automation.dispatchCount, resume ? 0 : 1);
      await manager.shutdownAll();
    } finally { await f.close(); }
  }
});
