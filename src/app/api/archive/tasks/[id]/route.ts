import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  permanentlyDeleteArchivedTask,
  pruneExpiredArchivedWorktrees,
  setTaskArchived,
} from '@/lib/archive/archive-service';
import { SettingsManager } from '@/lib/settings/manager';
import * as dbTasks from '@/lib/db/tasks';
import logger from '@/lib/logger';
import {
  broadcastSessionMutation,
  broadcastTaskMutation,
  getOriginClientIdFromRequest,
} from '@/lib/ws/mutation-broadcast';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { archived } = body as { archived?: unknown };
  if (typeof archived !== 'boolean') {
    return NextResponse.json({ error: 'archived must be a boolean' }, { status: 400 });
  }

  try {
    const projectId = dbTasks.getTask(id)?.projectId;
    await setTaskArchived(id, archived);
    if (archived) {
      const settings = await SettingsManager.load(auth.userId);
      if (settings.autoDeleteArchivedWorktrees) {
        await pruneExpiredArchivedWorktrees(settings.archivedWorktreeRetentionDays, auth.userId);
      }
    }
    if (projectId) {
      const originClientId = getOriginClientIdFromRequest(req);
      broadcastTaskMutation(auth.userId, { kind: 'updated', projectId, originClientId });
      // Sessions linked to this task carry archived/isReadOnly state too.
      broadcastSessionMutation(auth.userId, { kind: 'updated', projectId, originClientId });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update task archive state';
    logger.error({ taskId: id, error: message }, 'Failed to update task archive state');
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const projectId = dbTasks.getTask(id)?.projectId;
    await permanentlyDeleteArchivedTask(auth.userId, id);
    if (projectId) {
      const originClientId = getOriginClientIdFromRequest(req);
      broadcastTaskMutation(auth.userId, { kind: 'deleted', projectId, originClientId });
      broadcastSessionMutation(auth.userId, { kind: 'updated', projectId, originClientId });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete archived task';
    logger.error({ taskId: id, error: message }, 'Failed to delete archived task');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
