import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeApprovalBridge } from '@/lib/terminal/native-approval-bridge';
import type { NativeApprovalRequest } from '@/lib/automation/activation-contracts';

const request: NativeApprovalRequest = { kind: 'permission', requestId: 'invocation', nativeRequestId: 'invocation',
  requestHash: 'a'.repeat(64), identity: { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl',
    serverInstanceId: 'server', terminalId: 'terminal', generation: 1, provider: 'codex',
    providerConversationId: 'native', inputRevision: 3, observationRevision: 5 },
  operation: { toolName: 'exec_command', input: { command: 'cat marker.txt' } },
  options: [{ id: 'allow-once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }],
  context: { text: 'Read owned marker file', complete: true }, deadlineAt: Date.now() + 10_000 };

test('one native hook decision needs exact commit and stdout acknowledgement before delivered', async () => {
  const bridge = new NativeApprovalBridge(); const offer = bridge.open(request);
  const phases: string[] = [], outputs: unknown[] = [];
  const response = bridge.respond({ expected: request, optionId: 'allow-once', signal: new AbortController().signal,
    writeFence: (phase, write) => { phases.push(phase); write(); } }, () => {});
  assert.deepEqual(await offer, { requestId: request.requestId, requestHash: request.requestHash, optionId: 'allow-once' });
  assert.deepEqual(phases, []);
  assert.equal(bridge.commit(request.requestId, request.requestHash, output => outputs.push(output)), true);
  assert.deepEqual(phases, ['begin']);
  assert.deepEqual(outputs, [{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }]);
  assert.equal(bridge.acknowledge(request.requestId, request.requestHash), true);
  assert.equal((await response).kind, 'delivered');
  assert.deepEqual(phases, ['begin', 'complete']);
  assert.equal(bridge.commit(request.requestId, request.requestHash, () => assert.fail('duplicate')), false);
});

test('one pending request cannot be replaced by a second hook in the same worker', async () => {
  const bridge = new NativeApprovalBridge(), waiting = bridge.open(request);
  assert.equal(await bridge.open({ ...request, requestId: 'second', nativeRequestId: 'second' }), null);
  bridge.cancel(request.requestId); assert.equal(await waiting, null);
});

test('Pause before commit returns manual flow with no native bytes', async () => {
  const bridge = new NativeApprovalBridge(), offer = bridge.open(request), controller = new AbortController();
  const result = bridge.respond({ expected: request, optionId: 'deny', signal: controller.signal,
    writeFence: () => assert.fail('no fenced write') }, () => {});
  await offer; controller.abort();
  assert.equal((await result).kind, 'cancelled');
  assert.equal(bridge.commit(request.requestId, request.requestHash, () => assert.fail('native write')), false);
});

test('stale identity, forged hash and persistent grant cannot return native permission', async () => {
  const bridge = new NativeApprovalBridge(), offer = bridge.open(request);
  const controller = new AbortController();
  const args = { expected: request, optionId: 'always', signal: controller.signal,
    writeFence: () => assert.fail('no write') };
  assert.equal((await bridge.respond(args, () => {})).kind, 'cancelled');
  assert.equal((await bridge.respond({ ...args, expected: { ...request, requestHash: 'b'.repeat(64) }, optionId: 'allow-once' }, () => {})).kind, 'cancelled');
  assert.equal((await bridge.respond({ ...args, optionId: 'allow-once' }, () => { throw Error('new generation'); })).kind, 'cancelled');
  assert.equal(await offer, null);
});

test('lost stdout acknowledgement or failed fence remains unknown and cannot retry', async () => {
  const bridge = new NativeApprovalBridge(), offer = bridge.open(request), controller = new AbortController();
  const result = bridge.respond({ expected: request, optionId: 'deny', signal: controller.signal,
    writeFence: (_phase, write) => write() }, () => {});
  await offer;
  assert.equal(bridge.commit(request.requestId, 'b'.repeat(64), () => assert.fail()), false);
  assert.equal(bridge.commit(request.requestId, request.requestHash, output => {
    assert.equal(output.hookSpecificOutput.decision.behavior, 'deny');
  }), true);
  assert.equal(bridge.acknowledge(request.requestId, 'b'.repeat(64)), false);
  controller.abort(); assert.equal((await result).kind, 'unknown');
  assert.equal(bridge.acknowledge(request.requestId, request.requestHash), false);
  assert.equal(await bridge.open(request), null);
});

test('disconnected/expired hook falls back to manual flow', async () => {
  const bridge = new NativeApprovalBridge();
  const offer = bridge.open({ ...request, deadlineAt: Date.now() + 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await offer, null); assert.equal(bridge.current('owner', 'worker'), null);
});
