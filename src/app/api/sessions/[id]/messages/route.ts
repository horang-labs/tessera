import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { sessionHistory } from '@/lib/session-history';

function buildEmptyHistoryResponse(sessionId: string): NextResponse {
  return NextResponse.json({
    sessionId,
    messages: [],
    activeInteractivePrompt: null,
    pagination: { hasMore: false, nextBeforeBytes: 0 },
  });
}

/**
 * GET /api/sessions/[id]/messages
 *
 * Reads session messages from Tessera-managed canonical JSONL history.
 *
 * Query params:
 *   - limit (default: 100): Number of messages per page (max 500)
 *   - beforeBytes (optional): Opaque numeric cursor used for older-message paging
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // Resolve session from DB once — reused in both try and catch blocks
  const dbSession = dbSessions.getSession(id);

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;
    if (!dbSession) {
      return jsonError('not_found', 'Session not found', 404);
    }

    const hasHistory = await sessionHistory.historyExists(id);
    if (!hasHistory) {
      logger.info({ userId, sessionId: id, provider: dbSession.provider }, 'Session has no Tessera history yet');
      return buildEmptyHistoryResponse(id);
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const beforeBytesParam = searchParams.get('beforeBytes');
    const beforeBytes = beforeBytesParam != null
      ? parseInt(beforeBytesParam, 10)
      : undefined;

    if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
      return jsonError('invalid_params', 'Invalid limit (1-500)', 400);
    }
    if (beforeBytes !== undefined && (!Number.isFinite(beforeBytes) || beforeBytes < 0)) {
      return jsonError('invalid_params', 'Invalid beforeBytes cursor', 400);
    }

    const result = await sessionHistory.readSession(id, {
      limit,
      beforeBytes,
      lazyToolOutput: true,
    });

    logger.info({
      userId,
      sessionId: id,
      messageCount: result.messages.length,
      hasMore: result.hasMore,
      }, 'Session messages loaded (read-only, paginated)');

    return NextResponse.json({
      sessionId: id,
      messages: result.messages,
      pagination: {
        hasMore: result.hasMore,
        nextBeforeBytes: result.nextBeforeBytes,
      },
      ...(beforeBytes === undefined && result.usage ? { usage: result.usage } : {}),
      ...(beforeBytes === undefined && result.contextUsage ? { contextUsage: result.contextUsage } : {}),
      ...(beforeBytes === undefined ? { activeInteractivePrompt: result.activeInteractivePrompt } : {}),
    });
  } catch (err) {
    logger.error({
      error: (err as Error).message,
      sessionId: id,
      }, 'Failed to read messages');

    return jsonError('internal_error', 'Failed to read messages', 500);
  }
}
