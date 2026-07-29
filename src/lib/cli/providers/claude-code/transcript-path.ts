/**
 * Locates the transcript Claude Code writes for a given session.
 *
 * Two sources, in order of authority:
 *  1. The `transcript_path` every Claude hook payload carries — the exact file
 *     the CLI is writing. Tessera already persists it per PTY session
 *     (`terminal_provider_sessions.transcript_path`).
 *  2. A search under the projects root. Claude nests transcripts by project slug
 *     (`<config>/projects/<slug>/<session-id>.jsonl`), and the slug is derived
 *     from a cwd we may not be able to reconstruct, so match on file name.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '@/lib/logger';

function resolveProjectsDir(projectsDir?: string): string {
  if (projectsDir) return projectsDir;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Search the projects root for `<sessionId>.jsonl`. Slug directories are flat
 * (one level), but recent Claude builds also drop transcripts directly in the
 * root, so both are checked. Returns the most recently modified match — a
 * resumed session can leave same-named files under more than one slug.
 */
async function findTranscriptByName(
  projectsDir: string,
  fileName: string,
): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) {
      candidates.push(path.join(projectsDir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const nested = path.join(projectsDir, entry.name, fileName);
    if (await isReadableFile(nested)) candidates.push(nested);
  }

  if (candidates.length <= 1) return candidates[0] ?? null;

  const stamped = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      mtimeMs: await fsp.stat(candidate).then((s) => s.mtimeMs).catch(() => 0),
    })),
  );
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped[0].candidate;
}

export async function resolveClaudeTranscriptPath(options: {
  /** Claude's own session id. For PTY sessions this equals the Tessera session id. */
  providerSessionId: string;
  /** Hook-reported path, when one was captured. */
  transcriptPath?: string | null;
  /** Overrides the projects root (tests). */
  projectsDir?: string;
}): Promise<string | null> {
  const hookPath = options.transcriptPath?.trim();
  if (hookPath && path.extname(hookPath) === '.jsonl' && await isReadableFile(hookPath)) {
    return hookPath;
  }

  const sessionId = options.providerSessionId.trim();
  // Guard against a crafted id escaping the projects root via the file name.
  if (!sessionId || sessionId !== path.basename(sessionId)) {
    return null;
  }

  const resolved = await findTranscriptByName(
    resolveProjectsDir(options.projectsDir),
    `${sessionId}.jsonl`,
  );
  if (!resolved && hookPath) {
    logger.debug({
      providerSessionId: sessionId,
      hookPath,
    }, 'Claude transcript missing at hook path and under the projects root');
  }
  return resolved;
}
