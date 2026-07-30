import fs from 'fs/promises';
import path from 'path';
import * as dbSessions from './db/sessions';
import logger from './logger';
import {
  reduceHistoryEventsToReplayState,
  sessionHistory,
  type SessionHistoryEvent,
} from './session-history';
import {
  readNativeTranscript,
  resolveNativeTranscriptSourcePath,
} from './session/native-transcript';
import type { NativeTranscriptMessage } from './session/native-transcript-types';
import { getTesseraDataPath } from './tessera-data-dir';
import type { ContentBlock } from './ws/message-types';
import type { EnhancedMessage, TextMessage } from '@/types/chat';

const EXPORT_DIR = getTesseraDataPath('session-exports');

export interface SessionExportOptions {
  untilMessageId?: string;
  untilMessageIndex?: number;
  /**
   * Owner of the export request. Only needed for terminal sessions, where the
   * agent environment decides how to translate the CLI-reported transcript path.
   */
  userId?: string;
}

function assertValidSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
}

function isTextMessage(message: EnhancedMessage): message is TextMessage {
  return message.type === 'text' && (message.role === 'user' || message.role === 'assistant');
}

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => block.type === 'text' ? block.text : '[image]')
    .join('\n');
}

function formatTurn(role: 'user' | 'assistant', text: string): string {
  return `**${role === 'user' ? 'User' : 'Assistant'}:**\n${text}\n`;
}

function joinTurns(parts: string[]): string | null {
  return parts.length > 0 ? parts.join('\n') : null;
}

function buildMarkdownFromTextMessages(messages: EnhancedMessage[]): string | null {
  const parts: string[] = [];

  for (const message of messages) {
    if (!isTextMessage(message)) {
      continue;
    }

    const text = extractTextContent(message.content).trim();
    if (!text) {
      continue;
    }

    parts.push(formatTurn(message.role === 'user' ? 'user' : 'assistant', text));
  }

  return joinTurns(parts);
}

function resolveCutoffIndex(messages: EnhancedMessage[], options: SessionExportOptions): number {
  if (messages.length === 0) {
    return -1;
  }

  if (options.untilMessageId) {
    const messageIndex = messages.findIndex((message) => message.id === options.untilMessageId);
    if (messageIndex !== -1) {
      return messageIndex;
    }
  }

  if (Number.isInteger(options.untilMessageIndex)) {
    return Math.min(Math.max(options.untilMessageIndex!, 0), messages.length - 1);
  }

  if (options.untilMessageId) {
    throw new Error('Message cutoff not found');
  }

  return messages.length - 1;
}

function buildPartialExportPath(sessionId: string, options: SessionExportOptions): string {
  const rawSuffix = options.untilMessageId ?? `message-${options.untilMessageIndex ?? 0}`;
  const safeSuffix = rawSuffix.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96) || 'message';
  return path.join(EXPORT_DIR, `${sessionId}-through-${safeSuffix}.md`);
}

/**
 * Build markdown from session-history JSONL events.
 * Extracts only user_message and assistant_message events (same as the old session-log format).
 */
function buildMarkdownFromHistoryEvents(events: SessionHistoryEvent[]): string | null {
  const parts: string[] = [];

  for (const event of events) {
    if (event.type === 'user_message') {
      const text = extractTextContent(event.content);
      if (text.trim()) {
        parts.push(formatTurn('user', text.trim()));
      }
    } else if (event.type === 'assistant_message') {
      const text = typeof event.content === 'string' ? event.content : '';
      if (text.trim()) {
        parts.push(formatTurn('assistant', text.trim()));
      }
    }
  }

  return joinTurns(parts);
}

function buildMarkdownFromNativeMessages(messages: NativeTranscriptMessage[]): string | null {
  return joinTurns(messages.map((message) => formatTurn(message.role, message.text)));
}

/**
 * Terminal sessions only ever get `user_message` events: the hooks observe
 * lifecycle, and a stock Stop payload carries no assistant text. Without this
 * check the export would silently succeed as a list of bare prompts.
 */
function hasAssistantMessage(events: SessionHistoryEvent[]): boolean {
  return events.some((event) => event.type === 'assistant_message');
}

/** What the user actually typed, as recorded by `UserPromptSubmit`. */
function collectUserPrompts(events: SessionHistoryEvent[]): string[] {
  const prompts: string[] = [];
  for (const event of events) {
    if (event.type !== 'user_message') continue;
    const text = extractTextContent(event.content).trim();
    if (text) prompts.push(text);
  }
  return prompts;
}

async function buildMarkdownUntilMessage(
  sessionId: string,
  events: SessionHistoryEvent[],
  options: SessionExportOptions,
): Promise<string | null> {
  const replayState = reduceHistoryEventsToReplayState(sessionId, events, {
    lazyToolOutput: false,
  });
  const cutoffIndex = resolveCutoffIndex(replayState.messages, options);

  if (cutoffIndex < 0) {
    return null;
  }

  return buildMarkdownFromTextMessages(replayState.messages.slice(0, cutoffIndex + 1));
}

async function statModifiedTime(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * True when the cached export is newer than every source it was built from.
 *
 * Sources outlive nothing: Claude prunes `~/.claude/projects` on
 * `cleanupPeriodDays` (30 by default), and a workspace can be deleted at any
 * time. Once every source is gone the export Tessera wrote is the only
 * surviving copy of that conversation, so it is served as-is rather than
 * rebuilt into a failure.
 */
async function isExportUpToDate(
  exportPath: string,
  sourcePaths: Array<string | null>,
): Promise<boolean> {
  const sources = sourcePaths.filter((sourcePath): sourcePath is string => Boolean(sourcePath));
  if (sources.length === 0) return false;

  const exportModifiedAt = await statModifiedTime(exportPath);
  if (exportModifiedAt === null) return false;

  const sourceModifiedTimes = (await Promise.all(sources.map(statModifiedTime)))
    .filter((modifiedAt): modifiedAt is number => modifiedAt !== null);
  if (sourceModifiedTimes.length === 0) return true;

  return sourceModifiedTimes.every((modifiedAt) => exportModifiedAt >= modifiedAt);
}

export async function exportSessionLog(
  sessionId: string,
  sessionTitle: string,
  options: SessionExportOptions = {},
): Promise<string> {
  assertValidSessionId(sessionId);

  // Flush in-memory buffers to disk BEFORE mtime comparison
  sessionHistory.flushSession(sessionId);

  const isPartialExport = Boolean(options.untilMessageId) || options.untilMessageIndex !== undefined;
  const exportPath = isPartialExport
    ? buildPartialExportPath(sessionId, options)
    : path.join(EXPORT_DIR, `${sessionId}.md`);
  const historyPath = sessionHistory.getHistoryPath(sessionId);
  const events = await sessionHistory.readEvents(sessionId);

  // Partial exports replay Tessera-side messages, which terminal sessions never
  // have — the native fallback only applies to a full export.
  const session = !isPartialExport && !hasAssistantMessage(events)
    ? dbSessions.getSession(sessionId)
    : undefined;
  const nativeSourcePath = session
    ? await resolveNativeTranscriptSourcePath(session, options.userId)
    : null;

  if (await isExportUpToDate(exportPath, session ? [nativeSourcePath] : [historyPath])) {
    logger.info({ sessionId, partial: isPartialExport }, 'Session export cache hit');
    return exportPath;
  }

  let logContent: string | null;
  if (isPartialExport) {
    logContent = await buildMarkdownUntilMessage(sessionId, events, options);
  } else if (session) {
    const { messages } = await readNativeTranscript(session, {
      userId: options.userId,
      knownUserPrompts: collectUserPrompts(events),
    });
    // Prompts alone are not a conversation: refuse rather than hand the agent a
    // half-context it cannot tell is incomplete.
    logContent = messages.some((message) => message.role === 'assistant')
      ? buildMarkdownFromNativeMessages(messages)
      : null;
  } else {
    logContent = buildMarkdownFromHistoryEvents(events);
  }

  if (!logContent) {
    throw new Error('No conversation log found');
  }

  const header = isPartialExport
    ? `# Session Fork: ${sessionTitle}\n_ID: ${sessionId}_\n_Partial export through selected message._\n\n`
    : `# Session: ${sessionTitle}\n_ID: ${sessionId}_\n\n`;
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await fs.writeFile(exportPath, header + logContent, 'utf-8');

  logger.info({
    sessionId,
    exportPath,
    partial: isPartialExport,
    ...(session ? { source: 'native-transcript' } : {}),
  }, 'Session exported');
  return exportPath;
}
