import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import logger from '@/lib/logger';

/**
 * DELETE /api/sessions/[id]
 *
 * Delete a session (Simple Delete - MVP)
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  const params = await context.params;
  const sessionId = params.id;

  // BR-DEL-001: Validate sessionId format (prevent path traversal)
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session ID', code: 'INVALID_SESSION_ID' },
      { status: 400 }
    );
  }

  try {
    await sessionOrchestrator.deleteSession(userId, sessionId);

    logger.info({ userId, sessionId }, 'Session deleted via API');

    return NextResponse.json({ success: true });
  } catch (err: any) {
    logger.error({
      userId,
      sessionId,
      error: err,
      }, 'Delete session API error');

    // BR-DEL-001: Permission denied or not found
    if (err.message.includes('not found') || err.message.includes('permission denied')) {
      return NextResponse.json(
        { error: 'Session not found or permission denied', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // BR-DEL-004: File deletion errors (EACCES, EBUSY)
    if (err.message.includes('EACCES')) {
      return NextResponse.json(
        { error: 'Permission denied - retry later', code: 'EACCES' },
        { status: 500 }
      );
    }

    if (err.message.includes('EBUSY')) {
      return NextResponse.json(
        { error: 'File in use - retry later', code: 'EBUSY' },
        { status: 500 }
      );
    }

    // Generic server error
    return NextResponse.json(
      { error: 'Failed to delete session', code: 'SERVER_ERROR' },
      { status: 500 }
    );
  }
}
