import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { removeWorktreeById } from '@/lib/archive/archive-service';
import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';
import * as dbWorktrees from '@/lib/db/worktrees';
import logger from '@/lib/logger';
import { isTerminalHandoffConflictError } from '@/lib/terminal/terminal-handoff-lock';
import {
  broadcastSessionMutation,
  broadcastTaskMutation,
  getOriginClientIdFromRequest,
} from '@/lib/ws/mutation-broadcast';

const PUBLIC_WORKTREE_ID = /^wt_[A-Za-z0-9_-]+$/;

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!PUBLIC_WORKTREE_ID.test(id)) {
    return NextResponse.json({ error: 'Invalid Worktree ID' }, { status: 400 });
  }

  try {
    const affectedTasks = dbWorktrees.getTaskIdsForWorktree(id)
      .map((taskId) => ({ taskId, projectId: dbTasks.getTask(taskId)?.projectId }))
      .filter((entry): entry is { taskId: string; projectId: string } => Boolean(entry.projectId));
    const affectedSessions = dbWorktrees.getSessionIdsForWorktree(id)
      .map((sessionId) => {
        const session = dbSessions.getSession(sessionId);
        return {
          sessionId,
          projectId: session?.project_id,
          taskId: session?.task_id ?? undefined,
        };
      })
      .filter((entry): entry is { sessionId: string; projectId: string; taskId: string | undefined } => (
        Boolean(entry.projectId)
      ));
    await removeWorktreeById(id, auth.userId);
    const originClientId = getOriginClientIdFromRequest(req);
    for (const { taskId, projectId } of affectedTasks) {
      broadcastTaskMutation(auth.userId, { kind: 'updated', projectId, taskId, originClientId });
    }
    for (const { sessionId, projectId, taskId } of affectedSessions) {
      broadcastSessionMutation(auth.userId, {
        kind: 'updated',
        projectId,
        sessionId,
        taskId,
        originClientId,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete Worktree';
    const handoffConflict = isTerminalHandoffConflictError(error);
    logger.warn({ worktreeId: id, error: message }, 'Failed to delete Worktree');
    return NextResponse.json(
      { error: message, ...(handoffConflict ? { code: error.code } : {}) },
      { status: handoffConflict ? 409 : 400 },
    );
  }
}
