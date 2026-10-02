import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { acceptSupervisorResult } from './autorun-provider-proof-finality';

const root = 'tests/fixtures/autorun-proof/';
const packet = JSON.parse(readFileSync(root + 'packet.json', 'utf8'));
const settled = { exitCode: 0, cancelled: false, timedOut: false, quiescent: true };
for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} accepts only a settled structured final decision grounded in the packet`, () => {
    const output = readFileSync(root + provider + '-decision.jsonl');
    const result = acceptSupervisorResult(provider, output, settled, packet);
    assert.equal(result.outcome, 'complete');
    assert.equal(result.proposedPrompt, null);
    assert.deepEqual(result.criterionResults.map(c => c.criterionId), ['two']);
  });
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} refuses timeout, cancellation, nonzero exit and uncertain process quiescence`, () => {
    const output = readFileSync(root + provider + '-decision.jsonl');
    for (const fault of [{ timedOut: true }, { cancelled: true }, { exitCode: 1 }, { exitCode: null }, { quiescent: false }]) {
      assert.throws(() => acceptSupervisorResult(provider, output, { ...settled, ...fault }, packet));
    }
    assert.throws(() => acceptSupervisorResult(provider, output.subarray(0, output.length - 1), settled, packet));
  });
  test(`${provider} refuses success claims citing evidence missing from the supplied packet`, () => {
    const output = readFileSync(root + provider + '-decision.jsonl');
    assert.throws(() => acceptSupervisorResult(provider, output, settled, { ...packet, messages: [] }));
  });
}

test('Codex rejects an executable tool receipt even when a valid decision follows', () => {
  const output = readFileSync(root + 'codex-decision.jsonl');
  const tool = Buffer.from('{"type":"item.completed","item":{"type":"command_execution","command":"write sentinel"}}\n');
  assert.throws(() => acceptSupervisorResult('codex', Buffer.concat([tool, output]), settled, packet));
});

test('Claude rejects an executable tool call even when StructuredOutput succeeds', () => {
  const output = readFileSync(root + 'claude-decision.jsonl');
  const tool = Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}\n');
  assert.throws(() => acceptSupervisorResult('claude', Buffer.concat([tool, output]), settled, packet));
});
