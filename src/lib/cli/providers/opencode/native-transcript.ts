import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '@/lib/logger';
import type { NativeTranscriptMessage } from '@/lib/session/native-transcript-types';

/**
 * OpenCode moved its conversation store from `storage/{message,part}/*.json`
 * into `opencode.db`; the JSON tree still exists but stops at the migration.
 * Reading the database is therefore the only way to see recent turns.
 *
 * Tessera has no native SQLite binding (see `lib/db/database.ts` — sql.js WASM,
 * chosen to keep the install dependency-free), so the file is loaded as an
 * image. That means uncheckpointed WAL content is invisible: a session still
 * being written may be missing its last turns, which is logged below.
 */
interface OpenCodeSqlStatement {
  bind(params?: (string | number | null | Uint8Array)[]): void;
  step(): boolean;
  getAsObject(): Record<string, string | number | null | Uint8Array>;
  free(): void;
}

interface OpenCodeSqlDatabase {
  prepare(sql: string): OpenCodeSqlStatement;
  close(): void;
}

const initSqlJs = require('sql.js') as () => Promise<{
  Database: new (data?: ArrayLike<number>) => OpenCodeSqlDatabase;
}>;

const TRANSCRIPT_QUERY = `
  SELECT m.data AS message_data, p.data AS part_data
  FROM part p
  JOIN message m ON m.id = p.message_id
  WHERE p.session_id = ?
  ORDER BY m.time_created ASC, p.time_created ASC
`;

export interface OpenCodeTranscriptLocation {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * OpenCode follows the XDG data convention; the Windows build falls back to
 * LOCALAPPDATA. Probing in order keeps this working without a platform switch.
 */
export function resolveOpenCodeDatabasePath(
  options: OpenCodeTranscriptLocation = {},
): string | null {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  const roots: string[] = [];
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) roots.push(path.join(xdgDataHome, 'opencode'));
  roots.push(path.join(homeDir, '.local', 'share', 'opencode'));
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) roots.push(path.join(localAppData, 'opencode'));

  for (const root of roots) {
    const candidate = path.join(root, 'opencode.db');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function warnOnPendingWal(databasePath: string): void {
  try {
    const walSize = fs.statSync(`${databasePath}-wal`).size;
    if (walSize > 0) {
      logger.warn(
        { databasePath, walSize },
        'OpenCode transcript read with a non-empty WAL — the newest turns may be missing',
      );
    }
  } catch {
    // No WAL file means everything is checkpointed into the main image.
  }
}

export async function readOpenCodeNativeTranscript(
  providerSessionId: string,
  options: OpenCodeTranscriptLocation = {},
): Promise<NativeTranscriptMessage[]> {
  const databasePath = resolveOpenCodeDatabasePath(options);
  if (!databasePath) return [];

  warnOnPendingWal(databasePath);

  const SqlJs = await initSqlJs();
  const database = new SqlJs.Database(fs.readFileSync(databasePath));
  const messages: NativeTranscriptMessage[] = [];

  try {
    const statement = database.prepare(TRANSCRIPT_QUERY);
    try {
      statement.bind([providerSessionId]);
      while (statement.step()) {
        const row = statement.getAsObject();
        const message = parseJsonRecord(row.message_data);
        const part = parseJsonRecord(row.part_data);
        if (!message || !part) continue;

        const role = message.role;
        if (role !== 'user' && role !== 'assistant') continue;
        if (part.type !== 'text' || part.synthetic === true) continue;

        const text = typeof part.text === 'string' ? part.text.trim() : '';
        if (!text) continue;

        messages.push({ role, text });
      }
    } finally {
      statement.free();
    }
  } finally {
    database.close();
  }

  return messages;
}
