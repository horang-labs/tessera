import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { buildImageToolResult } from '@/lib/tool-results/tool-image';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';

const CACHED_IMAGE_PATH_KEY = '_tesseraTranscriptImagePath';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Server-owned cache path recorded while replaying an inline transcript image. */
export function extractCachedTerminalTranscriptImagePath(
  toolParams: unknown,
): string | undefined {
  if (!isRecord(toolParams)) return undefined;
  const value = toolParams[CACHED_IMAGE_PATH_KEY];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Move a decoded inline tool image out of the replay graph and into a
 * content-addressed server cache. The renderer receives only its authenticated
 * session URL; repeated transcript reads reuse the same file.
 */
export async function materializeTerminalTranscriptImage(
  sessionId: string,
  event: SessionHistoryEvent,
): Promise<SessionHistoryEvent> {
  if (event.type !== 'tool_call' || !event.toolUseId || !isRecord(event.toolUseResult)) {
    return event;
  }
  const result = event.toolUseResult as Record<string, any>;
  if (
    result.kind !== 'file_read'
    || result.contentType !== 'image'
    || typeof result.base64 !== 'string'
    || !result.base64
  ) {
    return event;
  }

  const mimeType = typeof result.mimeType === 'string' ? result.mimeType : 'image/png';
  const extension = EXTENSION_BY_MIME[mimeType];
  // Reject before Buffer allocation. Base64 carries at most three bytes per
  // four characters (padding only makes this estimate slightly high).
  const estimatedBytes = Math.ceil(result.base64.length * 3 / 4);
  if (!extension || estimatedBytes > MAX_IMAGE_BYTES) {
    return { ...event, toolUseResult: undefined };
  }

  const digest = createHash('sha256')
    .update(mimeType)
    .update('\0')
    .update(result.base64)
    .digest('hex');
  const cacheDir = getTesseraDataPath('cache', 'terminal-transcript-images');
  const cachePath = path.join(cacheDir, `${digest}${extension}`);

  try {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    try {
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
        return { ...event, toolUseResult: undefined };
      }
      await fs.writeFile(cachePath, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch {
    // A cache failure must not keep the very bytes this path exists to evict.
    return { ...event, toolUseResult: undefined };
  }

  return {
    ...event,
    toolParams: {
      ...event.toolParams,
      [CACHED_IMAGE_PATH_KEY]: cachePath,
    },
    toolUseResult: buildImageToolResult(sessionId, event.toolUseId),
  };
}
