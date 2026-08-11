import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { archiveSession } from '@/lib/session/session-archive';
import { restoreArchivedChat } from '@/lib/archive/archive-service';
import { getSession } from '@/lib/db/sessions';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import {
  isSessionOperationConflictError,
  isTerminalHandoffConflictError,
} from '@/lib/terminal/terminal-handoff-lock';

/**
 * PATCH /api/sessions/[id]/archive
 *
 * Updates the archive status for a session.
 * Persists to ~/.tessera/task-metadata.json.
 * Invalidates the project cache.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  const { id: sessionId } = await params;

  // Validate sessionId format (prevent path traversal — defense in depth)
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { archived } = body as { archived?: unknown };

  // Validate archived is a boolean
  if (typeof archived !== 'boolean') {
    return NextResponse.json(
      { error: 'archived must be a boolean' },
      { status: 400 }
    );
  }

  try {
    const session = getSession(sessionId);
    const result = archived
      ? await archiveSession(sessionId, true, auth.userId)
      : (await restoreArchivedChat(sessionId, auth.userId), { ok: true, worktreeRemoved: false });

    logger.info({ sessionId, archived }, 'Session archive status updated');

    broadcastSessionMutation(auth.userId, {
      kind: 'updated',
      projectId: session?.project_id,
      sessionId,
      taskId: session?.task_id ?? undefined,
      archived,
      originClientId: getOriginClientIdFromRequest(req),
    });

    return NextResponse.json({ ...result, taskId: session?.task_id ?? undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update archive status';
    const mutationConflict = isTerminalHandoffConflictError(err) || isSessionOperationConflictError(err);
    const status = mutationConflict
      ? 409
      : message === 'Session not found'
        ? 404
        : 400;
    logger.error({ sessionId, error: err }, 'Failed to update archive status');
    return NextResponse.json(
      {
        error: message,
        ...(mutationConflict ? { code: err.code } : {}),
      },
      { status }
    );
  }
}
