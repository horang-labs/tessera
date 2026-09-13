import assert from 'node:assert/strict';
import test from 'node:test';
import { repairReplayedInputs, type ReplayedInvocation } from '../src/lib/image-generation/replay-repair';
import type { ImageIndexState } from '../src/lib/image-generation/incremental-state';
import type { ImageGenerationTrace } from '../src/lib/image-generation/traces';

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
