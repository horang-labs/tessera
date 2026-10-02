import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { correlateCompletedTurn } from './autorun-provider-proof-context';

const root = 'tests/fixtures/autorun-proof/';
const fixture = JSON.parse(readFileSync(root + 'observations.json', 'utf8'));

test('Claude identical final text resolves to distinct prompt lineages and byte cutoffs', () => {
  const bytes = readFileSync(root + 'claude.jsonl');
  const turns = fixture.claude.turns;
  const first = correlateCompletedTurn(bytes, turns[0]);
  const second = correlateCompletedTurn(bytes, turns[1]);
  assert.equal(first.recordId, '754f6881-5d70-41cc-9e82-32d0c90bbb8d');
  assert.equal(second.recordId, '1996e946-6f39-487a-80ad-bbae88e742d5');
  assert.equal(first.end, turns[0].fixtureEnd);
  assert.equal(second.end, turns[1].fixtureEnd);
});

test('Codex cutoff uses the submitted turn ID rather than identical last text', () => {
  const bytes = readFileSync(root + 'codex.jsonl');
  for (const turn of fixture.codex.turns) {
    const result = correlateCompletedTurn(bytes, turn);
    assert.equal(result.recordId, turn.submitId);
    assert.equal(result.end, turn.fixtureEnd);
  }
});

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} waits for a delayed complete record and rejects partial JSONL`, () => {
    const bytes = readFileSync(root + provider + '.jsonl');
    const turn = fixture[provider].turns[1];
    assert.throws(() => correlateCompletedTurn(bytes.subarray(0, turn.fixtureEnd - 1), turn));
    assert.equal(correlateCompletedTurn(bytes, turn).end, turn.fixtureEnd);
  });
  test(`${provider} rejects approval, child activity and mismatched Stop identity`, () => {
    const bytes = readFileSync(root + provider + '.jsonl');
    const turn = fixture[provider].turns[1];
    assert.throws(() => correlateCompletedTurn(bytes, { ...turn, blocked: true }));
    assert.throws(() => correlateCompletedTurn(bytes, { ...turn, stopId: 'different' }));
    assert.throws(() => correlateCompletedTurn(bytes, { ...turn, sessionId: 'different' }));
  });
  test(`${provider} rejects ambiguous duplicate completion records`, () => {
    const bytes = readFileSync(root + provider + '.jsonl');
    const turn = fixture[provider].turns[1];
    const lines = bytes.toString().split('\n').filter(Boolean);
    const final = provider === 'claude'
      ? lines.find(s => JSON.parse(s).uuid === '1996e946-6f39-487a-80ad-bbae88e742d5')!
      : lines.find(s => JSON.parse(s).payload?.type === 'task_complete' && JSON.parse(s).payload.turn_id === turn.submitId)!;
    assert.throws(() => correlateCompletedTurn(Buffer.concat([bytes, Buffer.from(final + '\n')]), turn));
  });
}

test('Claude refuses a lineage containing an unresolved executable tool call', () => {
  const bytes = readFileSync(root + 'claude.jsonl');
  const lines = bytes.toString().split('\n').filter(Boolean).map(s => JSON.parse(s));
  const final = lines.find(r => r.uuid === '1996e946-6f39-487a-80ad-bbae88e742d5');
  final.message.content.push({ type: 'tool_use', id: 'pending', name: 'Bash', input: {} });
  assert.throws(() => correlateCompletedTurn(Buffer.from(lines.map(r => JSON.stringify(r)).join('\n') + '\n'), fixture.claude.turns[1]));
});
