import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pasteTerminalClipboard,
  type TerminalClipboardPayload,
} from '@/lib/terminal/terminal-clipboard-paste';

function createHarness(payload: TerminalClipboardPayload) {
  const pasted: string[] = [];
  const uploaded: Array<{ base64: string; mimeType: string }> = [];

  return {
    pasted,
    uploaded,
    result: pasteTerminalClipboard(payload, {
      paste: (data) => pasted.push(data),
      uploadImage: async (image) => {
        uploaded.push(image);
        return '/tmp/tessera-uploads/clipboard-image.png';
      },
    }),
  };
}

test('terminal clipboard pastes text directly without uploading an image', async () => {
  const harness = createHarness({ kind: 'text', text: 'hello from clipboard' });

  assert.equal(await harness.result, 'text');
  assert.deepEqual(harness.pasted, ['hello from clipboard']);
  assert.deepEqual(harness.uploaded, []);
});

test('terminal clipboard uploads an image and pastes its agent-visible path', async () => {
  const harness = createHarness({
    kind: 'image',
    image: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
  });

  assert.equal(await harness.result, 'image');
  assert.deepEqual(harness.uploaded, [
    { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
  ]);
  assert.deepEqual(harness.pasted, ['/tmp/tessera-uploads/clipboard-image.png']);
});

test('empty clipboard leaves the terminal untouched', async () => {
  const harness = createHarness({ kind: 'empty' });

  assert.equal(await harness.result, 'empty');
  assert.deepEqual(harness.pasted, []);
  assert.deepEqual(harness.uploaded, []);
});

test('an empty uploaded path is rejected instead of pasting invalid input', async () => {
  await assert.rejects(
    pasteTerminalClipboard(
      {
        kind: 'image',
        image: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
      },
      {
        paste: () => assert.fail('invalid path must not be pasted'),
        uploadImage: async () => '',
      },
    ),
    /did not return a path/,
  );
});
