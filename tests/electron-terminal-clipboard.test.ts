import assert from 'node:assert/strict';
import test from 'node:test';
import { readTerminalClipboard } from '../electron/terminal-clipboard';

function clipboardStub(options: {
  text?: string;
  emptyImage?: boolean;
  width?: number;
  height?: number;
  png?: Buffer;
} = {}) {
  return {
    readText: () => options.text ?? '',
    readImage: () => ({
      isEmpty: () => options.emptyImage ?? false,
      getSize: () => ({
        width: options.width ?? 1200,
        height: options.height ?? 800,
      }),
      toPNG: () => options.png ?? Buffer.from('png bytes'),
    }),
  };
}

test('desktop terminal clipboard gives text precedence over an available image', () => {
  assert.deepEqual(
    readTerminalClipboard(clipboardStub({ text: 'copied text' })),
    { kind: 'text', text: 'copied text' },
  );
});

test('desktop terminal clipboard serializes an image-only clipboard as PNG', () => {
  assert.deepEqual(
    readTerminalClipboard(clipboardStub({ png: Buffer.from('png bytes') })),
    {
      kind: 'image',
      image: {
        base64: Buffer.from('png bytes').toString('base64'),
        mimeType: 'image/png',
      },
    },
  );
});

test('desktop terminal clipboard reports empty content without fabricating input', () => {
  assert.deepEqual(
    readTerminalClipboard(clipboardStub({ emptyImage: true })),
    { kind: 'empty' },
  );
});

test('desktop terminal clipboard rejects images with unsafe dimensions', () => {
  assert.throws(
    () => readTerminalClipboard(clipboardStub({ width: 20_000, height: 20_000 })),
    /too large/,
  );
});
