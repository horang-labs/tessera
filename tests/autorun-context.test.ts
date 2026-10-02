import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAnalysisContext } from '../src/lib/automation/autorun-context';
import { boundary, contextSnapshot } from './fixtures/autorun-contracts';
import type { AnalysisSnapshotRequest } from '../src/lib/cli/providers/session-types';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function fixture(provider: 'claude-code' | 'codex') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorun-context-'));
  const file = path.join(dir, 'native.jsonl');
  const bytes = await fs.readFile(`tests/fixtures/autorun-proof/${provider === 'codex' ? 'codex' : 'claude'}.jsonl`);
  await fs.writeFile(file, bytes);
  const conversation = provider === 'codex' ? '01a0fd47-096d-7641-94f0-0013775e02e4' : 'c9303786-fff6-4b22-810e-07a5ba5b06a6';
  const correlation = provider === 'codex' ? { ...contextSnapshot().correlation, provider: 'codex' as const, nativeTurnId: '01a0fd47-098b-74c2-ab46-5a4d33836280' }
    : { ...contextSnapshot().correlation, provider: 'claude-code' as const, nativePromptId: '7ab43974-3790-40ac-bf63-6fb3b2eed4fa', stopTextHash: hash('PROOF_OK') };
  delete (correlation as Record<string, unknown>).nativeTurnId;
  if (provider === 'codex') Object.assign(correlation, { nativeTurnId: '01a0fd47-098b-74c2-ab46-5a4d33836280' });
  const request: AnalysisSnapshotRequest = { userId: boundary.userId, agentEnvironment: 'wsl', sessionId: boundary.sessionId,
    providerConversationId: conversation, expectedBoundary: boundary, inputEpoch: 'epoch', workerSelection: { ...contextSnapshot().workerSelection, provider },
    correlation: { ...correlation, providerConversationId: conversation, startByte: 0 }, signal: new AbortController().signal };
  const source = { path: file, canonicalPath: '/canonical/native.jsonl', identityHash: request.correlation.sourceIdentityHash,
    fileGeneration: request.correlation.fileGeneration, cliVersion: provider === 'codex' ? '0.159.2' : '2.1.284' };
  return { dir, file, bytes, request, source, deps: { resolveSource: async () => source, verifyBinding: async () => true, flushWaitMs: 0 } };
}
test('Claude binds identical final text to distinct native prompt lineage and cuts off later turns', async () => {
  const f = await fixture('claude-code');
  try {
    const first = await readAnalysisContext(f.request, f.deps);
    assert.equal(first.kind, 'ok');
    if (first.kind !== 'ok' || first.snapshot.cutoff.provider !== 'claude-code') return;
    assert.equal(first.snapshot.cutoff.terminalRecordId, '754f6881-5d70-41cc-9e82-32d0c90bbb8d');
    assert.ok(!first.snapshot.items.some(i => i.text.includes('Again reply')));
    const second = await readAnalysisContext({ ...f.request, correlation: { ...f.request.correlation,
      provider: 'claude-code', nativePromptId: 'b5eadbbd-547d-4bce-b447-0b8bfa67ab48', stopTextHash: hash('PROOF_OK') } }, f.deps);
    assert.equal(second.kind, 'ok');
    if (second.kind === 'ok' && second.snapshot.cutoff.provider === 'claude-code') {
      assert.equal(second.snapshot.cutoff.terminalRecordId, '1996e946-6f39-487a-80ad-bbae88e742d5');
      assert.ok(second.snapshot.source.endByte > first.snapshot.source.endByte);
    }
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('Codex requires lead metadata, exact lifecycle turn and error-free durable completion', async () => {
  const f = await fixture('codex');
  try {
    const result = await readAnalysisContext(f.request, f.deps);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok' && result.snapshot.cutoff.provider === 'codex') {
      assert.equal(result.snapshot.cutoff.turnId, '01a0fd47-098b-74c2-ab46-5a4d33836280');
      assert.equal(result.snapshot.items.at(-1)?.text, 'PROOF_OK');
    }
    await fs.writeFile(f.file, f.bytes.toString().replace('"type":"task_complete"', '"type":"task_complete","error":"failure"'));
    assert.equal((await readAnalysisContext(f.request, f.deps)).kind, 'unavailable');
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('large histories use bounded header/tail scans while proving the complete latest turn at absolute offsets', async () => {
  const f = await fixture('codex');
  try {
    const records = f.bytes.toString().trimEnd().split('\n');
    const handle = await fs.open(f.file, 'w');
    await handle.write(records[0] + '\n');
    const padding = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(1024) } }) + '\n';
    const paddingBlock = padding.repeat(1024);
    for (let n = 0; n < 40; n++) await handle.write(paddingBlock);
    const tailStart = (await handle.stat()).size;
    await handle.write(records.slice(1).join('\n') + '\n');
    await handle.close();
    const result = await readAnalysisContext({ ...f.request, correlation: { ...f.request.correlation, startByte: tailStart } }, f.deps);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.ok(result.snapshot.source.latestTurnStartByte > 40 * 1024 * 1024);
      assert.ok(result.snapshot.source.bytesScanned <= 32 * 1024 * 1024);
      assert.equal(result.snapshot.coverage.kind, 'bounded');
      assert.ok(result.snapshot.coverage.omittedBytes > 0);
    }
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
import { readAutorunEvidence, hashWorkerEvidence } from '../src/lib/automation/autorun-context';
test('first running turn exposes independently verified human goal without a completed snapshot or model call', async () => {
  const f = await fixture('claude-code');
  try {
    const text = 'Reply exactly PROOF_OK. Do not use tools.';
    const { completionHookId: _hook, stopTextHash: _hash, ...submission } = f.request.correlation as Extract<typeof f.request.correlation, { provider: 'claude-code' }>;
    void _hook; void _hash;
    const result = await readAutorunEvidence({ ...f.request, turnEvidence: { kind: 'running', acceptedTurn: boundary, submission },
      goalRevision: 1, previousHumanSourceIds: [], signal: f.request.signal }, { ...f.deps,
      readHumanSubmissions: async () => [{ nativeId: submission.nativePromptId, sourceIdentityHash: submission.sourceIdentityHash,
        fileGeneration: submission.fileGeneration, text, textHash: hash(text), origin: 'human', observerSubmissionId: submission.observerSubmissionId }] });
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.turnEvidence.kind, 'running');
      assert.equal(result.goal.kind, 'verified');
      if (result.goal.kind === 'verified') assert.equal(result.goal.objective.text, text);
    }
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('a durable-looking final refuses delayed partial flush, foreign binding, runtime drift and unresolved tools', async () => {
  const f = await fixture('claude-code');
  try {
    const finalStart = f.bytes.indexOf(Buffer.from('{"type":"assistant"'));
    const finalEnd = f.bytes.indexOf(10, finalStart);
    await fs.writeFile(f.file, f.bytes.subarray(0, finalEnd));
    const partial = await readAnalysisContext(f.request, f.deps);
    assert.deepEqual(partial, { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'flush-pending' });
    await fs.writeFile(f.file, f.bytes);
    assert.equal((await readAnalysisContext({ ...f.request, providerConversationId: 'foreign' }, f.deps)).kind, 'unavailable');
    let checks = 0;
    assert.deepEqual(await readAnalysisContext(f.request, { ...f.deps, verifyBinding: async () => ++checks === 1 }),
      { kind: 'unavailable', code: 'ANALYSIS_STALE', reason: 'stale' });
    const altered = f.bytes.toString().replace('"text":"PROOF_OK"', '"text":"PROOF_OK"},{"type":"tool_use","id":"unpaired","name":"Read","input":{}');
    await fs.writeFile(f.file, altered);
    assert.deepEqual(await readAnalysisContext(f.request, f.deps), { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'unresolved-tools' });
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('delayed native completion is retried within the flush deadline without a model call', async () => {
  const f = await fixture('codex');
  try {
    const end = f.bytes.indexOf(Buffer.from('{"type":"event_msg","payload":{"turn_id":"01a0fd47-098b-74c2-ab46-5a4d33836280","type":"task_complete"'));
    await fs.writeFile(f.file, f.bytes.subarray(0, end));
    const timer = setTimeout(() => { void fs.writeFile(f.file, f.bytes); }, 20);
    const result = await readAnalysisContext(f.request, { ...f.deps, flushWaitMs: 500 });
    clearTimeout(timer); assert.equal(result.kind, 'ok');
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('Claude native bookkeeping cannot replace lineage, but does not make a proven turn unusable', async () => {
  const f = await fixture('claude-code');
  try {
    const firstAssistant = f.bytes.indexOf(Buffer.from('{"type":"assistant"'));
    const note = JSON.stringify({ type: 'atis-latch', sessionId: f.request.providerConversationId }) + '\n';
    await fs.writeFile(f.file, Buffer.concat([f.bytes.subarray(0, firstAssistant), Buffer.from(note), f.bytes.subarray(firstAssistant)]));
    assert.equal((await readAnalysisContext(f.request, f.deps)).kind, 'ok');
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('context content hash detects human-record rewrites while worker-evidence hash ignores IDs and timestamps', async () => {
  const f = await fixture('claude-code');
  try {
    const before = await readAnalysisContext(f.request, f.deps);
    await fs.writeFile(f.file, f.bytes.toString().replace('Reply exactly PROOF_OK.', 'Reply safely PROOF_OK.'));
    const after = await readAnalysisContext(f.request, f.deps);
    assert.ok(before.kind === 'ok' && after.kind === 'ok');
    if (before.kind === 'ok' && after.kind === 'ok') {
      assert.notEqual(before.snapshot.contentHash, after.snapshot.contentHash);
      assert.equal(hashWorkerEvidence(before.snapshot.items), hashWorkerEvidence(after.snapshot.items.map(i => ({ ...i, id: 'changed-' + i.id }))));
    }
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
