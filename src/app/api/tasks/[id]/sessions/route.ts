import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbTasks from '@/lib/db/tasks';
import logger from '@/lib/logger';

/**
 * POST /api/tasks/[id]/sessions
 * Adds a session to a task by updating sessions.task_id.
 * Body: { sessionId: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id: taskId } = await params;

  if (!dbTasks.taskExists(taskId)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { sessionId } = body as { sessionId?: unknown };

  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  try {
    dbTasks.addSessionToTask(taskId, sessionId.trim());
    logger.info({ taskId, sessionId }, 'Session added to task via API');
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ taskId, sessionId, error: err }, 'Failed to add session to task');
    return NextResponse.json({ error: 'Failed to add session to task' }, { status: 500 });
  }
}
