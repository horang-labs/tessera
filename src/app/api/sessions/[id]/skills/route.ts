import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { processManager } from '@/lib/cli/process-manager';
import logger from '@/lib/logger';

/**
 * GET /api/sessions/[id]/skills
 *
 * Returns the list of skills available for the given session's CLI provider.
 * Skills are discovered via the SkillSource attached to the active process.
 * A missing/unavailable live skill source is retryable and must not be
 * represented as a valid empty skill list.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) {
      return auth.response;
    }

    const session = dbSessions.getSession(id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const processInfo = processManager.getProcess(id);
    const skillSource = processInfo?.skillSource;

    if (!skillSource) {
      return NextResponse.json(
        { error: 'Skill discovery is not ready', retryable: true },
        { status: 503 },
      );
    }

    try {
      const skills = await skillSource.listSkills();
      return NextResponse.json({ skills });
    } catch (error) {
      logger.warn({
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      }, 'Session skill discovery failed');
      return NextResponse.json(
        { error: 'Skill discovery temporarily failed', retryable: true },
        { status: 503 },
      );
    }
  } catch (error) {
    logger.error({
      sessionId: id,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to serve session skills');
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 });
  }
}
