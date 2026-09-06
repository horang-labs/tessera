import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readImageTranscriptBatch } from '@/lib/image-generation/incremental-reader';
import { appendImage, applyImageTool, createImageIndex, type ImageIndexState } from '@/lib/image-generation/incremental-state';
import type { EnhancedMessage } from '@/types/chat';

const call = (id: string, status: 'running' | 'completed' = 'running'): Extract<EnhancedMessage, { type: 'tool_call' }> => ({
  id, toolUseId: id, sessionId: 's', type: 'tool_call', toolName: 'Bash', timestamp: '2026-09-05T00:00:00Z', status,
  toolParams: { input: 'tools.image_gen__imagegen({ prompt: "edit", num_last_images_to_include: 1 })' },
});

test('restart keeps image order, frozen references and a pending call across increments', () => {
  let state = createImageIndex();
  appendImage(state, { source: 'conversation', label: 'one', sourceMessageId: 'one', locator: { kind: 'cache', path: '/cache/one.png' } });
  applyImageTool(state, call('call'));
  state = JSON.parse(JSON.stringify(state)) as ImageIndexState;
  appendImage(state, { source: 'conversation', label: 'later', sourceMessageId: 'later', locator: { kind: 'cache', path: '/cache/later.png' } });
  applyImageTool(state, call('call', 'completed'));
  assert.equal(state.traces.length, 1);
  assert.equal(state.traces[0].inputs[0].sourceMessageId, 'one');
  applyImageTool(state, { ...call('result', 'completed'), toolName: 'ImageGeneration',
    toolParams: { _tesseraTranscriptImagePath: '/cache/result.png' } });
  assert.equal(state.traces[0].status, 'completed');
  assert.equal(state.traces[0].result?.locator.kind, 'cache');
  applyImageTool(state, call('second'));
  assert.equal(state.traces[1].inputs[0].sourceMessageId, 'call-0');
});

test('a missing cached occurrence cannot shift selection onto an older image', () => {
  const state = createImageIndex();
  appendImage(state, { source: 'file', label: 'old', sourceMessageId: 'old', locator: { kind: 'cache', path: '/cache/old.png' } });
  appendImage(state, { source: 'file', label: 'missing', sourceMessageId: 'missing', locator: { kind: 'cache', path: '' } });
  applyImageTool(state, call('call'));
  assert.equal(state.traces[0].inputs.length, 0);
  assert.equal(state.traces[0].unresolvedInputCount, 1);
});

test('dynamic reference expressions are unresolved instead of guessed from a literal prefix', () => {
  const state = createImageIndex();
  appendImage(state, { source: 'file', label: 'old', sourceMessageId: 'old', locator: { kind: 'cache', path: '/cache/old.png' } });
  const message = call('dynamic');
  message.toolParams.input = 'tools.image_gen__imagegen({prompt: "edit", num_last_images_to_include: 1 + count})';
  applyImageTool(state, message);
  assert.equal(state.traces[0].inputs.length, 0);
  assert.equal(state.traces[0].unresolvedInputCount, 1);
});

test('two distinct generations with identical pixels preserve both occurrences', () => {
  const state = createImageIndex();
  for (const id of ['a', 'b']) {
    const message = call(id);
    message.toolParams.input = 'tools.image_gen__imagegen({prompt: "create"})';
    applyImageTool(state, message);
    applyImageTool(state, { ...call(`${id}-result`, 'completed'), toolName: 'ImageGeneration', toolParams: { _tesseraTranscriptImagePath: '/cache/same.png' } });
    applyImageTool(state, { ...message, status: 'completed', toolParams: { ...message.toolParams, _tesseraTranscriptImagePath: '/cache/same.png' } });
  }
  assert.equal(state.ledger.length, 2);
  assert.deepEqual(state.ledger.map((image) => image.sourceMessageId), ['a-0', 'b-0']);
});

test('ambiguous result association never attaches an image to a guessed prompt', () => {
  const state = createImageIndex();
  applyImageTool(state, call('a'));
  applyImageTool(state, call('b'));
  applyImageTool(state, { ...call('result', 'completed'), toolName: 'ImageGeneration', toolParams: { _tesseraTranscriptImagePath: '/cache/result.png' } });
  assert.equal(state.traces[0].result, undefined);
  assert.equal(state.traces[1].result, undefined);
  assert.equal(state.traces[2].unresolvedInputCount, 1);
  assert.equal(state.traces[2].result?.locator.kind, 'cache');
});

test('reader resumes on byte boundaries, waits for complete UTF-8 lines and detects replacement', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.image-index-test-'));
  const file = path.join(directory, 'transcript.jsonl');
  try {
    await fs.writeFile(file, '{"text":"고양이"}\n{"partial":');
    const records: string[] = [];
    let resets = 0;
    const reset = () => { resets++; };
    const consume = async (line: string) => { records.push(line); };
    const first = await readImageTranscriptBatch(file, undefined, reset, consume);
    assert.equal(records.length, 1);
    assert.equal(first.checkpoint.offset, Buffer.byteLength('{"text":"고양이"}\n'));
    const unchanged = await readImageTranscriptBatch(file, first.checkpoint, reset, consume);
    assert.equal(unchanged.bytesRead, 0);
    assert.equal(resets, 1);
    await fs.appendFile(file, 'true}\n');
    const resumed = await readImageTranscriptBatch(file, unchanged.checkpoint, reset, consume);
    assert.equal(records.length, 2);
    assert.deepEqual(JSON.parse(records[1]), { partial: true });
    assert.equal(resumed.bytesRead, Buffer.byteLength('{"partial":true}\n'));
    await fs.writeFile(file, '{}\n');
    await readImageTranscriptBatch(file, resumed.checkpoint, reset, consume);
    assert.equal(resets, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
