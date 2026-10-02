import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisContextSnapshotSchema } from '../src/lib/automation/autorun-contracts';
import { contextSnapshot } from './fixtures/autorun-contracts';

test('context carries correlated native finality, bounded evidence and exact inherited worker identity', () => {
  const snapshot = contextSnapshot();
  assert.deepEqual(analysisContextSnapshotSchema.parse(snapshot), snapshot);
  for (const invalid of [
    { ...snapshot, cutoff: { completedAt: snapshot.capturedAt, text: 'Regression passes.' } },
    { ...snapshot, cutoff: { ...snapshot.cutoff, endByte: 499 } },
    { ...snapshot, correlation: { ...snapshot.correlation, nativeTurnId: 'previous' } },
    { ...snapshot, correlation: { ...snapshot.correlation, providerConversationId: 'other' } },
    { ...snapshot, userId: 'foreign-owner' },
    { ...snapshot, items: [...snapshot.items, snapshot.items[0]] },
    { ...snapshot, items: [{ ...snapshot.items[0], endByte: 501 }] },
    { ...snapshot, coverage: { ...snapshot.coverage, latestTurnComplete: false } },
    { ...snapshot, items: [{ ...snapshot.items[0], text: '한'.repeat(32768) }] },
    { ...snapshot, source: { ...snapshot.source, bytesScanned: 33554433 } },
  ]) assert.equal(analysisContextSnapshotSchema.safeParse(invalid).success, false);
});

test('the complete supervisor packet enforces total UTF-8 bytes and bounded prior history', async () => {
  const { supervisorPacketSchema } = await import('../src/lib/automation/autorun-contracts');
  const packet = {
    version: 1, objective: { kind: 'explicit', text: 'Fix login.', revision: 1 }, constraints: [],
    criteria: [{ id: 'goal', text: 'Test passes.' }], criterionOrigin: 'explicit',
    context: contextSnapshot(), priorDecisions: [],
  };
  assert.equal(supervisorPacketSchema.safeParse(packet).success, true);
  const prior = { decisionId: 'decision-1', outcome: 'continue', explanation: 'Inspect tests.', progress: 'Fix written.', madeProgress: true };
  assert.equal(supervisorPacketSchema.safeParse({ ...packet, priorDecisions: Array(11).fill(prior) }).success, false);
  assert.equal(supervisorPacketSchema.safeParse({ ...packet, constraints: ['한'.repeat(5462)] }).success, false);
  // Snapshot fits on its own, but goal+history+envelope take the complete packet over 96 KiB.
  const context = { ...contextSnapshot(), items: [{ ...contextSnapshot().items[0], text: 'a'.repeat(95000) }] };
  assert.equal(analysisContextSnapshotSchema.safeParse(context).success, true);
  assert.equal(supervisorPacketSchema.safeParse({ ...packet, context, constraints: ['a'.repeat(4000)] }).success, false);
});

test('Claude correlation needs prompt identity plus durable lineage, even with identical final text', () => {
  const snapshot = contextSnapshot();
  const claude = { ...snapshot, provider: 'claude-code', cliVersion: '2.1.284',
    workerSelection: { ...snapshot.workerSelection, provider: 'claude-code' },
    correlation: { ...snapshot.correlation, provider: 'claude-code', nativePromptId: 'prompt-2', stopTextHash: 'e'.repeat(64), nativeTurnId: undefined },
    cutoff: { provider: 'claude-code', promptId: 'prompt-2', humanRecordId: 'human-2', terminalRecordId: 'assistant-2',
      parentUuid: 'human-2', apiMessageId: 'api-2', endByte: 500 } };
  delete claude.correlation.nativeTurnId;
  assert.equal(analysisContextSnapshotSchema.safeParse(claude).success, true);
  assert.equal(analysisContextSnapshotSchema.safeParse({ ...claude, cutoff: { ...claude.cutoff, promptId: 'prompt-1' } }).success, false);
  assert.equal(analysisContextSnapshotSchema.safeParse({ ...claude, cutoff: { ...claude.cutoff, parentUuid: null } }).success, false);
});


test('large absolute offsets permit bounded latest-turn and identity-header reads within actual scan budget', () => {
  const snapshot = contextSnapshot();
  const offset = 41943040;
  const tail = { startByte: offset, endByte: offset + 500 };
  const source = { ...snapshot.source, ...tail, latestTurnStartByte: offset,
    scannedRanges: [{ startByte: 0, endByte: 128 }, tail], bytesScanned: 628 };
  const large = { ...snapshot, source, cutoff: { ...snapshot.cutoff, endByte: tail.endByte },
    correlation: { ...snapshot.correlation, startByte: offset },
    coverage: { ...snapshot.coverage, kind: 'bounded', omittedRanges: [{ startByte: 128, endByte: offset }], omittedBytes: offset - 128 },
    items: snapshot.items.map(item => ({ ...item, startByte: item.startByte + offset, endByte: item.endByte + offset })) };
  assert.equal(analysisContextSnapshotSchema.safeParse(large).success, true);
  for (const invalid of [
    { ...large, source: { ...source, bytesScanned: 33554433 } },
    { ...large, source: { ...source, bytesScanned: 500 } },
    { ...large, source: { ...source, maxRecordBytes: 2097153 } },
    { ...large, source: { ...source, scannedRanges: [{ startByte: offset + 100, endByte: tail.endByte }] } },
    { ...large, source: { ...source, scannedRanges: [{ startByte: 0, endByte: offset + 500 }] } },
  ]) assert.equal(analysisContextSnapshotSchema.safeParse(invalid).success, false);
});
