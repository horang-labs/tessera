import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import logger from './logger';
import { sessionHistory } from './session-history';

const EXPORT_DIR = path.join(os.homedir(), '.tessera', 'session-exports');

function assertValidSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
}

/**
 * Build markdown from session-history JSONL events.
 * Extracts only user_message and assistant_message events (same as the old session-log format).
 */
async function buildMarkdownFromHistory(sessionId: string): Promise<string | null> {
  const events = await sessionHistory.readEvents(sessionId);

  const parts: string[] = [];

  for (const event of events) {
    if (event.type === 'user_message') {
      let text = '';
      if (typeof event.content === 'string') {
        text = event.content;
      } else if (Array.isArray(event.content)) {
        text = (event.content as any[])
          .map(b => b.type === 'text' ? b.text : '[image]')
          .join('\n');
      }
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

export async function exportSessionLog(sessionId: string, sessionTitle: string): Promise<string> {
  assertValidSessionId(sessionId);

  // Flush in-memory buffers to disk BEFORE mtime comparison
  sessionHistory.flushSession(sessionId);

  const exportPath = path.join(EXPORT_DIR, `${sessionId}.md`);
  const historyPath = sessionHistory.getHistoryPath(sessionId);

  // Cache: compare JSONL mtime vs export mtime
  try {
    const [exportStat, historyStat] = await Promise.all([
      fs.stat(exportPath),
      fs.stat(historyPath),
    ]);
    if (exportStat.mtimeMs >= historyStat.mtimeMs) {
      logger.info({ sessionId }, 'Session export cache hit');
      return exportPath;
    }
  } catch {
    // Export or history doesn't exist yet — generate
  }

  const logContent = await buildMarkdownFromHistory(sessionId);
  if (!logContent) {
    throw new Error('No conversation log found');
  }

  const header = `# Session: ${sessionTitle}\n_ID: ${sessionId}_\n\n`;
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await fs.writeFile(exportPath, header + logContent, 'utf-8');

  logger.info({ sessionId, exportPath }, 'Session exported');
  return exportPath;
}
