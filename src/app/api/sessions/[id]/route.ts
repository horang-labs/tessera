import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { processManager } from '@/lib/cli/process-manager';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import { getTaskBySessionId } from '@/lib/db/tasks';
import { getSession, mapSessionRowToApi } from '@/lib/db/sessions';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import { toLinkedWorktreeSession } from '@/lib/worktrees/linked-worktree-presentation';
import type { UnifiedSession } from '@/types/chat';
import logger from '@/lib/logger';
import {
  isSessionOperationConflictError,
  isTerminalHandoffConflictError,
} from '@/lib/terminal/terminal-handoff-lock';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';

function isValidSessionId(sessionId: string): boolean {
  return Boolean(sessionId) && !sessionId.includes('..') && !sessionId.includes('/');
}

/** GET /api/sessions/[id] — load one complete navigable Session appearance. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const { id: sessionId } = await context.params;
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json(
      { error: 'Invalid session ID', code: 'INVALID_SESSION_ID' },
      { status: 400 },
    );
  }

  const row = getSession(sessionId);
  if (!row || row.deleted) {
    return NextResponse.json(
      { error: 'Session not found', code: 'SESSION_NOT_FOUND' },
      { status: 404 },
    );
  }

  const activeSessionIds = getActiveSessionIds(auth.userId);
  const generatingSessionIds = processManager.getGeneratingSessionIds();
  const runtimeConfig = processManager.getSessionRuntimeConfigs().get(sessionId) ?? {};
  const canonical = {
    ...mapSessionRowToApi(row, activeSessionIds, generatingSessionIds),
    ...runtimeConfig,
  } as UnifiedSession;
  const task = getTaskBySessionId(sessionId, activeSessionIds);
  const taskSession = task?.sessions.find((session) => session.id === sessionId);
  const session = task && taskSession
    ? toLinkedWorktreeSession(task, taskSession, canonical)
    : canonical;

  return NextResponse.json({ session });
}

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
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json(
      { error: 'Invalid session ID', code: 'INVALID_SESSION_ID' },
      { status: 400 }
    );
  }

  try {
    const sessionRow = getSession(sessionId);
    const projectId = sessionRow?.project_id;

    terminalManager.preventSessionOpen(sessionId, userId);
    await terminalManager.closeSession(sessionId, userId);
    await sessionOrchestrator.deleteSession(userId, sessionId);

    logger.info({ userId, sessionId }, 'Session deleted via API');

    broadcastSessionMutation(userId, {
      kind: 'deleted',
      projectId,
      originClientId: getOriginClientIdFromRequest(request),
    });

    terminalManager.allowSessionOpen(sessionId, userId);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    terminalManager.allowSessionOpen(sessionId, userId);
    logger.error({
      userId,
      sessionId,
      error: err,
      }, 'Delete session API error');

    if (isTerminalHandoffConflictError(err) || isSessionOperationConflictError(err)) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }

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
