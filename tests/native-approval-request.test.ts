import assert from 'node:assert/strict';
import test from 'node:test';
import { readNativeApprovalRequest } from '@/lib/terminal/native-approval-request';
import type { NativeRuntimeIdentity } from '@/lib/automation/activation-contracts';
const identity: NativeRuntimeIdentity = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl',
  serverInstanceId: 'server', terminalId: 'terminal', generation: 2, provider: 'codex',
  providerConversationId: 'native', inputRevision: 4, observationRevision: 8 };
const payload = { hook_event_name: 'PermissionRequest', session_id: 'native', turn_id: 'turn',
  tool_name: 'exec_command', tool_input: { command: 'cat marker.txt' }, cwd: '/owned',
  tessera_native_approval: { invocationId: 'nonce', generation: 2, providerVersion: '0.159.2' } };
test('pinned native PermissionRequest creates exact once-only options from structured hook data', () => {
  const request = readNativeApprovalRequest(identity, payload); assert.ok(request);
  assert.equal(request.nativeRequestId, 'nonce');
  assert.deepEqual(request.options, [{ id: 'allow-once', effect: 'approve-once' }, { id: 'deny', effect: 'deny' }]);
  assert.equal(request.context.complete, true); assert.match(request.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(readNativeApprovalRequest(identity, { ...payload, tool_name: 'AskUserQuestion' }), null);
  assert.equal(readNativeApprovalRequest(identity, { ...payload, session_id: 'other' }), null);
  assert.equal(readNativeApprovalRequest(identity, { ...payload, tessera_native_approval: { ...payload.tessera_native_approval, providerVersion: '0.160.0' } }), null);
});
