import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pasteTerminalClipboard,
  TERMINAL_IMAGE_FILE_ACCEPT,
  type TerminalClipboardPayload,
  uploadTerminalClipboardFile,
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

test('the terminal image picker advertises exactly the supported formats', () => {
  assert.equal(
    TERMINAL_IMAGE_FILE_ACCEPT,
    'image/png,image/jpeg,image/gif,image/webp',
  );
});

test('terminal image upload accepts supported MIME types and returns the agent path', async () => {
  const originalFetch = globalThis.fetch;
  const requestedFiles: File[] = [];
  globalThis.fetch = async (_input, init) => {
    const file = (init?.body as FormData).get('file');
    assert.ok(file instanceof File);
    requestedFiles.push(file);
    return Response.json({ path: `/agent/${file.name}` });
  };

  try {
    for (const [name, type] of [
      ['screen.png', 'image/png'],
      ['screen.jpg', 'image/jpeg'],
      ['screen.gif', 'image/gif'],
      ['screen.webp', 'image/webp'],
    ]) {
      assert.equal(
        await uploadTerminalClipboardFile(new File(['image'], name, { type })),
        `/agent/${name}`,
      );
    }
    assert.deepEqual(requestedFiles.map((file) => file.type), [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('terminal image upload recovers a missing browser MIME type from the extension', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ path: '/agent/screen.jpeg' });

  try {
    assert.equal(
      await uploadTerminalClipboardFile(new File(['image'], 'screen.JPEG')),
      '/agent/screen.jpeg',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('terminal image upload rejects unsupported formats and oversized files before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ path: '/agent/unexpected' });
  };

  try {
    await assert.rejects(
      uploadTerminalClipboardFile(new File(['image'], 'photo.heic', { type: 'image/heic' })),
      /PNG, JPEG, GIF, or WebP/,
    );
    await assert.rejects(
      uploadTerminalClipboardFile(new File([
        new Uint8Array(20 * 1024 * 1024 + 1),
      ], 'large.png', { type: 'image/png' })),
      /too large/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
