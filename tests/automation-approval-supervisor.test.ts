import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSupervisorApprovalResult } from '../src/lib/automation/supervisor';
import { autorunPreviewFixture } from './fixtures/autorun-contracts';

test('native approval decision requires final tools-free output and exact selected capability', () => {
  const capability = autorunPreviewFixture().supervisorOptions[0];
  const decision = { kind: 'approval', requestId: 'request', requestHash: 'a'.repeat(64), outcome: 'approve-once',
    optionId: 'once', explanation: 'Read is within the saved goal.', scopeReferences: ['objective'] };
  const events = [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(decision) } }, { type: 'turn.completed' }];
  const args = { selection: capability.selection, capability, cliVersion: capability.cliVersion, invocationId: 'invocation',
    stdout: Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'), stderr: Buffer.alloc(0), exitCode: 0, quiescent: true, cancelled: false, timedOut: false };
  assert.equal(parseSupervisorApprovalResult(args).kind, 'ok');
  assert.equal(parseSupervisorApprovalResult({ ...args, timedOut: true }).kind, 'unavailable');
  const executable = [{ type: 'item.completed', item: { type: 'command_execution', text: 'ran' } }, ...events];
  assert.equal(parseSupervisorApprovalResult({ ...args, stdout: Buffer.from(executable.map(e => JSON.stringify(e)).join('\n') + '\n') }).kind, 'unavailable');
  assert.equal(parseSupervisorApprovalResult({ ...args, selection: { ...args.selection, model: 'different' } }).kind, 'unavailable');
});
