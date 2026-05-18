import fs from 'fs/promises';
import path from 'path';
import logger from './logger';
import {
  reduceHistoryEventsToReplayState,
  sessionHistory,
  type SessionHistoryEvent,
} from './session-history';
import { getTesseraDataPath } from './tessera-data-dir';
import type { ContentBlock } from './ws/message-types';
import type { EnhancedMessage, TextMessage } from '@/types/chat';

const EXPORT_DIR = getTesseraDataPath('session-exports');

export interface SessionExportOptions {
  untilMessageId?: string;
  untilMessageIndex?: number;
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

    parts.push(`**${message.role === 'user' ? 'User' : 'Assistant'}:**\n${text}\n`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
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
        parts.push(`**User:**\n${text.trim()}\n`);
      }
    } else if (event.type === 'assistant_message') {
      const text = typeof event.content === 'string' ? event.content : '';
      if (text.trim()) {
        parts.push(`**Assistant:**\n${text.trim()}\n`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

async function buildMarkdownFromHistory(sessionId: string): Promise<string | null> {
  const events = await sessionHistory.readEvents(sessionId);
  return buildMarkdownFromHistoryEvents(events);
}

async function buildMarkdownUntilMessage(
  sessionId: string,
  options: SessionExportOptions,
): Promise<string | null> {
  const events = await sessionHistory.readEvents(sessionId);
  const replayState = reduceHistoryEventsToReplayState(sessionId, events, {
    lazyToolOutput: false,
  });
  const cutoffIndex = resolveCutoffIndex(replayState.messages, options);

  if (cutoffIndex < 0) {
    return null;
  }

  return buildMarkdownFromTextMessages(replayState.messages.slice(0, cutoffIndex + 1));
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

  // Cache: compare JSONL mtime vs export mtime
  try {
    const [exportStat, historyStat] = await Promise.all([
      fs.stat(exportPath),
      fs.stat(historyPath),
    ]);
    if (exportStat.mtimeMs >= historyStat.mtimeMs) {
      logger.info({ sessionId, partial: isPartialExport }, 'Session export cache hit');
      return exportPath;
    }
  } catch {
    // Export or history doesn't exist yet — generate
  }

  const logContent = isPartialExport
    ? await buildMarkdownUntilMessage(sessionId, options)
    : await buildMarkdownFromHistory(sessionId);
  if (!logContent) {
    throw new Error('No conversation log found');
  }

  const header = isPartialExport
    ? `# Session Fork: ${sessionTitle}\n_ID: ${sessionId}_\n_Partial export through selected message._\n\n`
    : `# Session: ${sessionTitle}\n_ID: ${sessionId}_\n\n`;
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await fs.writeFile(exportPath, header + logContent, 'utf-8');

  logger.info({ sessionId, exportPath, partial: isPartialExport }, 'Session exported');
  return exportPath;
}
