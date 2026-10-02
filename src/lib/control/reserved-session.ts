import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import { ControlOperationError } from './service';
/** Caller owns the transaction and post-commit publication (automation reserves run + row together). */
export function createReservedControlSession(sessionId: string, request: {
  worktreeId: string; title?: string; provider: string; model?: string;
  reasoningEffort?: string; serviceTier?: 'default' | 'fast' | null;
}): void {
  const worktree = getDb().prepare(`SELECT id AS task_id, project_id FROM tasks
    WHERE public_worktree_id = ? AND archived = 0 AND worktree_deleted_at IS NULL`)
    .get(request.worktreeId) as { task_id: string; project_id: string } | undefined;
  if (!worktree) throw new ControlOperationError('WORKTREE_NOT_FOUND', 'The Worktree is unavailable.', 404);
  dbSessions.createSession(sessionId, worktree.project_id, request.title?.trim() || 'New Session', request.provider, {
    taskId: worktree.task_id, providerState: JSON.stringify({ kind: 'terminal' }),
    model: request.model?.trim(), reasoningEffort: request.reasoningEffort?.trim(), serviceTier: request.serviceTier ?? undefined,
  });
}
