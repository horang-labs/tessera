import type { FileReadImageToolResult } from '@/types/tool-result';

/** File extensions the chat renders as an inline image. */
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
]);

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function extensionOf(filePath: string): string {
  const clean = filePath.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/** True when the path looks like an image we can render inline. */
export function isImagePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  return IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

/** Best-effort image MIME type from a file path; undefined when not an image. */
export function inferImageMime(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXT[extensionOf(filePath)];
}

/**
 * Same-origin endpoint that serves the image bytes for a tool call. The server
 * re-derives the on-disk path from the session's recorded tool call (by
 * `toolUseId`), so no client-supplied filesystem path is trusted.
 */
export function buildToolImageUrl(sessionId: string, toolUseId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/tool-image?toolUseId=${encodeURIComponent(toolUseId)}`;
}

/** Canonical image read result that renders by serving the file lazily. */
export function buildImageToolResult(sessionId: string, toolUseId: string): FileReadImageToolResult {
  return {
    kind: 'file_read',
    contentType: 'image',
    url: buildToolImageUrl(sessionId, toolUseId),
  };
}
