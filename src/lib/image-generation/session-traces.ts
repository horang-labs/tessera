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

  await Promise.all(traces.flatMap((trace) => trace.inputs.map(async (input) => {
    if (input.agentPath) return;
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

export interface TraceImageBytes {
  bytes: Buffer;
  mimeType: string;
}

export async function readTraceImageBytes(
  locator: ImageLocator,
  userId: string,
): Promise<TraceImageBytes | null> {
  if (locator.kind === 'inline') {
    const bytes = Buffer.from(locator.data, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    return { bytes, mimeType: locator.mimeType };
  }
  if (locator.path.includes('\0') || !isImagePath(locator.path)) return null;
  const environment = await getAgentEnvironment(userId);
  const reportedHostPath = await resolveAgentReportedPath(locator.path, environment);
  const hostPath = resolveCodexAccountOverlayPath(reportedHostPath, isBridgedAgentEnvironment(environment)
    ? {
        env: { NODE_ENV: process.env.NODE_ENV },
        homeDir: await resolveAgentHomeFilesystemPath(environment),
      }
    : undefined);
  try {
    const stat = await fs.stat(hostPath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    return {
      bytes: await fs.readFile(hostPath),
      mimeType: inferImageMime(locator.path) ?? 'application/octet-stream',
    };
  } catch {
    return null;
  }
}
