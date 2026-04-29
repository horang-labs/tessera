import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { sessionHistory } from '@/lib/session-history';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const { searchParams } = new URL(request.url);
    const toolUseId = searchParams.get('toolUseId');

    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;

    if (!toolUseId || toolUseId.trim().length === 0) {
      return jsonError('invalid_params', 'toolUseId is required', 400);
    }

    const dbSession = dbSessions.getSession(id);
    if (!dbSession) {
      return jsonError('not_found', 'Session not found', 404);
    }

    const result = await sessionHistory.readToolOutput(id, toolUseId);

    if (!result) {
      return jsonError('not_found', 'Tool output not found', 404);
    }

    logger.info({
      userId,
      sessionId: id,
      toolUseId,
      outputSize: result.output.length,
      }, 'Tool output fetched');

    return NextResponse.json({
      toolUseId,
      output: result.output,
      toolUseResult: result.toolUseResult,
      isError: result.isError,
    });
  } catch (err) {
    logger.error({
      error: err,
      sessionId: id,
      }, 'Failed to read tool output');

    return jsonError('internal_error', 'Failed to read tool output', 500);
  }
}
