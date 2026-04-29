import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { reorderTasks } from '@/lib/db/tasks';
import logger from '@/lib/logger';

/**
 * PATCH /api/tasks/reorder
 * Body: { orderedIds: string[] }
 *
 * Updates sort_order for tasks based on the given ID order.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  try {
    const body = await req.json();
    const { orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json({ error: 'orderedIds must be a non-empty array' }, { status: 400 });
    }

    reorderTasks(orderedIds);
    logger.info({ count: orderedIds.length }, 'Tasks reordered');

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error({ error }, 'Failed to reorder tasks');
    return NextResponse.json({ error: 'Failed to reorder tasks' }, { status: 500 });
  }
}
