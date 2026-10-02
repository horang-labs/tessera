import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { evidenceHash, readAnalysisContext, readAutorunEvidence } from '../src/lib/automation/autorun-context';
import { fixture } from './helpers/autorun-native-fixture';
import { autorunFixture } from './autorun-fixture';

// Codex 0.159.2 models.rs FunctionCallOutputBody is text or content items.
// D005's actual read-only custom tool returned two input_text blocks.
const structuredOutput = [{ type: 'input_text', text: 'Script completed\nOutput:' },
  { type: 'input_text', text: 'FIRST_CONTEXT_528\n' }];
const prompt = 'Read phase-one.txt and report FIRST_CONTEXT_528.';
async function nativeTurn(output: unknown, type = 'custom_tool_call') {
  const f = await fixture('codex');
  assert.equal(f.request.correlation.provider, 'codex');
  const turnId = f.request.correlation.provider === 'codex' ? f.request.correlation.nativeTurnId : '';
  const records = [
    { type: 'session_meta', payload: { id: f.request.providerConversationId, thread_source: 'user' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'turn_context', payload: { turn_id: turnId } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', payload: { type, call_id: 'owned-call', name: 'exec_command', arguments: '{}' } },
    { type: 'response_item', payload: { type: type + '_output', call_id: 'owned-call', output } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIRST_CONTEXT_528' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'FIRST_CONTEXT_528' } },
  ];
  const bytes = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
  await fs.writeFile(f.file, bytes);
  return { ...f, records, bytes, turnId };
}
test('completed Codex structured tool output preserves verified human provenance and captured native evidence', async () => {
  const f = await nativeTurn(structuredOutput);
  try {
    const turn = { kind: 'completed' as const, boundary: f.request.expectedBoundary, correlation: f.request.correlation };
    const evidence = await readAutorunEvidence({ ...f.request, turnEvidence: turn, goalRevision: 1, previousHumanSourceIds: [] }, {
      ...f.deps, readHumanSubmissions: async () => [{ nativeId: f.turnId, sourceIdentityHash: f.source.identityHash,
        fileGeneration: f.source.fileGeneration, text: prompt, textHash: evidenceHash(prompt), origin: 'human',
        observerSubmissionId: f.request.correlation.observerSubmissionId }],
    });
    assert.ok(evidence.kind === 'ok' && evidence.goal.kind === 'verified');
    const context = await readAnalysisContext(f.request, f.deps);
    assert.equal(context.kind, 'ok');
    if (context.kind !== 'ok') return;
    assert.equal(context.snapshot.items.find(i => i.role === 'tool-result')?.text, 'Script completed\nOutput:\nFIRST_CONTEXT_528\n');
    assert.equal(context.snapshot.items.at(-1)?.text, 'FIRST_CONTEXT_528');
    assert.equal(context.snapshot.contentHash, evidenceHash(f.bytes));
    assert.equal(context.snapshot.cutoff.endByte, f.bytes.length);
    assert.equal(context.snapshot.coverage.latestTurnComplete, true);
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
for (const type of ['function_call', 'custom_tool_call']) test(`${type} accepts pinned string and structured output forms`, async () => {
  for (const output of ['FIRST_CONTEXT_528', structuredOutput]) {
    const f = await nativeTurn(output, type);
    try {
      const result = await readAnalysisContext(f.request, f.deps);
      assert.equal(result.kind, 'ok');
      if (result.kind === 'ok') assert.equal(result.snapshot.items.find(i => i.role === 'tool-result')?.text,
        typeof output === 'string' ? 'FIRST_CONTEXT_528' : 'Script completed\nOutput:\nFIRST_CONTEXT_528\n');
    } finally { await fs.rm(f.dir, { recursive: true }); }
  }
});
test('structured output retains bounded text and marks omitted nontext without leaking media payloads', async () => {
  const f = await nativeTurn([{ type: 'input_text', text: 'HEAD' + 'x'.repeat(10_000) + 'TAIL' },
    { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_MEDIA' }]);
  try {
    const result = await readAnalysisContext(f.request, f.deps);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    const tool = result.snapshot.items.find(i => i.role === 'tool-result');
    assert.ok(tool?.text.startsWith('HEAD') && tool.text.endsWith('TAIL'));
    assert.ok(Buffer.byteLength(tool.text) <= 4096);
    assert.equal(tool.omission, 'head-tail');
    assert.equal(result.snapshot.coverage.toolTruncation, true);
    assert.ok(result.snapshot.items.some(i => i.role === 'omitted' && i.omission === 'non-text'));
    assert.ok(!JSON.stringify(result.snapshot.items).includes('PRIVATE_MEDIA'));
    await fs.writeFile(f.file, f.bytes.toString().replace('PRIVATE_MEDIA', 'CHANGED_MEDIA'));
    const changed = await readAnalysisContext(f.request, f.deps);
    assert.ok(changed.kind === 'ok' && changed.snapshot.contentHash !== result.snapshot.contentHash);
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('nontext-only output is explicit and malformed or unknown wire shapes fail closed', async () => {
  for (const output of [[{ type: 'input_audio', audio_url: 'private-audio' }], [{ type: 'input_text', text: 1 }],
    [{ type: 'unknown', text: 'unproven' }], { text: 'unproven' }, [null]]) {
    const f = await nativeTurn(output);
    try {
      const result = await readAnalysisContext(f.request, f.deps);
      if (Array.isArray(output) && output[0]?.type === 'input_audio') {
        assert.equal(result.kind, 'ok');
        if (result.kind === 'ok') assert.deepEqual(result.snapshot.items.filter(i => i.role === 'tool-result').map(i => [i.text, i.omission]),
          [['[Nontext tool output]', 'non-text']]);
      } else assert.deepEqual(result, { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'malformed' });
    } finally { await fs.rm(f.dir, { recursive: true }); }
  }
});
test('structured output does not weaken source identity, call pairing or binding freshness', async () => {
  const f = await nativeTurn(structuredOutput);
  try {
    assert.deepEqual(await readAnalysisContext({ ...f.request, correlation: { ...f.request.correlation, fileGeneration: 'foreign' } }, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'binding-mismatch' });
    assert.deepEqual(await readAnalysisContext(f.request, { ...f.deps, verifyBinding: async () => false }),
      { kind: 'unavailable', code: 'ANALYSIS_STALE', reason: 'stale' });
    const altered = f.records.map(r => r.payload.type === 'custom_tool_call_output' ? { ...r, payload: { ...r.payload, call_id: 'foreign-call' } } : r);
    await fs.writeFile(f.file, altered.map(r => JSON.stringify(r) + '\n').join(''));
    assert.deepEqual(await readAnalysisContext(f.request, f.deps),
      { kind: 'unavailable', code: 'CONTEXT_INCOMPLETE', reason: 'unresolved-tools' });
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('completed Codex native output reaches Autorun preview through the runtime capture seam without a model call', async () => {
  const f = await autorunFixture(), native = await nativeTurn(structuredOutput);
  try {
    const turn = f.runtime.autorun!.readTurnEvidence({ userId: 'owner-1', agentEnvironment: 'wsl', sessionId: 'session-1' });
    assert.equal(turn.kind, 'completed');
    if (turn.kind !== 'completed' || turn.correlation.provider !== 'codex') return;
    const correlation = turn.correlation;
    const records = native.records.map(r => ({ ...r, payload: { ...r.payload,
      ...(r.type === 'session_meta' ? { id: correlation.providerConversationId } : {}),
      ...('turn_id' in r.payload ? { turn_id: correlation.nativeTurnId } : {}) } }));
    await fs.writeFile(native.file, records.map(r => JSON.stringify(r) + '\n').join(''));
    f.provider.readAnalysisContext = request => readAnalysisContext(request, native.deps);
    f.provider.readAutorunEvidence = request => readAutorunEvidence(request, { ...native.deps,
      readHumanSubmissions: async () => [{ nativeId: correlation.nativeTurnId, sourceIdentityHash: correlation.sourceIdentityHash,
        fileGeneration: correlation.fileGeneration, text: prompt, textHash: evidenceHash(prompt), origin: 'human',
        observerSubmissionId: correlation.observerSubmissionId }] });
    const preview = await f.service.autorun.preview('owner-1', 'session-1');
    assert.equal(preview.objective?.kind, 'verified-human');
    assert.equal(preview.readiness.kind, 'completed');
    if (preview.readiness.kind === 'completed') assert.equal(preview.readiness.fresh, true);
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.bytes, []);
  } finally { await f.close(); await fs.rm(native.dir, { recursive: true }); }
});
