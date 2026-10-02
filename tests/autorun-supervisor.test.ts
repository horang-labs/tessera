import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseSupervisorResult } from '../src/lib/automation/supervisor';
import { autorunInput } from './fixtures/autorun-contracts';
const packet = { criteria: [{ id: 'two' }], context: { items: [{ id: 'a1' }, { id: 'a2' }] } };
for (const provider of ['codex', 'claude-code'] as const) test(`${provider} accepts only one successful native final after exit zero and tree quiescence`, () => {
  const selection = provider === 'codex' ? autorunInput().autorun.supervisor : { provider, model: 'claude-sonnet-5-5', reasoningEffort: 'high', serviceTier: null };
  const recorded = fs.readFileSync(`tests/fixtures/autorun-proof/${provider === 'codex' ? 'codex' : 'claude'}-decision.jsonl`);
  const output = provider === 'claude-code' ? Buffer.concat([Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', ...JSON.parse(fs.readFileSync('tests/fixtures/autorun-proof/capability-observations.json', 'utf8')).claudeInit }) + '\n'), recorded]) : recorded;
  const args = { selection, cliVersion: provider === 'codex' ? '0.159.2' : '2.1.284', invocationId: 'test-call', packet,
    stdout: output, stderr: Buffer.alloc(0), exitCode: 0, quiescent: true, cancelled: false, timedOut: false };
  assert.equal(parseSupervisorResult(args).kind, 'ok');
  assert.notEqual(parseSupervisorResult({ ...args, exitCode: 1 }).kind, 'ok');
  assert.notEqual(parseSupervisorResult({ ...args, timedOut: true }).kind, 'ok');
  const uncertain = parseSupervisorResult({ ...args, quiescent: false });
  assert.ok(uncertain.kind !== 'ok');
  if (uncertain.kind !== 'ok') assert.equal(uncertain.code, 'SUPERVISOR_PROCESS_UNCERTAIN');
  assert.notEqual(parseSupervisorResult({ ...args, stdout: output.subarray(0, -1) }).kind, 'ok');
});
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { runOwnedSupervisor } from '../src/lib/cli/providers/autorun-process';
test('owned cancellation waits for a guest settlement and never kills the Windows bridge', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { throw new Error('bridge must not be killed'); } }) as unknown as ChildProcess;
  const controller = new AbortController();
  const result = runOwnedSupervisor({ userId: 'owner', agentEnvironment: 'wsl', root: '/host', guestRoot: '/guest',
    deadlineAt: Date.now() + 1000, signal: controller.signal, stdin: '{}' }, {
    spawn: request => { assert.equal(request.agentEnvironment, 'wsl'); return child; },
    abort: async () => { child.emit('close', 143); }, settlement: async () => ({ exitCode: 143, quiescent: true }), settleWaitMs: 10,
  });
  controller.abort();
  assert.deepEqual(await result, { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 143, quiescent: true,
    cancelled: true, timedOut: false, overflow: false });
});
test('partial output then timeout cannot become success, and missing settlement reports uncertainty', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
  const result = runOwnedSupervisor({ userId: 'owner', agentEnvironment: 'wsl', root: '/host', guestRoot: '/guest', deadlineAt: Date.now() + 10,
    signal: new AbortController().signal, stdin: '{}' }, { spawn: () => child, abort: async () => {},
    settlement: async () => { throw new Error('no receipt'); }, settleWaitMs: 10 });
  child.stdout?.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
  const settled = await result;
  assert.equal(settled.timedOut, true); assert.equal(settled.quiescent, false);
  const parsed = parseSupervisorResult({ ...settled, selection: autorunInput().autorun.supervisor, invocationId: 'timeout', cliVersion: '0.159.2', packet });
  assert.equal(parsed.kind, 'provider-error');
  if (parsed.kind !== 'ok') assert.equal(parsed.code, 'SUPERVISOR_PROCESS_UNCERTAIN');
});
