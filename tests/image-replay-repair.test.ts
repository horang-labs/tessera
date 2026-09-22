import assert from 'node:assert/strict';
import test from 'node:test';
import { repairReplayedInputs, type ReplayedInvocation } from '../src/lib/image-generation/replay-repair';
import type { ImageIndexState } from '../src/lib/image-generation/incremental-state';
import type { ImageGenerationTrace } from '../src/lib/image-generation/traces';
import { applyReplayWorkerFailure, replayFailureReason, UNRESOLVED_INPUT_REFERENCES } from '../src/lib/image-generation/replay-diagnostics';
import { normalizeImageTraces } from '../src/lib/image-generation/trace-identity';
import { restoreOwnedImages } from '../src/lib/image-generation/owned-images';

const timestamp = '2026-09-13T00:00:00.000Z';
const trace = (id: string, extra: Partial<ImageGenerationTrace> = {}): ImageGenerationTrace => ({
  id, invocationMessageId: id, prompt: 'same prompt', inputs: [], unresolvedInputCount: 1,
  status: 'completed', timestamp, ...extra,
});
const state = (traces: ImageGenerationTrace[]): ImageIndexState => ({ traces, ledger: [], pending: [], seenResults: [] });
const invocation = (ordinal: number, extra: Partial<ReplayedInvocation> = {}): ReplayedInvocation => ({
  callId: 'batch', ordinal, prompt: 'same prompt', referencedImagePaths: [`/input/${ordinal}.png`],
  resultId: `result${ordinal}`, timestamp, status: 'completed', ...extra,
});

test('partial batches replace failed placeholders and remain unique across repeated reconciliation', () => {
  const failed = trace('batch-0', { status: 'error', result: undefined });
  const result = trace('result-hist-tool-result0', { resultMessageId: 'result0',
    result: { source: 'generated', label: 'result', locator: { kind: 'cache', path: '/result.png' } } });
  for (const originals of [[failed, result], [result, failed], [failed, result, failed]]) {
    const index = state(originals);
    const calls = [invocation(0), invocation(1, { resultId: undefined, status: 'running' })];
    for (let retry = 0; retry < 5; retry++) {
      repairReplayedInputs(index, calls);
      assert.equal(index.traces.length, 2);
      assert.equal(new Set(index.traces.map(t => t.id)).size, 2);
      const served = index.traces.find(t => t.id === 'batch-0')!;
      assert.equal(served.result?.locator.kind, 'cache');
      assert.equal(served.inputs.length, 1);
      assert.equal(served.status, 'completed');
      assert.deepEqual(index.pending, ['batch-1']);
    }
  }
});

test('legacy duplicate cards normalize independently of failed-card order and preserve distinct results', () => {
  const completed = trace('batch-0', { resultMessageId: 'one',
    result: { source: 'generated', label: 'one', locator: { kind: 'cache', path: '/one' } } });
  const failed = trace('batch-0', { status: 'error' });
  for (const cards of [[failed, completed], [completed, failed]]) {
    assert.deepEqual(normalizeImageTraces(cards), [completed]);
  }
  const other = { ...completed, resultMessageId: 'two', result: { ...completed.result!, label: 'two', locator: { kind: 'cache' as const, path: '/two' } } };
  const normalized = normalizeImageTraces([failed, completed, other, { ...completed, id: 'result-hist-tool-one' }]);
  assert.equal(normalized.length, 2);
  assert.equal(new Set(normalized.map(t => t.id)).size, 2);
  assert.deepEqual(new Set(normalized.map(t => t.resultMessageId)), new Set(['one', 'two']));
  assert.deepEqual(normalizeImageTraces(normalized), normalized);
});

test('empty and partially cached references retry missing files without discarding existing cache ownership', () => {
  const index = state([trace('batch-0', { referencedImagePaths: ['/input/0.png'], inputs: [], unresolvedInputCount: 1 })]);
  assert.equal(repairReplayedInputs(index, [invocation(0)]).length, 1);
  assert.equal(index.traces[0].inputs[0].locator.kind, 'path');
  const cached = { source: 'explicit-path' as const, label: '/input/1.png', locator: { kind: 'cache' as const, path: '/owned.png' } };
  const partial = state([trace('batch-0', { referencedImagePaths: ['/input/0.png', '/input/1.png'], inputs: [cached], unresolvedInputCount: 1 })]);
  assert.equal(repairReplayedInputs(partial, [invocation(0, { referencedImagePaths: ['/input/0.png', '/input/1.png'] })]).length, 1);
  assert.equal(partial.traces[0].inputs[0].locator.kind, 'path');
  assert.equal(partial.traces[0].inputs[1], cached);
});

test('loss of result association retains the observed result without duplicate IDs or phantom growth', () => {
  const index = state([trace('batch-0', { resultMessageId: 'result0',
    result: { source: 'generated', label: 'observed', locator: { kind: 'cache', path: '/observed' } } })]);
  const calls = [invocation(0, { resultId: undefined, status: 'running' })];
  for (let retry = 0; retry < 4; retry++) {
    repairReplayedInputs(index, calls);
    assert.equal(index.traces.length, 2);
    assert.equal(new Set(index.traces.map(t => t.id)).size, 2);
    assert.equal(index.traces.find(t => t.resultMessageId === 'result0')?.result?.label, 'observed');
  }
  repairReplayedInputs(index, [invocation(0)]);
  assert.equal(index.traces.length, 1);
  assert.equal(index.traces[0].result?.label, 'observed');
});

test('an empty placeholder cannot discard input files already owned by the exact result', () => {
  const inputs: ImageGenerationTrace['inputs'] = [{ source: 'explicit-path', label: '/input/0.png', locator: { kind: 'cache', path: '/owned.png' } }];
  const index = state([
    trace('batch-0', { status: 'error', referencedImagePaths: ['/input/0.png'], inputs: [] }),
    trace('result-hist-tool-result0', { resultMessageId: 'result0', referencedImagePaths: ['/input/0.png'], inputs, unresolvedInputCount: 0 }),
  ]);
  assert.deepEqual(repairReplayedInputs(index, [invocation(0)]), []);
  assert.equal(index.traces.length, 1);
  assert.equal(index.traces[0].inputs, inputs);
});

test('mixed legacy aliases preserve every result and normalize idempotently across input orders', () => {
  const cards = Array.from({ length: 30 }, (_, n) => trace(n % 3 ? `batch-${n % 4}` : `result-hist-tool-result${n % 10}`, {
    resultMessageId: `result${n % 10}`,
    result: { source: 'generated', label: `result${n % 10}`, locator: { kind: 'cache', path: `/result${n % 10}` } },
  }));
  cards.push(...Array.from({ length: 4 }, (_, n) => trace(`batch-${n}`, { status: 'error' })));
  let seed = 1234;
  for (let run = 0; run < 50; run++) {
    const shuffled = [...cards];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const normalized = normalizeImageTraces(shuffled);
    assert.equal(new Set(normalized.map(t => t.id)).size, normalized.length);
    assert.equal(new Set(normalized.map(t => t.resultMessageId).filter(Boolean)).size, 10);
    for (const t of normalized.filter(t => t.result)) assert.equal(t.result?.label, t.resultMessageId);
    assert.deepEqual(normalizeImageTraces(normalized), normalized);
  }
});

test('repairs three out-of-order orphan results using result identity', () => {
  const index = state([2, 0, 1].map((n) => trace(`result-hist-tool-result${n}`, {
    result: { source: 'generated', label: `${n}`, locator: { kind: 'cache', path: `/cache/${n}` } },
  })));
  const changed = repairReplayedInputs(index, [0, 1, 2].map((n) => invocation(n)));
  assert.equal(changed.length, 3);
  assert.equal(index.traces.length, 3);
  for (let n = 0; n < 3; n++) {
    const repaired = index.traces.find((entry) => entry.id === `batch-${n}`)!;
    assert.equal(repaired.result?.label, `${n}`);
    assert.deepEqual(repaired.referencedImagePaths, [`/input/${n}.png`]);
  }
});

test('identical retry prompts never select an unrelated result', () => {
  const unrelated = trace('result-hist-tool-unrelated');
  const index = state([unrelated]);
  repairReplayedInputs(index, [invocation(0, { resultId: 'retry' })]);
  assert.equal(index.traces.length, 2);
  assert.equal(index.traces.find((entry) => entry.id === 'batch-0')?.result, undefined);
  assert.ok(unrelated.inputResolutionError);
  assert.equal(unrelated.unresolvedInputCount, 0);
});

test('complete evidence removes same-call phantom cards and pending entries only', () => {
  const index = state([
    trace('batch-0', { invocationMessageId: 'hist-tool-batch', status: 'error' }),
    trace('batch-8', { invocationMessageId: 'hist-tool-batch', status: 'running' }),
    trace('other-0', { status: 'running' }), trace('result-hist-tool-result0'),
  ]);
  index.pending = ['batch-8', 'other-0'];
  repairReplayedInputs(index, [invocation(0)]);
  assert.deepEqual(index.traces.map((entry) => entry.id).sort(), ['batch-0', 'other-0']);
  assert.deepEqual(index.pending, ['other-0']);
});

test('unchanged references preserve cached input files', () => {
  const inputs: ImageGenerationTrace['inputs'] = [{ source: 'explicit-path', label: '/input/0.png', locator: { kind: 'cache', path: '/cached.png' } }];
  const index = state([trace('batch-0', { referencedImagePaths: ['/input/0.png'], inputs, unresolvedInputCount: 0 })]);
  assert.deepEqual(repairReplayedInputs(index, [invocation(0)]), []);
  assert.equal(index.traces[0].inputs, inputs);
});

test('swapped result associations retain each result and repair call metadata', () => {
  const index = state([trace('batch-0', { resultMessageId: 'result1', result: { source: 'generated', label: 'one', locator: { kind: 'cache', path: '/one' } } }),
    trace('batch-1', { resultMessageId: 'result0', result: { source: 'generated', label: 'zero', locator: { kind: 'cache', path: '/zero' } } })]);
  repairReplayedInputs(index, [invocation(0), invocation(1)]);
  assert.equal(index.traces.length, 2);
  assert.equal(index.traces.find((entry) => entry.id === 'batch-0')?.result?.label, 'zero');
  assert.equal(index.traces.find((entry) => entry.id === 'batch-1')?.result?.label, 'one');
});

test('unavailable recent images report reconstruction failure without invented count', () => {
  const index = state([]);
  repairReplayedInputs(index, [invocation(0, { referencedImagePaths: undefined, numLastImagesToInclude: 3 })]);
  assert.ok(index.traces[0].inputResolutionError);
  assert.equal(index.traces[0].unresolvedInputCount, 0);
});

test('a known recent occurrence with absent image bytes reports a missing input instead of a broken thumbnail', () => {
  const index = state([]);
  repairReplayedInputs(index, [invocation(0, { referencedImagePaths: undefined, numLastImagesToInclude: 1,
    recentImages: [{ source: 'conversation', label: 'Conversation image', sourceMessageId: 'user-image', locator: { kind: 'cache', path: '' } }] })]);
  assert.equal(index.traces[0].inputs.length, 0);
  assert.equal(index.traces[0].unresolvedInputCount, 1);
});

test('rebuilding cannot resurrect removed results, offset-only user images or conflicting owned files', () => {
  const owned = { source: 'generated' as const, label: 'Generated image', sourceMessageId: 'hist-tool-one', locator: { kind: 'cache' as const, path: '/one.png' } };
  const index = state([trace('result-hist-tool-two', { resultMessageId: 'two' })]);
  index.ledger = [{ ...owned, sourceMessageId: 'hist-tool-two', locator: { kind: 'cache', path: '' } },
    { source: 'conversation', sourceMessageId: 'image-42-0', label: 'Image', locator: { kind: 'cache', path: '' } }];
  restoreOwnedImages(index, [trace('result-hist-tool-one', { result: owned, resultMessageId: 'one' })],
    [owned, { ...index.ledger[1], locator: { kind: 'cache', path: '/old-offset-image.png' } }]);
  assert.equal(index.traces.length, 1); assert.equal(index.traces[0].result, undefined);
  assert.ok(index.ledger.every(i => i.locator.kind === 'cache' && !i.locator.path));
  index.traces = [trace('result-hist-tool-one', { resultMessageId: 'one' })];
  restoreOwnedImages(index, [], [owned, { ...owned, locator: { kind: 'cache', path: '/conflicting.png' } }]);
  assert.equal(index.traces[0].result, undefined);
});

test('recent inline and path inputs are returned for caching', () => {
  const index = state([]);
  const recentImages: ImageGenerationTrace['inputs'] = [
    { source: 'conversation', label: 'Conversation image 1', sourceMessageId: 'user-1', locator: { kind: 'inline', data: 'aGVsbG8=', mimeType: 'image/png' } },
    { source: 'file', label: '/recent.png', sourceMessageId: 'tool-1', locator: { kind: 'path', path: '/recent.png' } },
  ];
  const changed = repairReplayedInputs(index, [invocation(0, { referencedImagePaths: undefined, numLastImagesToInclude: 2, recentImages })]);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].inputs, recentImages);
});

test('same recent occurrence preserves cached locator but a new occurrence is cached', () => {
  const cached: ImageGenerationTrace['inputs'][number] = { source: 'file', label: '/recent.png', sourceMessageId: 'tool-1', locator: { kind: 'cache', path: '/cached-recent.png' } };
  const index = state([trace('batch-0', { numLastImagesToInclude: 1, inputs: [cached], unresolvedInputCount: 0 })]);
  const call = invocation(0, { referencedImagePaths: undefined, numLastImagesToInclude: 1,
    recentImages: [{ ...cached, locator: { kind: 'path', path: '/recent.png' } }] });
  assert.deepEqual(repairReplayedInputs(index, [call]), []);
  assert.equal(index.traces[0].inputs[0], cached);
  const changed = repairReplayedInputs(index, [{ ...call, recentImages: [{ ...call.recentImages![0], sourceMessageId: 'tool-2' }] }]);
  assert.equal(changed.length, 1);
  assert.equal(index.traces[0].inputs[0].locator.kind, 'path');
});

test('completed orphan retains cached inputs from its pending call', () => {
  const inputs: ImageGenerationTrace['inputs'] = [{ source: 'explicit-path', label: '/input/0.png', locator: { kind: 'cache', path: '/cached.png' } }];
  const index = state([trace('batch-0', { status: 'running', referencedImagePaths: ['/input/0.png'], inputs, unresolvedInputCount: 0 }), trace('result-hist-tool-result0')]);
  index.pending = ['batch-0'];
  assert.deepEqual(repairReplayedInputs(index, [invocation(0)]), []);
  assert.equal(index.traces.length, 1);
  assert.equal(index.traces[0].inputs, inputs);
  assert.equal(index.traces[0].status, 'completed');
  assert.deepEqual(index.pending, []);
});

test('call diagnostics reach only exact unresolved result identities, preserving earlier successful inputs', () => {
  const index = state(['first', 'later', 'unrelated'].map(id => trace(`result-hist-tool-${id}`, {
    resultMessageId: id, inputResolutionError: UNRESOLVED_INPUT_REFERENCES, unresolvedInputCount: 0,
  })));
  repairReplayedInputs(index, [invocation(0, { resultId: 'first' })], [{
    callId: 'batch', resultIds: ['first', 'later'], error: "ReferenceError: 'yield_control' is not defined",
  }]);
  const first = index.traces.find(card => card.resultMessageId === 'first')!;
  assert.equal(first.inputs.length, 1);
  assert.equal(first.inputResolutionError, undefined);
  assert.match(index.traces.find(card => card.resultMessageId === 'later')!.inputResolutionError!, /function or variable/);
  assert.equal(index.traces.find(card => card.resultMessageId === 'unrelated')!.inputResolutionError, UNRESOLVED_INPUT_REFERENCES);
});

test('diagnostics never associate orphan results by prompt or adjacent call position', () => {
  const index = state([trace('result-hist-tool-orphan', { inputResolutionError: UNRESOLVED_INPUT_REFERENCES })]);
  repairReplayedInputs(index, [], [{ callId: 'batch', error: 'SyntaxError: invalid token' }]);
  assert.equal(index.traces[0].inputResolutionError, UNRESOLVED_INPUT_REFERENCES);
});

test('conflicting result ownership does not choose a diagnostic', () => {
  const index = state([trace('result-hist-tool-orphan', { inputResolutionError: UNRESOLVED_INPUT_REFERENCES })]);
  repairReplayedInputs(index, [], [
    { callId: 'one', resultIds: ['orphan'], error: 'SyntaxError' },
    { callId: 'two', resultIds: ['orphan'], error: 'ReferenceError' },
  ]);
  assert.equal(index.traces[0].inputResolutionError, UNRESOLVED_INPUT_REFERENCES);
});

test('later successful replay clears a previous call failure', () => {
  const index = state([trace('result-hist-tool-result0', { inputResolutionError: UNRESOLVED_INPUT_REFERENCES })]);
  repairReplayedInputs(index, [], [{ callId: 'batch', resultIds: ['result0'], unresolved: 'Unrecorded return field: value' }]);
  assert.match(index.traces[0].inputResolutionError!, /missing from the recording/);
  repairReplayedInputs(index, [invocation(0)]);
  assert.equal(index.traces.length, 1);
  assert.equal(index.traces[0].inputResolutionError, undefined);
});

test('worker failure reports session replay limits without replacing successful inputs or a known call failure', () => {
  const index = state([
    trace('unresolved', { inputResolutionError: UNRESOLVED_INPUT_REFERENCES }),
    trace('resolved', { unresolvedInputCount: 0 }),
    trace('specific', { inputResolutionError: 'Input reference replay failed: A tool return value is missing.' }),
  ]);
  applyReplayWorkerFailure(index, new Error('Replay recording memory limit exceeded'));
  assert.equal(index.traces[0].inputResolutionError, 'Input reference replay could not run: The replay memory limit was reached.');
  assert.equal(index.traces[1].inputResolutionError, undefined);
  assert.equal(index.traces[2].inputResolutionError, 'Input reference replay failed: A tool return value is missing.');
});

test('diagnostic UI explanations are bounded and never echo arbitrary transcript contents', () => {
  assert.equal(replayFailureReason('private tool output '.repeat(10000)), 'The recorded call could not be replayed with the available metadata.');
  assert.match(replayFailureReason('Image body descriptor is unavailable during metadata replay'), /image contents/);
  assert.match(replayFailureReason('Repeated prompts cannot be uniquely associated with image results.'), /uniquely matched/);
  assert.match(replayFailureReason('Image replay time limit exceeded'), /time limit/);
  assert.match(replayFailureReason('Historical tool catalog is unavailable'), /tool catalog/);
  assert.match(replayFailureReason('Timer and recorded tool completion ordering is unknown'), /completion order/);
  assert.match(replayFailureReason('Replay state unavailable after interruption'), /earlier call/);
  assert.match(replayFailureReason('Execution was terminated'), /terminated/);
});

test('a successful worker retry removes stale worker failures even if result association remains unknown', () => {
  const index = state([trace('result-hist-tool-orphan', { inputResolutionError: UNRESOLVED_INPUT_REFERENCES })]);
  applyReplayWorkerFailure(index, new Error('Image replay time limit exceeded'));
  assert.match(index.traces[0].inputResolutionError!, /time limit/);
  repairReplayedInputs(index, [], []);
  assert.equal(index.traces[0].inputResolutionError, UNRESOLVED_INPUT_REFERENCES);
});

test('a later cell error does not replace the known reason that recent image history is insufficient', () => {
  const index = state([]);
  repairReplayedInputs(index, [invocation(0, { referencedImagePaths: undefined, numLastImagesToInclude: 3 })], [
    { callId: 'batch', resultIds: ['result0'], error: 'ReferenceError: later_variable is not defined' },
  ]);
  assert.match(index.traces[0].inputResolutionError!, /requested 3 recent images, but only 0/);
});
