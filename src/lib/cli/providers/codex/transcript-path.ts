/**
 * Locates the rollout file Codex writes for a given session.
 *
 * Two sources, in order of authority:
 *  1. The path Tessera already recorded for the PTY session. Codex sessions are
 *     launched against a per-session overlay CODEX_HOME, so that path points
 *     into `<overlay>/sessions/...` — which only resolves while the overlay
 *     exists.
 *  2. The account's own sessions root. The overlay's `sessions/` is a symlink
 *     to it, so the same rollout survives there after the overlay is cleaned up.
 *     Rollout file names embed the session id (`rollout-<ts>-<id>.jsonl`), and
 *     they are nested by date, so the search walks newest date first.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexAccountHome } from '@/lib/codex-home';
import {
  isBridgedAgentEnvironment,
  resolveAgentHomeFilesystemPath,
  resolveAgentReportedPath,
  type FilesystemBrowseEnvironment,
} from '@/lib/filesystem/path-environment';
import logger from '@/lib/logger';

/** sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl — three levels of date nesting. */
const ROLLOUT_DATE_DEPTH = 3;

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Walks the date directories newest-first and returns the first rollout whose
 * file name carries `sessionId`. Newest-first matters: a busy account holds
 * thousands of rollouts, and the session being opened is nearly always recent.
 */
async function findRolloutBySessionId(
  sessionsDir: string,
  sessionId: string,
  depth = ROLLOUT_DATE_DEPTH,
): Promise<string | null> {
  if (depth === 0) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    const match = entries.find((entry) => (
      entry.isFile()
      && entry.name.endsWith('.jsonl')
      && path.basename(entry.name, '.jsonl').endsWith(`-${sessionId}`)
    ));
    return match ? path.join(sessionsDir, match.name) : null;
  }

  // Date segments sort lexicographically, so descending order is newest first.
  const names = (await readDirNames(sessionsDir)).sort((a, b) => b.localeCompare(a));
  for (const name of names) {
    const found = await findRolloutBySessionId(
      path.join(sessionsDir, name),
      sessionId,
      depth - 1,
    );
    if (found) return found;
  }
  return null;
}

export async function resolveCodexTranscriptPath(options: {
  /** Codex's own session id (the uuid embedded in the rollout file name). */
  providerSessionId: string;
  /** Path captured when the PTY session was observed, if any. */
  transcriptPath?: string | null;
  /** Where the CLI runs. Decides whether paths need translating. */
  environment?: FilesystemBrowseEnvironment;
  /** Overrides the sessions root (tests). */
  sessionsDir?: string;
}): Promise<string | null> {
  const environment = options.environment ?? 'native';

  // Recorded from inside the CLI's own filesystem, so translate before stat.
  const recorded = options.transcriptPath?.trim();
  if (recorded) {
    const serverPath = await resolveAgentReportedPath(recorded, environment);
    if (path.extname(serverPath) === '.jsonl' && await isReadableFile(serverPath)) {
      return serverPath;
    }
  }

  const sessionId = options.providerSessionId.trim();
  // Guard against a crafted id escaping the sessions root through the suffix match.
  if (!sessionId || sessionId !== path.basename(sessionId)) return null;

  // `CODEX_HOME` belongs to this server's environment; across a bridge the CLI
  // never saw it, so the account home is derived from its own home alone.
  const accountHome = isBridgedAgentEnvironment(environment)
    ? path.join(await resolveAgentHomeFilesystemPath(environment), '.codex')
    : resolveCodexAccountHome();
  const sessionsDir = options.sessionsDir ?? path.join(accountHome, 'sessions');
  const resolved = await findRolloutBySessionId(sessionsDir, sessionId);

  if (!resolved && recorded) {
    logger.debug({
      providerSessionId: sessionId,
      recorded,
      sessionsDir,
    }, 'Codex rollout missing at the recorded overlay path and under the account sessions root');
  }
  return resolved;
}
