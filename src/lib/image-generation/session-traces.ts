import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexAccountOverlayPath } from '@/lib/codex-home';
import { getAgentEnvironment, normalizeCwdForCliEnvironment } from '@/lib/cli/spawn-cli';
import * as dbSessions from '@/lib/db/sessions';
import {
  isBridgedAgentEnvironment,
  resolveAgentHomeFilesystemPath,
  resolveAgentReportedPath,
} from '@/lib/filesystem/path-environment';
import { sessionHistory } from '@/lib/session-history';
import { reduceSessionReplayEvents } from '@/lib/session-replay-reducer';
import {
  readTerminalSessionReplayState,
  supportsTerminalTranscriptHistory,
} from '@/lib/session/terminal-session-history';
import { inferImageMime, isImagePath } from '@/lib/tool-results/tool-image';
import logger from '@/lib/logger';
import { readImageCards } from '@/lib/db/image-generation-cache';
import {
  projectImageGenerationTraces,
  type ImageGenerationTrace,
  type ImageLocator,
} from './traces';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

export async function readSessionImageGenerationTraces(
  session: dbSessions.SessionRow,
  userId: string,
): Promise<ImageGenerationTrace[]> {
  if (session.provider === 'codex' && supportsTerminalTranscriptHistory(session)) return readImageCards(session.id);
  const replay = supportsTerminalTranscriptHistory(session)
    ? await readTerminalSessionReplayState(session, userId)
    : reduceSessionReplayEvents(session.id, await sessionHistory.readEvents(session.id), {
        lazyToolOutput: false,
      });
  return projectImageGenerationTraces(replay?.messages ?? []);
}

/**
 * Give every trace input a path that the configured agent runtime can read.
 * Transcript images are often inline-only, so persist those bytes in the
 * server temp directory and translate the resulting host path for WSL agents.
 */
export async function ensureTraceInputAgentPaths(
  traces: ImageGenerationTrace[],
  userId: string,
): Promise<void> {
  const environment = await getAgentEnvironment(userId);
  const userKey = createHash('sha256').update(userId).digest('hex').slice(0, 16);
  const inputDir = join(tmpdir(), 'tessera-image-generation-inputs', userKey);

  await Promise.all(traces.flatMap((trace) => [...trace.inputs, ...(trace.result ? [trace.result] : [])].map(async (input) => {
    if (input.locator.kind === 'cache') {
      // An owned copy may outlive the CLI's temporary source. Thumbnails and
      // path insertion must refer to the same surviving file.
      if (input.locator.path) input.agentPath = normalizeCwdForCliEnvironment(input.locator.path, environment);
      else delete input.agentPath;
      return;
    }
    if (input.agentPath || input.locator.kind === 'transcript') return;
    if (input.locator.kind === 'path') {
      input.agentPath = input.locator.path;
      return;
    }

    try {
      const bytes = Buffer.from(input.locator.data, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const extension = INLINE_IMAGE_EXTENSIONS[input.locator.mimeType] ?? '.img';
      const hostPath = join(inputDir, `${digest}${extension}`);
      await fs.mkdir(inputDir, { recursive: true });
      try {
        await fs.writeFile(hostPath, bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      input.agentPath = normalizeCwdForCliEnvironment(hostPath, environment);
    } catch (error) {
      logger.warn({ error, traceId: trace.id, sourceMessageId: input.sourceMessageId }, 'Failed to materialize image generation input path');
    }
  })));
}

export interface TraceImageStream {
  stream: ReadableStream<Uint8Array>;
  mimeType: string;
}

const IMAGE_STREAM_CHUNK_BYTES = 64 * 1024;

/** No prefetch: one bounded chunk is allocated only when the consumer pulls. */
function imageStream(read: () => Promise<Uint8Array | null>, close: () => Promise<void>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let finished = false;
  let closing: Promise<void> | undefined;
  let abort: (() => void) | undefined;
  const cleanup = () => {
    if (abort) signal?.removeEventListener('abort', abort);
    return closing ??= close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        finished = true;
        controller.error(signal?.reason ?? new Error('Image request aborted'));
        void cleanup();
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const bytes = await read();
        if (finished) return;
        if (bytes === null) {
          finished = true;
          await cleanup();
          controller.close();
        } else controller.enqueue(bytes);
      } catch (error) {
        if (finished) return;
        finished = true;
        await cleanup();
        controller.error(error);
      }
    },
    async cancel() { finished = true; await cleanup(); },
  }, { highWaterMark: 0, size: bytes => bytes.byteLength });
}

export async function readTraceImageStream(
  locator: ImageLocator,
  userId: string,
  signal?: AbortSignal,
): Promise<TraceImageStream | null> {
  if (locator.kind === 'transcript' || signal?.aborted) return null;
  if (locator.kind === 'inline') {
    const padding = locator.data.indexOf('=');
    const end = padding < 0 ? locator.data.length : padding;
    let characters = 0;
    // Buffer's base64 decoder ignores whitespace/non-alphabet characters. Count
    // accepted characters without making a second full-sized encoded string.
    for (let offset = 0; offset < end; offset += IMAGE_STREAM_CHUNK_BYTES) {
      characters += locator.data.slice(offset, Math.min(end, offset + IMAGE_STREAM_CHUNK_BYTES)).replace(/[^A-Za-z0-9+/_-]/g, '').length;
      if (Math.floor(characters * 3 / 4) > MAX_IMAGE_BYTES) return null;
    }
    if (Math.floor(characters * 3 / 4) === 0) return null;
    let offset = 0;
    let pending = '';
    return { mimeType: locator.mimeType, stream: imageStream(async () => {
      while (offset < end) {
        const next = Math.min(end, offset + IMAGE_STREAM_CHUNK_BYTES);
        pending += locator.data.slice(offset, next).replace(/[^A-Za-z0-9+/_-]/g, '');
        offset = next;
        const complete = pending.length - pending.length % 4;
        if (complete) {
          const bytes = Buffer.from(pending.slice(0, complete), 'base64');
          pending = pending.slice(complete);
          return bytes;
        }
      }
      if (pending.length > 1) { const bytes = Buffer.from(pending, 'base64'); pending = ''; return bytes; }
      pending = '';
      return null;
    }, async () => { pending = ''; }, signal) };
  }
  if (locator.path.includes('\0') || !isImagePath(locator.path)) return null;
  let hostPath = locator.path;
  if (locator.kind !== 'cache') {
    const environment = await getAgentEnvironment(userId);
    const reportedHostPath = await resolveAgentReportedPath(locator.path, environment);
    hostPath = resolveCodexAccountOverlayPath(reportedHostPath, isBridgedAgentEnvironment(environment)
      ? { env: { NODE_ENV: process.env.NODE_ENV }, homeDir: await resolveAgentHomeFilesystemPath(environment) }
      : undefined);
  }
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(hostPath, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || signal?.aborted) { await file.close(); return null; }
    const opened = file;
    let offset = 0;
    return { mimeType: inferImageMime(locator.path) ?? 'application/octet-stream', stream: imageStream(async () => {
      if (offset >= stat.size) return null;
      const bytes = Buffer.allocUnsafe(Math.min(IMAGE_STREAM_CHUNK_BYTES, stat.size - offset));
      const result = await opened.read(bytes, 0, bytes.length, offset);
      if (!result.bytesRead) throw new Error('Image ended before its recorded size');
      offset += result.bytesRead;
      return bytes.subarray(0, result.bytesRead);
    }, () => opened.close(), signal) };
  } catch { await file?.close().catch(() => undefined); return null; }
}
