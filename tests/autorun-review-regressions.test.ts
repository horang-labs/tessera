import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { fixture } from './helpers/autorun-native-fixture';
import { evidenceHash, readAnalysisContext, readAutorunEvidence } from '../src/lib/automation/autorun-context';
import { recordHumanSubmission, readHumanSubmissions } from '../src/lib/automation/autorun-human-evidence';
import { generateSupervisorDecision, defaultSupervisorDependencies } from '../src/lib/cli/providers/autorun-supervisor';
import { SupervisorProcessUncertain } from '../src/lib/cli/providers/autorun-process';
import { contextSnapshot, autorunInput, boundary, autorunPreviewFixture } from './fixtures/autorun-contracts';

test('attestation uncertainty stays uncertain through decision settlement', async () => {
  let cleaned = false;
  const packet = { version: 1 as const, objective: { kind: 'explicit' as const, text: 'Fix login.', revision: 1 },
    criteria: autorunInput().autorun.criteria, criterionOrigin: 'explicit' as const, constraints: [], context: contextSnapshot(), priorDecisions: [] };
  const result = await generateSupervisorDecision({ userId: 'owner', agentEnvironment: 'wsl', selection: autorunInput().autorun.supervisor,
    capability:autorunPreviewFixture().supervisorOptions[0], invocationId: 'probe-uncertain', signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
    packet, outputSchema: {}, trustedInstructions: 'Judge evidence.' }, {
    prepare: async () => ({ root: '/owned', guestRoot: '/owned', command: 'codex', environment: {}, cleanup: async () => { cleaned = true; } }),
    probe: async () => { throw new SupervisorProcessUncertain(); }, claudeModelMetadata: async () => null, writeCatalog:async()=>{},
  });
  assert.ok(result.kind !== 'ok');
  if (result.kind !== 'ok') { assert.equal(result.code, 'SUPERVISOR_PROCESS_UNCERTAIN'); assert.equal(result.settlement.quiescent, false); }
  assert.equal(cleaned, false);
  await assert.rejects(defaultSupervisorDependencies.prepare({ userId: 'owner', agentEnvironment: 'wsl', selection: autorunInput().autorun.supervisor }), SupervisorProcessUncertain);
});

test('capture identity survives append bookkeeping while detecting equal-length native user rewrites', async () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const f = await fixture(provider);
    try {
      const captured = provider === 'codex' ? Buffer.from(f.bytes.toString().replace('{"type":"turn_context"',
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply exactly PROOF_OK.' }] } }) + '\n{"type":"turn_context"')) : f.bytes;
      await fs.writeFile(f.file, captured);
      const before = await readAnalysisContext(f.request, f.deps);
      await fs.appendFile(f.file, JSON.stringify(provider === 'codex' ? { type: 'event_msg', payload: { type: 'token_count' } }
        : { type: 'cost-state', sessionId: f.request.providerConversationId }) + '\n');
      const after = await readAnalysisContext(f.request, f.deps);
      assert.ok(before.kind === 'ok' && after.kind === 'ok');
      if (before.kind === 'ok' && after.kind === 'ok') {
        // R2 compares captured identity, excluding actual read accounting (bytesScanned/maxRecordBytes).
        const identity = (s: typeof before.snapshot) => ({ ...s.source, bytesScanned: undefined, maxRecordBytes: undefined });
        assert.deepEqual(identity(before.snapshot), identity(after.snapshot));
        assert.deepEqual(before.snapshot.cutoff, after.snapshot.cutoff);
        assert.equal(before.snapshot.contentHash, after.snapshot.contentHash);
        assert.deepEqual(before.snapshot.items, after.snapshot.items);
        const rewritten = Buffer.from(captured.toString().replace('Reply exactly', 'Reply EXACTLY'));
        assert.equal(rewritten.length, captured.length);
        await fs.writeFile(f.file, rewritten);
        const changed = await readAnalysisContext(f.request, f.deps);
        assert.equal(changed.kind, 'ok');
        if (changed.kind === 'ok') assert.notEqual(changed.snapshot.contentHash, before.snapshot.contentHash);
      }
    } finally { await fs.rm(f.dir, { recursive: true }); }
  }
});

test('captured identity remains stable when post-cutoff bookkeeping crosses the 32MiB scan threshold', async () => {
  const f = await fixture('codex');
  try {
    const lines = f.bytes.toString().trimEnd().split('\n');
    const base = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', pad: '' } }) + '\n';
    const padding = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', pad: 'x'.repeat(1024 - Buffer.byteLength(base)) } }) + '\n';
    const block = padding.repeat(1024);
    const handle = await fs.open(f.file, 'w');
    await handle.write(lines[0] + '\n');
    for (let n = 0; n < 31; n++) await handle.write(block);
    const cursor = (await handle.stat()).size;
    await handle.write(lines.slice(1).join('\n') + '\n'); await handle.close();
    assert.ok((await fs.stat(f.file)).size < 32 * 1024 * 1024);
    const request = { ...f.request, correlation: { ...f.request.correlation, startByte: cursor } };
    const before = await readAnalysisContext(request, f.deps);
    await fs.appendFile(f.file, block.repeat(2));
    assert.ok((await fs.stat(f.file)).size > 32 * 1024 * 1024);
    const after = await readAnalysisContext(request, f.deps);
    assert.ok(before.kind === 'ok' && after.kind === 'ok');
    if (before.kind === 'ok' && after.kind === 'ok') {
      assert.equal(before.snapshot.contentHash, after.snapshot.contentHash);
      assert.deepEqual(before.snapshot.source.scannedRanges, after.snapshot.source.scannedRanges);
      assert.deepEqual(before.snapshot.items, after.snapshot.items);
      assert.ok(after.snapshot.source.bytesScanned <= 32 * 1024 * 1024);
    }
  } finally { await fs.rm(f.dir, { recursive: true }); }
});

test('Claude rejects a submission cursor inside an older matching turn', async () => {
  const f = await fixture('claude-code');
  try { assert.equal((await readAnalysisContext({ ...f.request, correlation: { ...f.request.correlation, startByte: 1 } }, f.deps)).kind, 'unavailable'); }
  finally { await fs.rm(f.dir, { recursive: true }); }
});

test('unchanged objective Resume uses persisted native recordId and reports no new human instructions', async () => {
  const f = await fixture('claude-code');
  try {
    const native = f.request.correlation;
    const text = 'Reply exactly PROOF_OK. Do not use tools.';
    const submission = { nativeId: '7ab43974-3790-40ac-bf63-6fb3b2eed4fa', sourceIdentityHash: native.sourceIdentityHash,
      fileGeneration: native.fileGeneration, text, textHash: evidenceHash(text), origin: 'human' as const, observerSubmissionId: 'observer' };
    const result = await readAutorunEvidence({ ...f.request, turnEvidence: { kind: 'completed', boundary, correlation: native },
      goalRevision: 2, previousHumanSourceIds: ['42b4cd20-eb3d-4209-9dc6-739b90c5c4a5'] }, { ...f.deps, readHumanSubmissions: async () => [submission] });
    assert.ok(result.kind === 'ok' && result.goal.kind === 'verified');
    if (result.kind === 'ok') assert.deepEqual(result.newHumanInstructions, []);
    const missingCorrection = await readAutorunEvidence({ ...f.request, turnEvidence: { kind: 'completed', boundary, correlation: native },
      goalRevision: 2, previousHumanSourceIds: ['42b4cd20-eb3d-4209-9dc6-739b90c5c4a5'] }, { ...f.deps,
      readHumanSubmissions: async () => [submission, { ...submission, nativeId: 'b5eadbbd-547d-4bce-b447-0b8bfa67ab48',
        text: 'Correction not yet proven in native transcript', textHash: evidenceHash('Correction not yet proven in native transcript') }] });
    assert.ok(missingCorrection.kind === 'ok' && missingCorrection.goal.kind === 'missing');
  } finally { await fs.rm(f.dir, { recursive: true }); }
});

test('durable human-evidence quotas make missing corrections explicit, including later reads', async () => {
  const f = await fixture('claude-code');
  const previous = process.env.TESSERA_DATA_DIR;
  process.env.TESSERA_DATA_DIR = f.dir;
  try {
    const submission = { nativeId: 'first', sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'generation', text: 'Initial objective',
      textHash: evidenceHash('Initial objective'), origin: 'human' as const, observerSubmissionId: 'submit' };
    await recordHumanSubmission('quota-owner', 'session', submission);
    await recordHumanSubmission('quota-owner', 'session', { ...submission, nativeId: 'correction', text: 'x'.repeat(16_385) });
    assert.equal(await readHumanSubmissions('quota-owner', 'session'), null);
    for (let i = 0; i < 101; i++) await recordHumanSubmission('count-owner', 'session', { ...submission, nativeId: `native-${i}` });
    assert.equal(await readHumanSubmissions('count-owner', 'session'), null);
    const result = await readAutorunEvidence({ ...f.request, turnEvidence: { kind: 'completed', boundary, correlation: f.request.correlation },
      goalRevision: 2, previousHumanSourceIds: ['known'] }, { ...f.deps, readHumanSubmissions: async () => null });
    assert.ok(result.kind === 'ok' && result.goal.kind === 'missing');
  } finally { if (previous === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous; await fs.rm(f.dir, { recursive: true }); }
});
