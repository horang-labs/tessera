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
import path from 'node:path';
import {
  isBridgedAgentEnvironment,
  resolveAgentHomeFilesystemPath,
  resolveAgentReportedPath,
  type FilesystemBrowseEnvironment,
} from '@/lib/filesystem/path-environment';
import logger from '@/lib/logger';

async function resolveProjectsDir(
  environment: FilesystemBrowseEnvironment,
  projectsDir?: string,
): Promise<string> {
  if (projectsDir) return projectsDir;

  // `CLAUDE_CONFIG_DIR` describes this server's environment. Across a bridge the
  // CLI runs on the other side and never saw it, so only its own home applies.
  const configuredDir = isBridgedAgentEnvironment(environment)
    ? null
    : process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(await resolveAgentHomeFilesystemPath(environment), '.claude');
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

/**
 * Cheap identity of a transcript: which file, how big, last written when.
 * Shared by the Claude and Codex adapters — both back their history with a
 * single JSONL file that only ever grows.
 */
export async function fingerprintTranscriptFile(
  filePath: string | null,
): Promise<string | null> {
  if (!filePath) return null;
  try {
    const stats = await fsp.stat(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

export async function resolveClaudeTranscriptPath(options: {
  /** Claude's own session id. For PTY sessions this equals the Tessera session id. */
  providerSessionId: string;
  /** Hook-reported path, when one was captured. */
  transcriptPath?: string | null;
  /** Where the CLI runs. Decides whether paths need translating. */
  environment?: FilesystemBrowseEnvironment;
  /** Overrides the projects root (tests). */
  projectsDir?: string;
}): Promise<string | null> {
  const environment = options.environment ?? 'native';

  // The hook reported this path from inside the CLI's own filesystem, so across
  // a bridge it has to be translated before this process can stat it.
  const hookPath = options.transcriptPath?.trim();
  if (hookPath) {
    const serverPath = await resolveAgentReportedPath(hookPath, environment);
    if (path.extname(serverPath) === '.jsonl' && await isReadableFile(serverPath)) {
      return serverPath;
    }
  }

  const sessionId = options.providerSessionId.trim();
  // Guard against a crafted id escaping the projects root via the file name.
  if (!sessionId || sessionId !== path.basename(sessionId)) {
    return null;
  }

  const resolved = await findTranscriptByName(
    await resolveProjectsDir(environment, options.projectsDir),
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
