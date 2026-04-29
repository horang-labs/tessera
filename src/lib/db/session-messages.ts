/**
 * CRUD operations for the session_messages table.
 *
 * Provides simple insert and query helpers for persisting chat messages
 * associated with a session. The session_messages table stores user and
 * assistant messages so they can be replayed when a session is reopened.
 */

import { getDb } from './database';
import type { EnhancedMessage } from '@/types/chat';

interface SessionMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

/**
 * Insert a message into the session_messages table.
 *
 * @param sessionId - The session this message belongs to.
 * @param role      - The speaker role ('user' | 'assistant' | 'system').
 * @param content   - The text content of the message.
 */
export function insertMessage(
  sessionId: string,
  role: string,
  content: string
): void {
  getDb()
    .prepare(
      'INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(sessionId, role, content, Date.now());
}

/**
 * Retrieve all messages for a session, ordered by creation time ascending.
 *
 * Each row is mapped to an EnhancedMessage (TextMessage variant) so it can
 * be passed directly to the frontend message renderer.
 *
 * @param sessionId - The session whose messages should be retrieved.
 * @returns Array of EnhancedMessage objects ordered oldest-first.
 */
export function getMessages(sessionId: string): EnhancedMessage[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC'
    )
    .all(sessionId) as SessionMessageRow[];

  return rows.map((row, i): EnhancedMessage => ({
    id: `db-msg-${sessionId}-${i}`,
    type: 'text',
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    timestamp: new Date(row.created_at).toISOString(),
  }));
}
