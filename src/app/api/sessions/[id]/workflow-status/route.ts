import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSession, updateSession } from '@/lib/db/sessions';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import { WORKFLOW_STATUS_ORDER } from '@/types/task-entity';
import logger from '@/lib/logger';

const WORKFLOW_STATUS_VALUES = new Set<string>(WORKFLOW_STATUS_ORDER);

/**
 * PATCH /api/sessions/[id]/workflow-status
 * Updates a standalone chat session's logical workflow status.
 * Body: { workflowStatus: 'todo' | 'in_progress' | 'in_review' | 'done' | null | 'chat' }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.task_id) {
    return NextResponse.json({ error: 'Use the task workflow endpoint for task-linked sessions' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { workflowStatus } = body as { workflowStatus?: unknown };
  const normalizedStatus =
    workflowStatus === null || workflowStatus === 'chat'
      ? null
      : typeof workflowStatus === 'string'
        ? workflowStatus
        : undefined;

  if (normalizedStatus !== null && !WORKFLOW_STATUS_VALUES.has(String(normalizedStatus))) {
    return NextResponse.json({ error: 'Invalid workflowStatus' }, { status: 400 });
  }

  try {
    updateSession(id, { chat_workflow_status: normalizedStatus });
    logger.info({ sessionId: id, workflowStatus: normalizedStatus }, 'Chat workflow status updated');
    broadcastSessionMutation(auth.userId, {
      kind: 'updated',
      projectId: session.project_id,
      originClientId: getOriginClientIdFromRequest(req),
    });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ sessionId: id, error: err }, 'Failed to update chat workflow status');
    return NextResponse.json({ error: 'Failed to update chat workflow status' }, { status: 500 });
  }
}
