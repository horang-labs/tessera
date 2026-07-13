import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { forkCodexSession, SessionForkError } from '@/lib/session/session-fork';
import {
  isSessionOperationConflictError,
  isTerminalHandoffConflictError,
} from '@/lib/terminal/terminal-handoff-lock';
import {
  broadcastSessionMutation,
  getOriginClientIdFromRequest,
} from '@/lib/ws/mutation-broadcast';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const { id: sessionId } = await params;
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json({ error: 'Invalid session ID', code: 'invalid_session_id' }, { status: 400 });
  }

  try {
    const result = await forkCodexSession(auth.userId, sessionId);
    broadcastSessionMutation(auth.userId, {
      kind: 'created',
      projectId: result.projectDir,
      originClientId: getOriginClientIdFromRequest(request),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fork Codex session';
    const code = error instanceof SessionForkError
      ? error.code
      : isTerminalHandoffConflictError(error) || isSessionOperationConflictError(error)
        ? error.code
        : 'fork_failed';
    const status = code === 'session_not_found'
      ? 404
      : code === 'session_limit_reached'
        ? 429
        : (
            code === 'session_busy'
            || code === 'session_handed_off_to_terminal'
            || code === 'interactive_prompt_pending'
          )
          ? 409
          : code === 'fork_failed'
            ? 500
            : 400;
    logger.error({ sessionId, error }, 'Failed to fork Codex session');
    return NextResponse.json({ error: message, code }, { status });
  }
}
