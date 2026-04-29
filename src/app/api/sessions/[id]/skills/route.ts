import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { processManager } from '@/lib/cli/process-manager';

/**
 * GET /api/sessions/[id]/skills
 *
 * Returns the list of skills available for the given session's CLI provider.
 * Skills are discovered via the SkillSource attached to the active process.
 * If the session has no active process or the provider does not support skill
 * discovery, returns an empty skills array.
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
      return NextResponse.json({ skills: [] });
    }

    const skills = await skillSource.listSkills();
    return NextResponse.json({ skills });
  } catch {
    return NextResponse.json({ skills: [] });
  }
}
