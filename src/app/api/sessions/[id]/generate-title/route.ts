import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { generateAITitle } from '@/lib/session/ai-title-generator';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { syncSingleSessionTaskTitleFromSession } from '@/lib/task-title-sync';

/**
 * POST /api/sessions/[id]/generate-title
 *
 * Generates an AI title for a session by reading Tessera session-history,
 * delegating to the session's own CLI provider, and updating the DB.
 */
export async function POST(
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

    logger.info({ userId, sessionId }, 'AI title generation requested');

    const result = await generateAITitle(sessionId, userId);

    // Update DB with generated title (skip timestamp to preserve card order)
    dbSessions.updateSession(sessionId, {
      title: result.title,
      has_custom_title: 1,
    }, { skipTimestamp: true });
    syncSingleSessionTaskTitleFromSession(sessionId, result.title);

    logger.info({ userId, sessionId, title: result.title }, 'AI title saved to DB');

    return NextResponse.json({
      success: true,
      title: result.title,
    });
  } catch (err: any) {
    const msg: string = err.message || 'Failed to generate title';
    const isNoConversation = msg.includes('No conversation messages found');
    const isNotSupported = msg.includes('Title generation not supported');

    if (isNoConversation || isNotSupported) {
      const code = isNoConversation ? 'no_conversation' : 'not_supported';
      logger.info({ sessionId, code }, 'AI title skipped');
      return NextResponse.json(
        { error: msg, code },
        { status: 422 }
      );
    }

    console.error(`[generate-title] ERROR for ${sessionId}:`, msg);
    logger.error({ sessionId, error: msg }, 'AI title generation failed');

    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}
