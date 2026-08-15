import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktreeGitPanelData, GitPanelError } from '@/lib/git/git-panel';
import { scheduleGitRemoteRefresh } from '@/lib/git/git-remote-refresh';
import { refreshWorktreeGitStateInBackground } from '@/lib/git/session-diff-refresh';
import { syncWorktreePr } from '@/lib/github/worktree-pr-sync';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';

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
    const payload = await getWorktreeGitPanelData(id, auth.userId);
    void syncWorktreePr(id, {
      userId: auth.userId,
      branch: payload.detached ? null : payload.branch,
    });
    void scheduleGitRemoteRefresh({
      sessionId: `worktree:${id}`,
      workDir: payload.workDir,
      userId: auth.userId,
      onFetched: () => refreshWorktreeGitStateInBackground(
        id,
        payload.workDir,
        auth.userId,
        'remote_fetch',
      ),
    }).catch((error) => {
      logger.debug({ error, worktreeId: id }, 'Worktree remote refresh failed');
    });
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to load Worktree git panel data');
    return jsonError('internal_error', 'Failed to load Worktree git panel data', 500);
  }
}
