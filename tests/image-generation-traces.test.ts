import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseImageGenerationInvocations,
  projectImageGenerationTraces,
  toPublicImageGenerationTraces,
} from '@/lib/image-generation/traces';
import type { EnhancedMessage } from '@/types/chat';

const TS = '2026-08-28T00:00:00.000Z';
const image = (id: string, data: string): EnhancedMessage => ({
  id,
  type: 'text',
  role: 'user',
  timestamp: TS,
  content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
});
const exec = (id: string, source: string): EnhancedMessage => ({
  id,
  type: 'tool_call',
  sessionId: 'session',
  toolUseId: id,
  toolName: 'Bash',
  toolParams: { input: source },
  status: 'completed',
  timestamp: TS,
});
const result = (id: string, savedPath: string): EnhancedMessage => ({
  id,
  type: 'tool_call',
  sessionId: 'session',
  toolUseId: id,
  toolName: 'ImageGeneration',
  toolParams: { itemType: 'imageGeneration', savedPath, revisedPrompt: 'revised' },
  status: 'completed',
  timestamp: TS,
});

const inlineGeneratedResult = (id: string, data: string): EnhancedMessage => ({
  ...result(id, ''),
  toolParams: { itemType: 'imageGeneration', revisedPrompt: 'revised' },
  toolUseResult: {
    kind: 'file_read',
    contentType: 'image',
    base64: data,
    mimeType: 'image/png',
  },
});

test('parses literal imagegen arguments without executing source', () => {
  const calls = parseImageGenerationInvocations(`
    const result = await tools.image_gen__imagegen({
      prompt: \`edit this\\ncleanly\`,
      referenced_image_paths: ['/tmp/a.png', "/tmp/b.jpg"],
      num_last_images_to_include: 2,
    });
  `);
  assert.deepEqual(calls, [{
    prompt: 'edit this\ncleanly',
    referencedImagePaths: ['/tmp/a.png', '/tmp/b.jpg'],
    numLastImagesToInclude: 2,
  }]);
});

test('ignores imagegen-looking text inside command strings and comments', () => {
  const calls = parseImageGenerationInvocations(`
    const command = \`npx tsx -e "tools.image_gen__imagegen({ prompt: 'fake' })"\`;
    const quoted = "tools.image_gen__imagegen({ prompt: 'also fake' })";
    // tools.image_gen__imagegen({ prompt: 'comment fake' })
    /* tools.image_gen__imagegen({ prompt: 'block fake' }) */
    await tools.image_gen__imagegen({ prompt: 'real', num_last_images_to_include: 1 });
  `);
  assert.deepEqual(calls, [{ prompt: 'real', numLastImagesToInclude: 1 }]);
});

test('num_last_images_to_include freezes the exact tail at invocation time', () => {
  const traces = projectImageGenerationTraces([
    image('first', 'AAA'),
    image('second', 'BBB'),
    exec('call', `await tools.image_gen__imagegen({ prompt: 'combine', num_last_images_to_include: 1 })`),
    image('later', 'CCC'),
    result('generated', '/tmp/generated.png'),
  ]);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].numLastImagesToInclude, 1);
  assert.deepEqual(traces[0].inputs.map((input) => input.sourceMessageId), ['second']);
  assert.equal(traces[0].unresolvedInputCount, 0);
  assert.equal(traces[0].result?.label, '/tmp/generated.png');
});

test('a generated result is eligible for a later num_last selection', () => {
  const traces = projectImageGenerationTraces([
    exec('call-1', `tools.image_gen__imagegen({ prompt: 'first' })`),
    result('result-1', '/tmp/generated.png'),
    exec('call-2', `tools.image_gen__imagegen({ prompt: 'refine', num_last_images_to_include: 1 })`),
  ]);
  assert.equal(traces[1].inputs[0].source, 'generated');
  assert.equal(traces[1].inputs[0].label, '/tmp/generated.png');
});

test('duplicate transcript records are coalesced before resolving the last generated images', () => {
  const firstExec = exec('call-1', `tools.image_gen__imagegen({ prompt: 'first' })`);
  firstExec.toolUseResult = {
    kind: 'file_read',
    contentType: 'image',
    base64: 'FIRST_IMAGE',
    mimeType: 'image/png',
  };
  const secondExec = exec('call-2', `tools.image_gen__imagegen({ prompt: 'second' })`);
  secondExec.toolUseResult = {
    kind: 'file_read',
    contentType: 'image',
    base64: 'SECOND_IMAGE',
    mimeType: 'image/png',
  };

  const traces = projectImageGenerationTraces([
    firstExec,
    inlineGeneratedResult('result-1', 'FIRST_IMAGE'),
    secondExec,
    inlineGeneratedResult('result-2', 'SECOND_IMAGE'),
    exec('call-3', `tools.image_gen__imagegen({ prompt: 'combine', num_last_images_to_include: 2 })`),
  ]);

  assert.deepEqual(traces[2].inputs.map((input) => input.source), ['generated', 'generated']);
  assert.deepEqual(traces[2].inputs.map((input) => (
    input.locator.kind === 'inline' ? input.locator.data : input.locator.path
  )), ['FIRST_IMAGE', 'SECOND_IMAGE']);
});

test('reports an exact deficit when fewer prior images exist than requested', () => {
  const [trace] = projectImageGenerationTraces([
    image('only', 'AAA'),
    exec('call', `tools.image_gen__imagegen({ prompt: 'use three', num_last_images_to_include: 3 })`),
  ]);
  assert.equal(trace.inputs.length, 1);
  assert.equal(trace.unresolvedInputCount, 2);
});

test('public generated results expose the agent-reported path for PTY dragging', () => {
  const [trace] = projectImageGenerationTraces([
    exec('call', `tools.image_gen__imagegen({ prompt: 'make it' })`),
    result('generated', '/home/work/generated image.png'),
  ]);

  assert.equal(
    toPublicImageGenerationTraces('session', [trace])[0].result?.path,
    '/home/work/generated image.png',
  );
});

test('public path inputs expose the agent path for PTY dragging', () => {
  const [trace] = projectImageGenerationTraces([
    exec('call', `tools.image_gen__imagegen({
      prompt: 'edit it',
      referenced_image_paths: ['/home/work/input image.png'],
    })`),
  ]);

  assert.equal(
    toPublicImageGenerationTraces('session', [trace])[0].inputs[0].path,
    '/home/work/input image.png',
  );
});

test('inline generated results retain savedPath as the agent drag path', () => {
  const generated = inlineGeneratedResult('generated', 'IMAGE_BYTES');
  generated.toolParams.savedPath = '/home/work/generated.png';
  const [trace] = projectImageGenerationTraces([
    exec('call', `tools.image_gen__imagegen({ prompt: 'make it' })`),
    generated,
  ]);

  assert.equal(trace.result?.locator.kind, 'inline');
  assert.equal(
    toPublicImageGenerationTraces('session', [trace])[0].result?.path,
    '/home/work/generated.png',
  );
});
