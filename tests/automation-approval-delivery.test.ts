import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';
import { bindNativeAutomationInteraction } from '../src/lib/automation/native-interaction';
import { supervisorApprovalPacketSchema } from '../src/lib/automation/autorun-contracts';
import type { NativeApprovalRequest, SupervisorApprovalRequest } from '../src/lib/automation/activation-contracts';
import type { DispatchResult } from '../src/lib/automation/runtime-port';

const target = '/home/work/tmp/qa-activation-native-20261004/approval-target/approved.txt';
const objective = `Write exactly QA_AUTORUN_APPROVAL_20261004 followed by a newline to ${target}, then read it and report its exact contents. Only this new test file is authorized; do not modify anything else. Use the normal one-time permission request. Do not change approval policy or seek a persistent rule.`;

async function approvalFixture() {
  const f = await autorunFixture();
  f.manager.automation.dirty('owner-1', 'session-1', true); f.submit();
  const request: NativeApprovalRequest = { kind: 'command', requestId: 'approval-1', nativeRequestId: 'hook-nonce', requestHash: 'a'.repeat(64),
    identity: { ...f.manager.automation.readNativeState('owner-1', 'session-1')!.identity, observationRevision: 1 },
    operation: { command: `printf '%s\\n' 'QA_AUTORUN_APPROVAL_20261004' > ${target}`, cwd: '/owned' },
    context: { text: 'Worker requested one-time approval for this exact file write.', complete: true },
    options: [{ id: 'once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }], deadlineAt: f.service.deps.now() + 120000 };
  f.manager.automation.holdNativeApproval('owner-1', 'session-1', request);
  const input = f.input();
  input.autorun.objective = { kind: 'explicit', text: objective }; input.autorun.constraints = [];
  return { ...f, request, input };
}
async function settle(f: Awaited<ReturnType<typeof approvalFixture>>, id: string) {
  await f.engine.tick();
  for (let i = 0; i < 100; i++) {
    const activation = f.service.detail('owner-1', id).activation;
    if (activation?.phase !== 'analysing' && activation?.phase !== 'dispatching') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Approval did not settle');
}
function judgment(args: SupervisorApprovalRequest, outcome: 'approve-once' | 'deny' = 'approve-once') {
  return { kind: 'ok' as const, selection: args.selection, capability: args.capability, cliVersion: args.capability.cliVersion,
    invocationId: args.invocationId, settlement: { exitCode: 0, quiescent: true }, decision: {
      kind: 'approval' as const, requestId: args.packet.request.requestId, requestHash: args.packet.request.requestHash,
      outcome, optionId: outcome === 'deny' ? 'deny' : 'once', explanation: 'Exact file and one-time option evaluated against the saved objective.', scopeReferences: ['objective'] } };
}

test('approval analysis identifies the worker as decision target without granting the supervisor execution authority', async () => {
  const f = await approvalFixture();
  let captured: SupervisorApprovalRequest | undefined;
  const responses: string[] = [];
  try {
    bindNativeAutomationInteraction(f.manager, {
      observe: async () => ({ kind: 'approval', request: f.request }), assertCurrent() {},
      submitPrompt: async () => { throw Error('No task text in approval'); },
      respondApproval: async args => {
        args.writeFence('begin', () => responses.push(args.optionId)); args.writeFence('complete', () => {});
        return { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() };
      },
    });
    f.provider.generateSupervisorApprovalDecision = async args => { captured = args; return judgment(args); };
    const rule = (await f.service.create('owner-1', 'owned write', f.input)).automation;
    await settle(f, rule.id);
    assert.ok(captured);
    assert.equal(captured.packet.objective.text, objective);
    assert.deepEqual(captured.packet.request, f.request);
    assert.deepEqual(captured.packet.reviewContext, {
      decisionTarget: 'worker-native-request', authorizationSource: 'saved-objective-and-constraints',
      supervisorRole: 'analysis-only', supervisorIsolationAppliesTo: 'supervisor-process-only',
    });
    assert.match(captured.trustedInstructions, /read-only sandbox and approval_policy=never apply only to your supervisor process/);
    assert.match(captured.trustedInstructions, /Do not execute tools/);
    assert.equal(supervisorApprovalPacketSchema.safeParse(captured.packet).success, true);
    assert.equal(supervisorApprovalPacketSchema.safeParse({ ...captured.packet,
      reviewContext: { ...captured.packet.reviewContext, authorizationSource: 'terminal-instructions' } }).success, false);
    assert.deepEqual(responses, ['once']);
  } finally { await f.close(); }
});

test('approval projection reports acknowledged delivery, not an undelivered supervisor judgment', async () => {
  for (const outcome of ['approve-once', 'deny'] as const) for (const delivery of ['delivered', 'cancelled', 'deferred', 'unknown'] as const) {
    const f = await approvalFixture();
    let beforeResponse: string | undefined;
    let responses = 0;
    try {
      f.provider.generateSupervisorApprovalDecision = async args => judgment(args, outcome);
      bindNativeAutomationInteraction(f.manager, {
        observe: async () => ({ kind: 'approval', request: f.request }), assertCurrent() {},
        submitPrompt: async () => { throw Error('No task text in approval'); },
        async respondApproval(args) {
          responses++;
          beforeResponse = f.service.detail('owner-1', rule.id).activation?.approval?.status;
          if (delivery === 'delivered' || delivery === 'unknown') {
            args.writeFence('begin', () => {}); args.writeFence('complete', () => {});
          }
          const result: DispatchResult = delivery === 'delivered'
            ? { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() }
            : delivery === 'unknown' ? { kind: 'unknown', reason: 'NATIVE_ACK_MISSING', sessionId: 'session-1' }
            : delivery === 'deferred' ? { kind: 'deferred', reason: 'NATIVE_MANUAL_HANDOFF', retryAt: f.service.deps.now() + 30000 }
            : { kind: 'cancelled', reason: 'APPROVAL_STALE' };
          return result;
        },
      });
      const rule = (await f.service.create('owner-1', 'approval outcome', f.input)).automation;
      await settle(f, rule.id);
      assert.equal(beforeResponse, 'reviewing', 'Judgment is not native delivery');
      const projection = f.service.detail('owner-1', rule.id).activation!;
      assert.equal(projection.approval?.status, delivery === 'delivered' ? outcome === 'deny' ? 'denied' : 'approved-once' : 'needs-user');
      if (delivery !== 'delivered') {
        assert.equal(projection.phase, 'needs-user');
        assert.equal(projection.reason, delivery === 'unknown' ? 'delivery-unresolved' : 'approval-needs-user');
        assert.match(projection.approval!.explanation!, /not confirmed/);
      }
      assert.equal(f.service.repo.get(rule.id)!.activation!.approvals[0].decision!.outcome, outcome, 'Keep judgment in the audit record');
      await f.engine.tick(); assert.equal(responses, 1, 'No replay of failed or uncertain approval response');
    } finally { await f.close(); }
  }
});

test('last dispatch and analysis retain only their exact held approval authority', async () => {
  const f = await autorunFixture();
  let request: NativeApprovalRequest | undefined;
  let responses = 0;
  try {
    f.manager.automation.started('owner-1', 'session-1', 'terminal-1', 2, 'codex', 'wsl');
    const ready = { kind: 'ready' as const, empty: true as const, proofVersion: 'fixture-ready-v1',
      identity: { ...f.manager.automation.readNativeState('owner-1', 'session-1')!.identity, observationRevision: 1 } };
    bindNativeAutomationInteraction(f.manager, {
      observe: async () => request ? { kind: 'approval', request } : ready,
      assertCurrent(expected) {
        if ('requestId' in expected && !f.manager.automation.canSuperviseNativeApproval('owner-1', 'session-1', expected)) throw Error('No held approval authority');
      },
      async submitPrompt(args) {
        args.writeFence('begin', () => {}); args.writeFence('complete', () => {});
        f.manager.automation.dirty('owner-1', 'session-1'); f.submit();
        return { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() };
      },
      async respondApproval(args) {
        responses++;
        const detail = f.service.detail('owner-1', rule.id).automation;
        assert.equal(detail.dispatchCount, 2); assert.equal(detail.analysisCount, 1);
        assert.equal(f.manager.automation.canSuperviseNativeApproval('owner-1', 'session-1'), false, 'No admission of another request');
        assert.equal(f.manager.automation.canSuperviseNativeApproval('owner-1', 'session-1', args.expected), true);
        assert.equal(f.manager.automation.canSuperviseNativeApproval('owner-1', 'session-1', { ...args.expected, nativeRequestId: 'other-hook' }), false);
        args.writeFence('begin', () => {}); args.writeFence('complete', () => {});
        return { kind: 'delivered', sessionId: 'session-1', terminalId: 'terminal-1', at: f.service.deps.now() };
      },
    });
    f.provider.generateSupervisorApprovalDecision = async args => judgment(args);
    const input = f.input(); input.limits.maxDispatches = 2; input.autorun.maxAnalyses = 1;
    const rule = (await f.service.create('owner-1', 'final permitted response', input)).automation;
    await f.engine.tick();
    assert.equal(f.service.detail('owner-1', rule.id).automation.dispatchCount, 1);
    request = { kind: 'command', requestId: 'last-request', nativeRequestId: 'last-hook', requestHash: 'b'.repeat(64),
      identity: { ...f.manager.automation.readNativeState('owner-1', 'session-1')!.identity, observationRevision: 2 },
      operation: { command: 'cat owned-marker', cwd: '/owned' }, context: { text: 'Read task input', complete: true },
      options: [{ id: 'once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }], deadlineAt: f.service.deps.now() + 120000 };
    f.manager.automation.holdNativeApproval('owner-1', 'session-1', request);
    f.manager.recordSessionState({ type: 'session_state', sessionId: 'session-1', terminalId: 'terminal-1',
      hookEvent: 'PermissionRequest', status: 'input_required', stateAt: f.service.deps.now() + 1000 }, 'owner-1');
    await settle({ ...f, request, input }, rule.id);
    assert.equal(responses, 1);
    const detail = f.service.detail('owner-1', rule.id);
    assert.equal(detail.automation.dispatchCount, 2); assert.equal(detail.automation.analysisCount, 1);
    assert.equal(detail.automation.state, 'exhausted'); assert.equal(detail.activation?.approval?.status, 'approved-once');
    assert.equal(f.service.history('owner-1', rule.id, {}).items.filter(r => r.state === 'delivered').length, 2);
    assert.equal(f.manager.automation.canSuperviseNativeApproval('owner-1', 'session-1', request), false, 'No retained authority after delivery');
    await f.engine.tick(); assert.equal(responses, 1);
  } finally { await f.close(); }
});
