import * as fs from 'node:fs/promises';
import { resolveCodexAccountOverlayPath } from '@/lib/codex-home';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
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
import {
  projectImageGenerationTraces,
  type ImageGenerationTrace,
  type ImageLocator,
} from './traces';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

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
