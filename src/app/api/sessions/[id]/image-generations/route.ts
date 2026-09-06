import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import { ensureTraceInputAgentPaths, readSessionImageGenerationTraces } from '@/lib/image-generation/session-traces';
import { toPublicImageGenerationTraces } from '@/lib/image-generation/traces';
import logger from '@/lib/logger';
import { syncTerminalImageIndex } from '@/lib/image-generation/terminal-image-index';
import { supportsTerminalTranscriptHistory } from '@/lib/session/terminal-session-history';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) return auth.response;
    const session = dbSessions.getSession(id);
    if (!session) return jsonError('not_found', 'Session not found', 404);
    const indexed = session.provider === 'codex' && supportsTerminalTranscriptHistory(session);
    const sync = indexed && request.nextUrl.searchParams.get('sync') === '1'
      ? await syncTerminalImageIndex(session, auth.userId, request.signal) : { more: false };
    const traces = await readSessionImageGenerationTraces(session, auth.userId);
    await ensureTraceInputAgentPaths(traces, auth.userId);
    return NextResponse.json({ traces: toPublicImageGenerationTraces(id, traces), more: sync.more });
  } catch (error) {
    logger.error({ error, sessionId: id }, 'Failed to read image generation traces');
    return jsonError('internal_error', 'Failed to read image generation traces', 500);
  }
}
