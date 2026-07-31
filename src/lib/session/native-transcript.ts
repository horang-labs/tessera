import fs from 'fs/promises';
import { parseClaudeNativeTranscript } from '@/lib/cli/providers/claude-code/native-transcript';
import { parseCodexNativeTranscript } from '@/lib/cli/providers/codex/native-transcript';
import { readOpenCodeNativeTranscript } from '@/lib/cli/providers/opencode/native-transcript';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { resolveCodexAccountTranscriptPath } from '@/lib/codex-home';
import { extractOpenCodeTerminalSessionId, type SessionRow } from '@/lib/db/sessions';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import logger from '@/lib/logger';
import type { NativeTranscriptMessage } from './native-transcript-types';

export interface NativeTranscriptResult {
  messages: NativeTranscriptMessage[];
  /** Cache key for export freshness. Absent when nothing was recovered. */
  sourcePath?: string;
}

export interface ReadNativeTranscriptOptions {
  userId?: string;
  /** Prompts Tessera recorded, used to drop a CLI's synthetic `user` turns. */
  knownUserPrompts?: readonly string[];
}

const EMPTY_RESULT: NativeTranscriptResult = { messages: [] };

/**
 * Locate the transcript file the CLI wrote for this session, translated into a
 * path this server can open.
 */
async function resolveTranscriptPath(
  session: SessionRow,
  userId: string | undefined,
): Promise<string | null> {
  const storedPath = getTerminalProviderSessionForTesseraSession(session.id)?.transcript_path;
  if (!storedPath) return null;

  const agentEnvironment = await getAgentEnvironment(userId);
  const serverPath = await resolveAgentReportedPath(storedPath, agentEnvironment);

  return session.provider === 'codex'
    ? resolveCodexAccountTranscriptPath(serverPath)
    : serverPath;
}

/**
 * The file whose mtime decides whether a cached export is still fresh.
 *
 * Null for OpenCode: its conversations live in a database shared by every
 * session, so there is no per-session stamp to compare against.
 */
export async function resolveNativeTranscriptSourcePath(
  session: SessionRow,
  userId?: string,
): Promise<string | null> {
  if (session.provider !== 'claude-code' && session.provider !== 'codex') return null;
  return resolveTranscriptPath(session, userId);
}

async function readClaudeOrCodexTranscript(
  session: SessionRow,
  options: ReadNativeTranscriptOptions,
): Promise<NativeTranscriptResult> {
  const transcriptPath = await resolveTranscriptPath(session, options.userId);
  if (!transcriptPath) return EMPTY_RESULT;

  let content: string;
  try {
    content = await fs.readFile(transcriptPath, 'utf-8');
  } catch (error) {
    logger.debug(
      { sessionId: session.id, transcriptPath, error },
      'Native transcript unreadable',
    );
    return EMPTY_RESULT;
  }

  const messages = session.provider === 'codex'
    ? parseCodexNativeTranscript(content, { knownUserPrompts: options.knownUserPrompts })
    : parseClaudeNativeTranscript(content);

  return { messages, sourcePath: transcriptPath };
}

async function readOpenCodeTranscript(
  session: SessionRow,
): Promise<NativeTranscriptResult> {
  const providerSessionId =
    getTerminalProviderSessionForTesseraSession(session.id)?.provider_session_id
    ?? extractOpenCodeTerminalSessionId(session.provider_state);
  if (!providerSessionId) return EMPTY_RESULT;

  try {
    const messages = await readOpenCodeNativeTranscript(providerSessionId);
    // OpenCode stores conversations in a database shared by every session, so
    // there is no per-session file to date-stamp; the caller falls back to
    // skipping the freshness cache rather than serving a stale export.
    return { messages };
  } catch (error) {
    logger.debug({ sessionId: session.id, error }, 'OpenCode transcript unreadable');
    return EMPTY_RESULT;
  }
}

/**
 * Recover a PTY session's conversation from the CLI's own transcript.
 *
 * Tessera only records `user_message` for terminal sessions — the hooks observe
 * lifecycle and a stock Stop payload carries no assistant text — so this is the
 * only source of assistant prose for those sessions. Failures degrade to an
 * empty result: the caller decides whether a half-conversation is worth
 * exporting.
 */
export async function readNativeTranscript(
  session: SessionRow,
  options: ReadNativeTranscriptOptions = {},
): Promise<NativeTranscriptResult> {
  if (session.provider === 'opencode') {
    return readOpenCodeTranscript(session);
  }

  if (session.provider === 'claude-code' || session.provider === 'codex') {
    return readClaudeOrCodexTranscript(session, options);
  }

  return EMPTY_RESULT;
}
