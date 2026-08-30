import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { resolveWorktreeGitTarget, GitPanelError } from '@/lib/git/git-panel';
import { refreshWorktreeGitStateInBackground } from '@/lib/git/session-diff-refresh';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) return auth.response;
    const target = await resolveWorktreeGitTarget(id, auth.userId);
    refreshWorktreeGitStateInBackground(
      id,
      target.workDir,
      auth.userId,
      'client_refresh_request',
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to refresh Worktree git state');
    return jsonError('internal_error', 'Failed to refresh git state', 500);
  }
}
