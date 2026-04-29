import { NextRequest, NextResponse } from 'next/server';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';

/**
 * PATCH /api/sessions/[id]/rename - Rename a session
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  try {
    const auth = await requireAuthenticatedUserId(req);
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;
    const body = await req.json();
    const { title } = body;

    if (!title || typeof title !== 'string') {
      return NextResponse.json(
        { error: 'Title is required and must be a string' },
        { status: 400 }
      );
    }

    await sessionOrchestrator.renameSession(userId, sessionId, title);

    logger.info({ userId, sessionId, title }, 'Session renamed via API');

    return NextResponse.json({ success: true, title });
  } catch (err: any) {
    if (err.message.includes('Title too long')) {
      return NextResponse.json(
        { error: 'Title too long (max 100 characters)' },
        { status: 400 }
      );
    }

    logger.error({
      sessionId,
      error: err,
      }, 'Failed to rename session');
    return NextResponse.json(
      { error: 'Failed to rename session' },
      { status: 500 }
    );
  }
}
