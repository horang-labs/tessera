import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { exportSessionLog, type SessionExportOptions } from '@/lib/session-export';

async function readExportOptions(request: NextRequest): Promise<SessionExportOptions> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return {};
  }

  if (!body || typeof body !== 'object') {
    return {};
  }

  const record = body as Record<string, unknown>;
  const options: SessionExportOptions = {};

  if (typeof record.untilMessageId === 'string' && record.untilMessageId.trim()) {
    options.untilMessageId = record.untilMessageId.trim();
  }

  if (Number.isInteger(record.untilMessageIndex)) {
    options.untilMessageIndex = record.untilMessageIndex as number;
  }

  return options;
}

/**
 * POST /api/sessions/[id]/export
 *
 * Exports a session's conversation log as a markdown file for
 * session reference (drag-and-drop context injection). When
 * `untilMessageId` or `untilMessageIndex` is provided, exports only the
 * conversation up to that message for fork/branch-from-here flows.
 *
 * Returns: { exportPath: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: sessionId } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) {
      return auth.response;
    }

    // Validate session ID format
    if (sessionId.includes('..') || sessionId.includes('/')) {
      return jsonError('invalid_params', 'Invalid session ID', 400);
    }

    // Look up session metadata from DB
    const dbSession = dbSessions.getSession(sessionId);
    if (!dbSession) {
      return jsonError('not_found', 'Session not found', 404);
    }

    const exportOptions = await readExportOptions(request);
    const exportPath = await exportSessionLog(sessionId, dbSession.title, exportOptions);

    logger.info({
      userId: auth.userId,
      sessionId,
      exportPath,
      partial: Boolean(exportOptions.untilMessageId) || exportOptions.untilMessageIndex !== undefined,
    }, 'Session export requested');

    return NextResponse.json({ exportPath });
  } catch (err) {
    const message = (err as Error).message;

    if (message === 'No conversation log found') {
      return jsonError('not_found', 'No conversation data for this session', 404);
    }

    if (message === 'Invalid session ID format') {
      return jsonError('invalid_params', message, 400);
    }

    if (message === 'Message cutoff not found') {
      return jsonError('invalid_params', message, 400);
    }

    logger.error({
      error: message,
      sessionId,
    }, 'Failed to export session');

    return jsonError('internal_error', 'Failed to export session', 500);
  }
}
