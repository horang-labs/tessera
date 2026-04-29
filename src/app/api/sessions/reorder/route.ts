import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { reorderSessions, reorderSessionsByIds } from '@/lib/db/sessions';
import logger from '@/lib/logger';

/**
 * PATCH /api/sessions/reorder
 * Body variants:
 *   1. { projectId, orderedIds } — project-scoped reorder
 *   2. { orderedIds }            — ID-only reorder
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  try {
    const body = await req.json();
    const { projectId, orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
    }

    if (projectId) {
      reorderSessions(projectId, orderedIds);
      logger.info({ projectId, count: orderedIds.length }, 'Sessions reordered');
    } else {
      reorderSessionsByIds(orderedIds);
      logger.info({ count: orderedIds.length }, 'Sessions reordered by IDs');
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error({ error }, 'Failed to reorder sessions');
    return NextResponse.json({ error: 'Failed to reorder sessions' }, { status: 500 });
  }
}
