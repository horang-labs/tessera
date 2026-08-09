import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktreeGitPanelData, GitPanelError } from '@/lib/git/git-panel';
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
    return NextResponse.json(await getWorktreeGitPanelData(id, auth.userId));
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to load Worktree git panel data');
    return jsonError('internal_error', 'Failed to load Worktree git panel data', 500);
  }
}
