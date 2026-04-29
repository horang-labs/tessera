import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { processManager } from '@/lib/cli/process-manager';
import * as dbTasks from '@/lib/db/tasks';
import { collectionExists } from '@/lib/db/collections';
import logger from '@/lib/logger';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { syncSingleSessionSessionTitleFromTask } from '@/lib/task-title-sync';

/**
 * GET /api/tasks/[id]
 * Returns a single task with its child sessions.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  try {
    const activeSessionIds = processManager.getActiveSessionIds();
    const task = dbTasks.getTask(id, activeSessionIds);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (err: unknown) {
    logger.error({ id, error: err }, 'Failed to fetch task');
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

/**
 * PATCH /api/tasks/[id]
 * Updates a task's title, collectionId, workflowStatus, worktreeBranch, or summary.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  const task = dbTasks.getTask(id);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { title, collectionId, workflowStatus, worktreeBranch, summary } = body as {
    title?: unknown;
    collectionId?: unknown;
    workflowStatus?: unknown;
    worktreeBranch?: unknown;
    summary?: unknown;
  };

  const patch: Record<string, unknown> = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json({ error: 'title must be a non-empty string' }, { status: 400 });
    }
    patch.title = title.trim();
  }
  if (collectionId !== undefined) {
    if (
      typeof collectionId === 'string' &&
      collectionId.trim().length > 0 &&
      !collectionExists(collectionId.trim(), task.projectId)
    ) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    patch.collection_id = typeof collectionId === 'string' && collectionId.trim().length > 0
      ? collectionId.trim()
      : null;
  }
  if (workflowStatus !== undefined) {
    if (typeof workflowStatus !== 'string') {
      return NextResponse.json({ error: 'workflowStatus must be a string' }, { status: 400 });
    }
    patch.workflow_status = workflowStatus;
  }
  if (worktreeBranch !== undefined) {
    patch.worktree_branch = typeof worktreeBranch === 'string' ? worktreeBranch : null;
  }
  if (summary !== undefined) {
    patch.summary = typeof summary === 'string' ? summary : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  try {
    dbTasks.updateTask(id, patch as any);
    if (typeof patch.title === 'string') {
      syncSingleSessionSessionTitleFromTask(id, patch.title, {
        hasCustomTitle: true,
        skipTimestamp: true,
      });
    }
    logger.info({ taskId: id, ...patch }, 'Task updated');
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ id, error: err }, 'Failed to update task');
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

/**
 * DELETE /api/tasks/[id]
 * Deletes a task and all child sessions.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  const task = dbTasks.getTask(id, processManager.getActiveSessionIds());
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  try {
    for (const session of task.sessions) {
      await sessionOrchestrator.deleteSession(auth.userId, session.id);
    }

    const { deletedSessionCount: fallbackDeletedSessionCount } = dbTasks.deleteTask(id);
    const deletedSessionCount = task.sessions.length + fallbackDeletedSessionCount;
    logger.info({ taskId: id, deletedSessionCount }, 'Task deleted via API');
    return NextResponse.json({
      ok: true,
      deletedSessionCount,
      unlinkedCount: deletedSessionCount,
    });
  } catch (err: unknown) {
    logger.error({ id, error: err }, 'Failed to delete task');
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
