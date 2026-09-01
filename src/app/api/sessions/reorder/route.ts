import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSession, reorderSessionsByIds } from '@/lib/db/sessions';
import { getTaskProjectViewIds } from '@/lib/projects/project-view-projection';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import logger from '@/lib/logger';

/**
 * PATCH /api/sessions/reorder
 * Body: { orderedIds }. Project View placement is not Session ownership.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  try {
    const body = await req.json();
    const { orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
    }

    const firstSession = typeof orderedIds[0] === 'string'
      ? getSession(orderedIds[0])
      : undefined;
    const taskId = firstSession?.task_id ?? undefined;
    const affectedProjectIds = taskId
      ? getTaskProjectViewIds(taskId)
      : firstSession?.project_id ? [firstSession.project_id] : [];

    reorderSessionsByIds(orderedIds);
    logger.info({ count: orderedIds.length }, 'Sessions reordered by canonical IDs');

    broadcastSessionMutation(auth.userId, {
      kind: 'reordered',
      projectId: firstSession?.project_id,
      sessionId: firstSession?.id,
      taskId,
      affectedProjectIds,
      originClientId: getOriginClientIdFromRequest(req),
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error({ error }, 'Failed to reorder sessions');
    return NextResponse.json({ error: 'Failed to reorder sessions' }, { status: 500 });
  }
}
