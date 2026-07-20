import type {
  TerminalClipboardKind,
  TerminalClipboardPayload,
} from '../src/lib/terminal/terminal-clipboard-paste';

const MAX_CLIPBOARD_IMAGE_DIMENSION = 16_384;
const MAX_CLIPBOARD_IMAGE_PIXELS = 40_000_000;
const MAX_CLIPBOARD_IMAGE_PNG_BYTES = 20 * 1024 * 1024;

interface ClipboardImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
}

interface ClipboardLike {
  readText(): string;
  readImage(): ClipboardImageLike;
}

export function getTerminalClipboardKind(clipboard: ClipboardLike): TerminalClipboardKind {
  if (clipboard.readText().length > 0) return 'text';
  return clipboard.readImage().isEmpty() ? 'empty' : 'image';
}

/** Read clipboard content for an explicit terminal paste gesture. */
export function readTerminalClipboard(clipboard: ClipboardLike): TerminalClipboardPayload {
  const text = clipboard.readText();
  if (text.length > 0) return { kind: 'text', text };

  const image = clipboard.readImage();
  if (image.isEmpty()) return { kind: 'empty' };

  const { width, height } = image.getSize();
  if (
    width <= 0
    || height <= 0
    || width > MAX_CLIPBOARD_IMAGE_DIMENSION
    || height > MAX_CLIPBOARD_IMAGE_DIMENSION
    || width * height > MAX_CLIPBOARD_IMAGE_PIXELS
  ) {
    throw new Error('Clipboard image is too large to paste into the terminal.');
  }

  const png = image.toPNG();
  if (png.byteLength === 0) return { kind: 'empty' };
  if (png.byteLength > MAX_CLIPBOARD_IMAGE_PNG_BYTES) {
    throw new Error('Clipboard image is too large to paste into the terminal.');
  }

  return {
    kind: 'image',
    image: {
      base64: png.toString('base64'),
      mimeType: 'image/png',
    },
  };
}
