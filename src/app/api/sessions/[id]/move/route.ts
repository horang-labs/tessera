import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import * as dbProjects from '@/lib/db/projects';
import { processManager } from '@/lib/cli/process-manager';
import logger from '@/lib/logger';

/**
 * PATCH /api/sessions/[id]/move
 *
 * Moves a session to a different project (logical move — DB only).
 * Only project_id is updated.
 * Running sessions cannot be moved.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  const { id: sessionId } = await params;

  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { targetProjectId } = body as { targetProjectId?: unknown };

  if (!targetProjectId || typeof targetProjectId !== 'string') {
    return NextResponse.json(
      { error: 'Must provide targetProjectId (absolute path)' },
      { status: 400 }
    );
  }

  // Verify session exists
  const session = dbSessions.getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Block move for running sessions
  const activeIds = processManager.getActiveSessionIds();
  if (activeIds.has(sessionId)) {
    return NextResponse.json(
      { error: 'Cannot move a running session. Stop it first.' },
      { status: 409 }
    );
  }

  // No-op if already in target project
  if (session.project_id === targetProjectId) {
    return NextResponse.json({ ok: true, noop: true });
  }

  // Verify target project is registered
  const targetProject = dbProjects.getProject(targetProjectId);
  if (!targetProject || targetProject.visible === 0) {
    return NextResponse.json(
      { error: 'Target project not found or not visible' },
      { status: 404 }
    );
  }

  try {
    // Backfill work_dir for legacy sessions created before migration v6.
    // work_dir preserves the original CWD so CLI --resume works after move.
    // For legacy sessions, project_id == original CWD (decoded_path).
    if (!session.work_dir) {
      dbSessions.updateSession(sessionId, {
        work_dir: session.project_id,
        project_id: targetProjectId,
        collection_id: null,
      });
    } else {
      dbSessions.updateSession(sessionId, { project_id: targetProjectId, collection_id: null });
    }

    logger.info('Session moved to project', {
      sessionId,
      from: session.project_id,
      to: targetProjectId,
    });

    return NextResponse.json({
      ok: true,
      from: session.project_id,
      to: targetProjectId,
    });
  } catch (err: any) {
    logger.error('Failed to move session', { sessionId, error: err });
    return NextResponse.json(
      { error: 'Failed to move session' },
      { status: 500 }
    );
  }
}
