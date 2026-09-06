import { getDb } from '@/lib/db/database';
import { extractSessionKind } from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { isServerShuttingDown } from '@/lib/server-lifecycle';
import type { ProviderLaunchRequest } from '@/lib/terminal/provider-launch-module';

/** Persist intent on real runtime transitions, never on renderer attachment. */
export function recordSessionRuntime(event: {
  sessionId: string;
  userId: string;
  running: boolean;
}): void {
  // Shutdown terminates PTYs but must retain the next launch's recovery set.
  if (isServerShuttingDown()) return;
  const db = getDb();
  if (event.running) {
    db.prepare(`
      INSERT INTO session_runtime_recovery (session_id, user_id)
      SELECT id, ? FROM sessions WHERE id = ? AND deleted = 0
      ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id
    `).run(event.userId, event.sessionId);
  } else {
    db.prepare('DELETE FROM session_runtime_recovery WHERE session_id = ? AND user_id = ?')
      .run(event.sessionId, event.userId);
  }
}

/** Background recovery has no dependency on tabs, panels, or project selection. */
export async function restoreSessionRuntimes(
  launch: (request: ProviderLaunchRequest) => Promise<unknown>,
): Promise<void> {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT r.session_id, r.user_id, s.provider_state
    FROM session_runtime_recovery r
    JOIN sessions s ON s.id = r.session_id
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.deleted = 0 AND s.archived = 0
      AND (s.task_id IS NULL OR COALESCE(t.archived, 0) = 0)
  `).all() as Array<{ session_id: string; user_id: string; provider_state: string | null }>;

  // Pace OS/WSL process creation while allowing one slow preparation not to
  // block all the other projects. The launch module arbitrates surface races.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, sessions.length) }, async () => {
    while (next < sessions.length && !isServerShuttingDown()) {
      const session = sessions[next++];
      if (extractSessionKind(session.provider_state) !== 'terminal') continue;
      // An explicit stop may have removed the intent while another launch waited.
      if (!db.prepare('SELECT 1 FROM session_runtime_recovery WHERE session_id = ?')
        .get(session.session_id)) continue;
      try {
        await launch({ sessionId: session.session_id, userId: session.user_id, mode: 'detached' });
      } catch (error) {
        if ((error as { code?: string })?.code === 'SESSION_RUNTIME_ALREADY_RUNNING') continue;
        logger.warn({ error, sessionId: session.session_id }, 'Session runtime recovery failed');
      }
    }
  }));
}
