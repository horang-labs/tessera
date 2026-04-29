import { NextRequest, NextResponse } from 'next/server';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';

/**
 * POST /api/sessions/[id]/resume - Resume a session
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
    const body = await req.json().catch(() => ({}));
    const {
      workDir,
      permissionMode,
      model,
      reasoningEffort,
      sessionMode,
      accessMode,
      collaborationMode,
      approvalPolicy,
      sandboxMode,
    } = body;

    // Resolve CWD for the CLI process.
    // Priority: explicit workDir > DB work_dir > project.decoded_path > server CWD.
    // When a session is moved between projects, project_id changes but work_dir
    // stays the same. The CLI requires --resume to run from the original CWD.
    let resolvedWorkDir = workDir;
    if (!resolvedWorkDir) {
      const dbSession = dbSessions.getSession(sessionId);
      if (dbSession?.work_dir) {
        resolvedWorkDir = dbSession.work_dir;
      } else if (dbSession?.project_id) {
        resolvedWorkDir = dbProjects.getProject(dbSession.project_id)?.decoded_path;
      }
    }

    // Use orchestrator to resume session (handles metadata update)
    const result = await sessionOrchestrator.resumeSession(userId, sessionId, {
      workDir: resolvedWorkDir,
      permissionMode,
      model,
      reasoningEffort,
      sessionMode,
      accessMode,
      collaborationMode,
      approvalPolicy,
      sandboxMode,
    });

    logger.info({
      userId,
      sessionId: result.sessionId,
      messageCount: result.messages.length,
      }, 'Session resumed via API');

    return NextResponse.json(result);
  } catch (err: any) {
    if (err.message.includes('Session not found')) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    logger.error({
      sessionId,
      error: err,
      }, 'Failed to resume session');
    return NextResponse.json(
      {
        error: 'Failed to resume session',
        detail: (err as Error).message,
      },
      { status: 500 }
    );
  }
}
