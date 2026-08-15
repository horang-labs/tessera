/**
 * Reads an OpenCode session's conversation.
 *
 * Unlike Claude and Codex, OpenCode keeps no transcript file — conversations
 * live in a SQLite database (`<data>/opencode/opencode.db`). Reading it directly
 * is not an option here: the DB runs in WAL mode, and the only SQLite driver
 * Tessera ships (sql.js) loads a plain file image and cannot see committed pages
 * still sitting in the WAL. That is exactly the case while OpenCode is running,
 * which is precisely when the chat view is used. Node's built-in `node:sqlite`
 * would handle it but does not exist on Electron 33's Node 20 runtime.
 *
 * So the conversation is read through `opencode export`, the CLI's own JSON
 * dump. It costs a process spawn (~1.1s measured), which is why the fingerprint
 * below exists: it stats the database instead, so the export only runs when the
 * conversation actually changed.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAgentEnvironment, spawnCli } from '../../spawn-cli';
import { resolveProviderCliCommand } from '../../provider-command';
import {
  isBridgedAgentEnvironment,
  resolveAgentHomeFilesystemPath,
  type FilesystemBrowseEnvironment,
} from '@/lib/filesystem/path-environment';
import logger from '@/lib/logger';

const EXPORT_TIMEOUT_MS = 60_000;
const PROVIDER_ID = 'opencode';
const DEFAULT_COMMAND = 'opencode';

/**
 * Mirrors OpenCode's own data directory resolution, resolved against the home
 * the CLI actually writes under. Across a bridge that is not this server's home,
 * and `XDG_DATA_HOME` describes this server rather than the CLI.
 */
async function resolveOpenCodeDataDir(
  environment: FilesystemBrowseEnvironment,
): Promise<string> {
  const xdg = isBridgedAgentEnvironment(environment)
    ? null
    : process.env.XDG_DATA_HOME?.trim();
  const base = xdg
    ? path.resolve(xdg)
    : path.join(await resolveAgentHomeFilesystemPath(environment), '.local', 'share');
  return path.join(base, 'opencode');
}

async function statPart(filePath: string): Promise<string> {
  try {
    const stats = await fsp.stat(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'x';
  }
}

/**
 * Identity of the OpenCode store. Covers the WAL as well as the database file —
 * while OpenCode is running, new turns land in the WAL and the main file's mtime
 * does not move, so watching only the database would freeze the chat view.
 */
export async function fingerprintOpenCodeStore(
  providerSessionId: string,
  userId?: string,
): Promise<string | null> {
  if (!providerSessionId.trim()) return null;
  const environment = await getAgentEnvironment(userId);
  const dbPath = path.join(await resolveOpenCodeDataDir(environment), 'opencode.db');
  const [db, wal] = await Promise.all([
    statPart(dbPath),
    statPart(`${dbPath}-wal`),
  ]);
  if (db === 'x' && wal === 'x') return null;
  return `${providerSessionId}:${db}:${wal}`;
}

export interface OpenCodeExportedPart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  time?: { start?: number; end?: number };
}

export interface OpenCodeExportedMessage {
  info?: { role?: string; time?: { created?: number } };
  parts?: OpenCodeExportedPart[];
}

export interface OpenCodeExportedSession {
  info?: Record<string, unknown>;
  messages?: OpenCodeExportedMessage[];
}

/**
 * `opencode export` prints a human-facing line before the JSON body, so the
 * payload starts at the first brace rather than at byte zero.
 */
function parseExportOutput(stdout: string): OpenCodeExportedSession | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === 'object' ? parsed as OpenCodeExportedSession : null;
  } catch {
    return null;
  }
}

/**
 * Runs the export with stdout pointed at a file instead of a pipe.
 *
 * `opencode export` does not flush stdout before exiting when it is a pipe: a
 * 202KB export came back as 80KB and 112KB on consecutive runs, with exit
 * code 3. Writing to a real file descriptor avoids the truncation entirely.
 */
async function runExportToFile(
  command: string,
  sessionId: string,
  agentEnv: Awaited<ReturnType<typeof getAgentEnvironment>>,
  outputPath: string,
): Promise<{ ok: boolean; exitCode: number | null }> {
  const handle = await fsp.open(outputPath, 'w');
  try {
    return await new Promise((resolve) => {
      const child = spawnCli(
        command,
        ['export', sessionId],
        {
          windowsHide: true,
          env: process.env,
          stdio: ['ignore', handle.fd, 'ignore'],
        },
        agentEnv,
      );

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        resolve({ ok: false, exitCode: null });
      }, EXPORT_TIMEOUT_MS);

      child.on('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, exitCode: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code });
      });
    });
  } finally {
    await handle.close();
  }
}

/** Runs `opencode export <sessionId>` in the session's CLI environment. */
export async function exportOpenCodeSession(options: {
  providerSessionId: string;
  userId?: string;
}): Promise<OpenCodeExportedSession | null> {
  const sessionId = options.providerSessionId.trim();
  // The id lands in a temp file name, so keep it to the shape OpenCode mints.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;

  const agentEnv = await getAgentEnvironment(options.userId);
  const command = await resolveProviderCliCommand(
    PROVIDER_ID,
    DEFAULT_COMMAND,
    agentEnv,
    options.userId,
  );

  const outputPath = path.join(
    os.tmpdir(),
    `tessera-opencode-export-${sessionId}-${process.pid}.json`,
  );

  try {
    const result = await runExportToFile(command, sessionId, agentEnv, outputPath);
    const stdout = await fsp.readFile(outputPath, 'utf-8').catch(() => '');

    if (!stdout.trim()) {
      logger.debug({
        providerSessionId: sessionId,
        exitCode: result.exitCode,
      }, 'opencode export produced no output');
      return null;
    }

    const parsed = parseExportOutput(stdout);
    if (!parsed) {
      logger.warn({
        providerSessionId: sessionId,
        exitCode: result.exitCode,
        bytes: stdout.length,
      }, 'Could not parse opencode export output');
      return null;
    }
    return parsed;
  } finally {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
  }
}
