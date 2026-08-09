export interface TerminalClipboardImage {
  base64: string;
  mimeType: 'image/png';
}

export interface ElectronTerminalClipboardApi {
  readTerminalClipboard(): Promise<TerminalClipboardPayload>;
  writeTerminalClipboardText(text: string): Promise<void>;
}

export type TerminalClipboardPayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: TerminalClipboardImage }
  | { kind: 'empty' };

export type TerminalClipboardPasteResult = 'text' | 'image' | 'empty';

const TERMINAL_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

type TerminalImageMimeType = typeof TERMINAL_IMAGE_MIME_TYPES[number];

const TERMINAL_IMAGE_EXTENSION_MIME_TYPES: Record<string, TerminalImageMimeType> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const MAX_TERMINAL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/** Shared by the Phone picker and its authoritative upload-side validation. */
export const TERMINAL_IMAGE_FILE_ACCEPT = TERMINAL_IMAGE_MIME_TYPES.join(',');

interface TerminalClipboardPasteDependencies {
  paste(data: string): void;
  uploadImage(image: TerminalClipboardImage): Promise<string>;
}

/**
 * Applies the desktop clipboard policy at the terminal boundary.
 *
 * The Electron main process gives text precedence. Image-only clipboards are
 * uploaded so the PTY receives a filesystem path instead of binary image data.
 */
export async function pasteTerminalClipboard(
  payload: TerminalClipboardPayload,
  dependencies: TerminalClipboardPasteDependencies,
): Promise<TerminalClipboardPasteResult> {
  if (payload.kind === 'empty') return 'empty';

  if (payload.kind === 'text') {
    dependencies.paste(payload.text);
    return 'text';
  }

  const uploadedPath = await dependencies.uploadImage(payload.image);
  if (!uploadedPath) {
    throw new Error('Clipboard image upload did not return a path.');
  }
  dependencies.paste(uploadedPath);
  return 'image';
}

async function parseUploadResponse(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as {
    error?: unknown;
    path?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `Clipboard image upload failed (${response.status}).`,
    );
  }
  if (typeof body.path !== 'string' || !body.path) {
    throw new Error('Clipboard image upload did not return a path.');
  }
  return body.path;
}

export async function uploadTerminalClipboardFile(file: File): Promise<string> {
  const mimeType = TERMINAL_IMAGE_MIME_TYPES.includes(file.type as TerminalImageMimeType)
    ? file.type as TerminalImageMimeType
    : file.type
      ? null
      : TERMINAL_IMAGE_EXTENSION_MIME_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
  if (!mimeType) {
    throw new Error('Terminal images must be PNG, JPEG, GIF, or WebP.');
  }
  if (file.size > MAX_TERMINAL_IMAGE_SIZE_BYTES) {
    throw new Error('Terminal image is too large to paste into the terminal.');
  }
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });
  return parseUploadResponse(response);
}

export async function uploadTerminalClipboardImage(
  image: TerminalClipboardImage,
): Promise<string> {
  const binary = atob(image.base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const file = new File([bytes], 'clipboard-image.png', { type: image.mimeType });
  return uploadTerminalClipboardFile(file);
}
