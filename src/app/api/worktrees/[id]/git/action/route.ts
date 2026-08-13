import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { GitActionRejection } from '@/lib/git/git-actions';
import {
  describeGitActionRejection,
  parseGitActionBody,
} from '@/lib/git/git-action-request';
import { GitPanelError } from '@/lib/git/git-panel';
import { runWorktreeGitAction } from '@/lib/git/session-git-action';
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

    const parsed = parseGitActionBody(await request.json().catch(() => null));
    if ('message' in parsed) {
      return jsonError('invalid_request', parsed.message, 400);
    }
    return NextResponse.json(
      await runWorktreeGitAction(id, auth.userId, parsed.action),
    );
  } catch (error) {
    if (error instanceof GitActionRejection) {
      const { code, status } = describeGitActionRejection(error.code);
      return jsonError(code, error.message, status);
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to run Worktree git action');
    return jsonError('internal_error', 'Failed to run git action', 500);
  }
}
