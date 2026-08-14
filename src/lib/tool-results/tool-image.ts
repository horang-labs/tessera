import type { FileReadImageToolResult } from '@/types/tool-result';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function imageResultFromDataUrl(value: unknown): FileReadImageToolResult | undefined {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return undefined;

  const separator = value.indexOf(',');
  if (separator < 0) return undefined;

  const header = value.slice(5, separator);
  if (!header.endsWith(';base64')) return undefined;

  const mimeType = header.slice(0, -';base64'.length);
  const base64 = value.slice(separator + 1);
  if (!mimeType.startsWith('image/') || !base64) return undefined;

  return {
    kind: 'file_read',
    contentType: 'image',
    base64,
    mimeType,
  };
}

/** Extract the first inline image returned by a Codex dynamic/custom tool. */
export function extractImageToolResult(contentItems: unknown): FileReadImageToolResult | undefined {
  if (!Array.isArray(contentItems)) return undefined;

  for (const item of contentItems) {
    if (!isRecord(item)) continue;

    const fromUrl = imageResultFromDataUrl(item.imageUrl ?? item.image_url ?? item.url);
    if (fromUrl) return fromUrl;

    const source = isRecord(item.source) ? item.source : undefined;
    const data = typeof item.data === 'string'
      ? item.data
      : typeof source?.data === 'string'
        ? source.data
        : undefined;
    const mimeType = typeof item.mimeType === 'string'
      ? item.mimeType
      : typeof item.mime_type === 'string'
        ? item.mime_type
        : typeof source?.media_type === 'string'
          ? source.media_type
          : undefined;

    if (data && mimeType?.startsWith('image/')) {
      return {
        kind: 'file_read',
        contentType: 'image',
        base64: data,
        mimeType,
      };
    }
  }

  return undefined;
}

/** Resolve a canonical image result to an img/lightbox source. */
export function resolveImageToolResultSrc(result: unknown): string | undefined {
  if (!isRecord(result) || result.kind !== 'file_read' || result.contentType !== 'image') {
    return undefined;
  }
  if (typeof result.url === 'string' && result.url) return result.url;
  if (typeof result.base64 !== 'string' || !result.base64) return undefined;
  const mimeType = typeof result.mimeType === 'string' && result.mimeType.startsWith('image/')
    ? result.mimeType
    : 'image/png';
  return `data:${mimeType};base64,${result.base64}`;
}

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
