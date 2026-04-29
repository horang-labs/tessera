import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSession, updateSession } from '@/lib/db/sessions';
import { collectionExists } from '@/lib/db/collections';
import { updateTask } from '@/lib/db/tasks';
import logger from '@/lib/logger';

/**
 * PATCH /api/sessions/[id]/collection
 * Updates a session's collection_id. Body: { collectionId: string | null }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { collectionId } = body as { collectionId?: unknown };

  // collectionId must be null or a valid string
  if (collectionId !== null && collectionId !== undefined && typeof collectionId !== 'string') {
    return NextResponse.json({ error: 'collectionId must be a string or null' }, { status: 400 });
  }

  // If collectionId is a non-null string, verify the collection exists
  if (typeof collectionId === 'string' && !collectionExists(collectionId, session.project_id)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  try {
    if (session.task_id) {
      updateTask(session.task_id, {
        collection_id: collectionId ?? null,
      });
      logger.info(
        { sessionId: id, taskId: session.task_id, collectionId: collectionId ?? null },
        'Task-linked session collection updated via parent task',
      );
    } else {
      updateSession(id, {
        collection_id: collectionId ?? null,
      });
      logger.info({ sessionId: id, collectionId: collectionId ?? null }, 'Session collection updated');
    }
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ sessionId: id, error: err }, 'Failed to update session collection');
    return NextResponse.json({ error: 'Failed to update session collection' }, { status: 500 });
  }
}
