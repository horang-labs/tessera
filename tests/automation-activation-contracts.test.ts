import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeApprovalRequestSchema, nativeInteractionSchema } from '../src/lib/automation/activation-contracts';

const identity = { userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', serverInstanceId: 'server',
  terminalId: 'terminal', generation: 1, provider: 'codex', providerConversationId: 'conversation', inputRevision: 0, observationRevision: 1 };

test('native approval contract preserves exact one-time options and refuses missing native identity', () => {
  const request = { requestId: 'request', identity, nativeRequestId: 'native', requestHash: 'a'.repeat(64),
    kind: 'command', operation: { command: 'cat stage-one.txt', cwd: '/owned' },
    options: [{ id: 'allow', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }],
    context: { text: 'Read the owned fixture.', complete: true }, deadlineAt: 1800000000000 };
  assert.deepEqual(nativeApprovalRequestSchema.parse(request), request);
  assert.equal(nativeApprovalRequestSchema.safeParse({ ...request, nativeRequestId: '' }).success, false);
  assert.equal(nativeApprovalRequestSchema.safeParse({ ...request, options: [{ id: 'allow', effect: 'global-bypass' }] }).success, false);
  assert.equal(nativeInteractionSchema.safeParse({ kind: 'ready', identity, proofVersion: 'codex-ready-v1', empty: false }).success, false);
});
