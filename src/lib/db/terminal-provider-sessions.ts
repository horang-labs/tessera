import { getDb } from './database';

export interface TerminalProviderSessionRow {
  provider_id: string;
  provider_session_id: string;
  tessera_session_id: string;
  transcript_path: string | null;
  created_at: string;
  updated_at: string;
}

export function getTerminalProviderSession(
  providerId: string,
  providerSessionId: string,
): TerminalProviderSessionRow | undefined {
  return getDb().prepare(`
    SELECT * FROM terminal_provider_sessions
    WHERE provider_id = ? AND provider_session_id = ?
  `).get(providerId, providerSessionId) as TerminalProviderSessionRow | undefined;
}

export function getTerminalProviderSessionForTesseraSession(
  tesseraSessionId: string,
): TerminalProviderSessionRow | undefined {
  return getDb().prepare(`
    SELECT * FROM terminal_provider_sessions
    WHERE tessera_session_id = ?
  `).get(tesseraSessionId) as TerminalProviderSessionRow | undefined;
}

export function bindTerminalProviderSession(options: {
  providerId: string;
  providerSessionId: string;
  tesseraSessionId: string;
  transcriptPath?: string;
}): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO terminal_provider_sessions (
      provider_id, provider_session_id, tessera_session_id,
      transcript_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, provider_session_id) DO UPDATE SET
      tessera_session_id = excluded.tessera_session_id,
      transcript_path = COALESCE(excluded.transcript_path, terminal_provider_sessions.transcript_path),
      updated_at = excluded.updated_at
  `).run(
    options.providerId,
    options.providerSessionId,
    options.tesseraSessionId,
    options.transcriptPath ?? null,
    now,
    now,
  );
}

export function deleteTerminalProviderSessionsForTesseraSession(tesseraSessionId: string): void {
  getDb().prepare('DELETE FROM terminal_provider_sessions WHERE tessera_session_id = ?')
    .run(tesseraSessionId);
}
