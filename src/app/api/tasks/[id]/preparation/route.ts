import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getTaskPreparation } from '@/lib/db/task-preparation';
import logger from '@/lib/logger';
import { rerunWorktreePreparation } from '@/lib/projects/worktree-preparation';

/**
 * GET /api/tasks/[id]/preparation
 *
 * The task's preparation status and, once a run has ended, what it printed.
 * The output is fetched separately from the task itself because it is only
 * read when someone opens it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const preparation = getTaskPreparation(id);
  if (!preparation) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
  return NextResponse.json({ preparation });
}

/**
 * POST /api/tasks/[id]/preparation
 *
 * Run preparation again on the worktree the task already has, which is how a
 * failure is cleared once the script has been fixed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;
  const { userId } = auth;

  const { id } = await params;

  try {
    const outcome = await rerunWorktreePreparation(userId, id);
    if (!outcome.started) {
      const status = outcome.reason === 'already_running' ? 409 : 422;
      return NextResponse.json({ error: outcome.reason, ...outcome }, { status });
    }

    // The start itself announces the new status to every window, including the
    // one that asked, so nothing more is broadcast here.
    return NextResponse.json({ preparation: getTaskPreparation(id) });
  } catch (error) {
    logger.error({ error, taskId: id }, 'Preparation re-run failed to start');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Preparation could not be started' },
      { status: 500 },
    );
  }
}
