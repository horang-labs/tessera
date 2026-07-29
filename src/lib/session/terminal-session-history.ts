/**
 * Read-only chat history for terminal (PTY) sessions.
 *
 * A PTY session's conversation never streams through ProcessManager, so Tessera
 * has no canonical history for it — only the prompts the UserPromptSubmit hook
 * captured. Instead of persisting a second copy, this module decodes the
 * provider's own transcript on demand and feeds it through the same replay
 * reducer the live chat uses, so the chat view renders a PTY conversation with
 * no changes to the UI or the pagination contract.
 *
 * Decoded results are cached per session and invalidated by transcript mtime,
 * because a long transcript is re-read on every page request otherwise.
 */

import fsp from 'node:fs/promises';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import * as dbSessions from '@/lib/db/sessions';
import { getTerminalProviderSessionForTesseraSession } from '@/lib/db/terminal-provider-sessions';
import logger from '@/lib/logger';
import { paginateReplayMessages } from '@/lib/session-history';
import { reduceSessionReplayEvents, type SessionReplayState } from '@/lib/session-replay-reducer';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import { readPersistedTerminalProviderSessionId } from '@/lib/terminal/provider-session-identity';
import type { EnhancedMessage } from '@/types/chat';

interface CacheEntry {
  /** Identity of the decode input: transcript path + size + mtime. */
  fingerprint: string;
  state: SessionReplayState;
}

const CACHE_KEY = Symbol.for('tessera.terminalSessionHistoryCache');
const cacheGlobal = globalThis as unknown as Record<symbol, Map<string, CacheEntry>>;
const cache = cacheGlobal[CACHE_KEY] ?? (cacheGlobal[CACHE_KEY] = new Map());

/**
 * Decoded transcripts are large (a busy session reduces to hundreds of
 * messages), and nothing evicts a session that is simply never opened again.
 * Cap the map and drop the least recently used entry — re-decoding costs tens
 * of milliseconds, so a miss is cheap compared to holding every session ever
 * viewed.
 */
const MAX_CACHED_SESSIONS = 8;

function rememberDecoded(sessionId: string, entry: CacheEntry): void {
  // Map iterates in insertion order; re-inserting moves a session to the back,
  // so the first key is always the least recently stored.
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  while (cache.size > MAX_CACHED_SESSIONS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface TerminalSessionHistoryPage {
  messages: EnhancedMessage[];
  todoSnapshot: SessionReplayState['todoSnapshot'];
  hasMore: boolean;
  nextBeforeBytes: number;
}

/**
 * True when this session's conversation lives in a provider transcript rather
 * than Tessera's own history — i.e. it was launched as a PTY session and its
 * provider can replay transcripts.
 */
export function supportsTerminalTranscriptHistory(session: dbSessions.SessionRow): boolean {
  if (dbSessions.extractSessionKind(session.provider_state) !== 'terminal') return false;
  try {
    return typeof cliProviderRegistry.getProvider(session.provider)
      .readTerminalTranscriptEvents === 'function';
  } catch {
    return false;
  }
}

/**
 * Identity of the source a decode came from, so a cached result can be reused
 * until the provider's own store changes.
 *
 * Delegated to the provider: a rollout file is stat'ed by path, while OpenCode
 * has no path at all (SQLite) and must fingerprint its database instead.
 * 'unresolved' disables caching rather than risking a stale conversation.
 */
async function transcriptFingerprint(
  session: dbSessions.SessionRow,
  providerSessionId: string,
  transcriptPath: string | null,
  userId?: string,
): Promise<string> {
  const provider = cliProviderRegistry.getProvider(session.provider);
  if (typeof provider.readTerminalTranscriptFingerprint !== 'function') return 'unresolved';
  try {
    return await provider.readTerminalTranscriptFingerprint({
      providerSessionId,
      transcriptPath,
      ...(userId ? { userId } : {}),
    }) ?? 'unresolved';
  } catch (error) {
    logger.debug({
      sessionId: session.id,
      provider: session.provider,
      error: (error as Error).message,
    }, 'Terminal transcript fingerprint failed; decoding without cache');
    return 'unresolved';
  }
}

async function decodeReplayState(
  session: dbSessions.SessionRow,
  userId?: string,
): Promise<SessionReplayState | null> {
  const provider = cliProviderRegistry.getProvider(session.provider);
  if (typeof provider.readTerminalTranscriptEvents !== 'function') return null;

  // provider마다 세션 id 체계가 다르다 — claude만 Tessera 세션 id를 그대로 쓰고,
  // codex/opencode는 provider_state에 따로 적힌 id를 쓴다. Tessera id를 넘기면
  // rollout 파일명과 안 맞아 조용히 "기록 없음"이 된다.
  const providerSessionId = readPersistedTerminalProviderSessionId(session);
  if (!providerSessionId) return null;

  const binding = getTerminalProviderSessionForTesseraSession(session.id);
  const events: SessionHistoryEvent[] | null = await provider.readTerminalTranscriptEvents({
    sessionId: session.id,
    providerSessionId,
    transcriptPath: binding?.transcript_path ?? null,
    ...(userId ? { userId } : {}),
  });
  if (!events) return null;

  return reduceSessionReplayEvents(session.id, events, { lazyToolOutput: false });
}

/**
 * Decode (or reuse) the full replay state for a terminal session.
 * Returns null when no transcript could be located — callers surface that as
 * "no history" rather than an error, since a freshly launched PTY has none yet.
 */
export async function readTerminalSessionReplayState(
  session: dbSessions.SessionRow,
  userId?: string,
): Promise<SessionReplayState | null> {
  const providerSessionId = readPersistedTerminalProviderSessionId(session);
  if (!providerSessionId) return null;

  const binding = getTerminalProviderSessionForTesseraSession(session.id);
  const fingerprint = await transcriptFingerprint(
    session,
    providerSessionId,
    binding?.transcript_path ?? null,
    userId,
  );

  const cached = cache.get(session.id);
  // An unfingerprintable source is never served from cache — the transcript may
  // have appeared, or changed, since the last read.
  if (cached && cached.fingerprint === fingerprint && fingerprint !== 'unresolved') {
    // Refresh recency so an actively viewed session is not the next evicted.
    rememberDecoded(session.id, cached);
    return cached.state;
  }

  const state = await decodeReplayState(session, userId);
  if (!state) {
    cache.delete(session.id);
    return null;
  }

  rememberDecoded(session.id, { fingerprint, state });
  logger.debug({
    sessionId: session.id,
    provider: session.provider,
    messageCount: state.messages.length,
  }, 'Decoded terminal session transcript');
  return state;
}

/** Page a terminal session's transcript using the same cursor contract as Tessera history. */
export async function readTerminalSessionHistory(
  session: dbSessions.SessionRow,
  options: { limit?: number; beforeBytes?: number; userId?: string } = {},
): Promise<TerminalSessionHistoryPage | null> {
  const state = await readTerminalSessionReplayState(session, options.userId);
  if (!state) return null;

  const { messages, hasMore, nextBeforeBytes } = paginateReplayMessages(state.messages, options);
  return {
    messages,
    todoSnapshot: state.todoSnapshot,
    hasMore,
    nextBeforeBytes,
  };
}
