import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { wakeInput } from './fixtures/automation';
import { bindNativeAutomationInteraction } from '../src/lib/automation/native-interaction';
import type { NativeInteraction, ReadyPromptEvidence } from '../src/lib/automation/activation-contracts';

test('fresh enabled Heartbeat and Autorun submit saved instruction once through fenced native port', async () => {
  for (const mode of ['heartbeat', 'autorun']) {
    const f = await autorunFixture();
    try {
      f.manager.automation.started('owner-1', 'session-1', 'terminal-1', 2, 'codex', 'wsl');
      const ready: ReadyPromptEvidence = { kind: 'ready', empty: true, proofVersion: 'fixture-ready-v1', identity: {
        userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl', serverInstanceId: f.manager.automation.serverInstanceId,
        terminalId: 'terminal-1', generation: 2, provider: 'codex', providerConversationId: null, inputRevision: 0, observationRevision: 1 } };
      let observation: NativeInteraction = ready;
      const received: string[] = [];
      bindNativeAutomationInteraction(f.manager, {
        observe: async () => observation,
        assertCurrent: expected => { assert.deepEqual(expected, ready); },
        async submitPrompt(args) {
          args.writeFence('begin', () => received.push(args.prompt));
          args.writeFence('complete', () => {});
          f.manager.automation.dirty('owner-1', 'session-1');
          f.manager.automation.submitted('owner-1', 'session-1', 'AutomationPromptSubmit');
          observation = { kind: 'running', identity: { ...ready.identity, inputRevision: 1, observationRevision: 2 } };
          return { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() };
        },
        respondApproval: async () => { throw Error('not an approval'); },
      });
      const input = mode === 'autorun' ? f.input() : { ...wakeInput(), enabled: true };
      const rule = (await f.service.create('owner-1', mode, input)).automation;
      await f.engine.tick(); await f.engine.tick();
      assert.equal(received.length, 1);
      assert.match(received[0], mode === 'autorun' ? /Fix login/ : /Continue the task/);
      const detail = f.service.detail('owner-1', rule.id);
      assert.equal(detail.automation.dispatchCount, 1);
      assert.equal(detail.automation.state, 'enabled');
      assert.equal(f.service.history('owner-1', rule.id, {}).items[0].state, 'delivered');
    } finally { await f.close(); }
  }
});

test('Autorun answers only exact one-time native approval options; Heartbeat waits', async () => {
  for (const outcome of ['approve-once', 'deny', 'ask-user', 'persistent', 'stale', 'lost-ack', 'heartbeat'] as const) {
    const f = await autorunFixture();
    try {
      f.manager.automation.dirty('owner-1', 'session-1', true); const submit = f.submit();
      const request: import('../src/lib/automation/activation-contracts').NativeApprovalRequest = {
        kind: 'command', requestId: 'approval-1', nativeRequestId: 'native-1', requestHash: 'a'.repeat(64),
        identity: { userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl',
          serverInstanceId: f.manager.automation.serverInstanceId, terminalId: 'terminal-1', generation: 1,
          provider: 'codex', providerConversationId: 'conversation-1', inputRevision: 1, observationRevision: 1 },
        operation: { command: 'cat stage-one.txt', cwd: '/owned' }, context: { text: 'Read owned fixture marker', complete: true },
        deadlineAt: f.service.deps.now() + 120000,
        options: [{ id: 'once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }, { id: 'always', effect: 'persistent-grant' }],
      };
      f.manager.automation.holdNativeApproval('owner-1', 'session-1', request);
      f.manager.recordSessionState({ type: 'session_state', sessionId: 'session-1', terminalId: 'terminal-1',
        hookEvent: 'PermissionRequest', status: 'input_required', stateAt: f.service.deps.now() + 1000 }, 'owner-1');
      const responses: string[] = [];
      let stale = false, checks = 0, defers = 0;
      bindNativeAutomationInteraction(f.manager, {
        observe: async () => ({ kind: 'approval', request }),
        deferApproval(args) {
          if (args.expected) assert.equal(args.expected.nativeRequestId, 'native-1');
          defers++; f.manager.automation.releaseNativeApproval('owner-1','session-1',request.requestId);
        },
        assertCurrent() { if (stale) throw Error('request changed'); },
        submitPrompt: async () => { throw Error('must not type task text into approval'); },
        async respondApproval(args) {
          args.writeFence('begin', () => responses.push(args.optionId)); args.writeFence('complete', () => {});
          if (outcome === 'lost-ack') {
            await f.service.pause('owner-1', rule.id);
            assert.equal(args.signal.aborted, true);
            return { kind: 'unknown', reason: 'NATIVE_ACK_MISSING', sessionId: 'session-1' };
          }
          f.manager.automation.releaseNativeApproval('owner-1', 'session-1', request.requestId);
          return { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() };
        },
      });
      f.provider.generateSupervisorApprovalDecision = async args => {
        checks++; if (outcome === 'stale') stale = true;
        return { kind: 'ok', selection: args.selection, capability: args.capability, cliVersion: args.capability.cliVersion,
          invocationId: args.invocationId, settlement: { exitCode: 0, quiescent: true }, decision: {
            kind: 'approval', requestId: request.requestId, requestHash: request.requestHash,
            outcome: outcome === 'persistent' || outcome === 'stale' || outcome === 'lost-ack' ? 'approve-once' : outcome === 'heartbeat' ? 'ask-user' : outcome,
            optionId: outcome === 'deny' ? 'deny' : outcome === 'persistent' ? 'always' : outcome === 'ask-user' ? null : 'once',
            explanation: 'Judgment against the explicit objective.', scopeReferences: ['objective'] } };
      };
      const input = outcome === 'heartbeat' ? { ...wakeInput(), enabled: true } : f.input();
      const rule = (await f.service.create('owner-1', outcome, input)).automation;
      await f.engine.tick();
      for (let i = 0; i < 100 && outcome !== 'heartbeat' && (!checks || f.service.detail('owner-1', rule.id).activation?.phase === 'analysing'); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await f.engine.tick();
      assert.deepEqual(responses, outcome === 'approve-once' || outcome === 'lost-ack' ? ['once'] : outcome === 'deny' ? ['deny'] : []);
      assert.equal(checks, outcome === 'heartbeat' ? 0 : 1);
      if (outcome === 'ask-user') assert.equal(defers, 1, 'manual approval hook released as soon as judgment returns');
      assert.equal(f.service.detail('owner-1', rule.id).automation.dispatchCount, responses.length);
      if (outcome === 'lost-ack') {
        assert.equal(f.service.history('owner-1', rule.id, {}).items[0].state, 'unknown');
        await f.engine.tick(); assert.equal(responses.length, 1);
      }
      if (outcome === 'approve-once' || outcome === 'deny') {
        assert.equal(f.runtime.autorun!.readTurnEvidence({ userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' }).kind, 'running');
        f.complete(submit, f.service.deps.now() + 1000);
        assert.equal(f.runtime.autorun!.readTurnEvidence({ userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' }).kind, 'completed');
      }
    } finally { await f.close(); }
  }
});
