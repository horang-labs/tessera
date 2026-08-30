import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { CommitMessageGenerationError } from '@/lib/git/commit-message-generator';
import { GitActionRejection } from '@/lib/git/git-actions';
import {
  generateConfiguredCommitMessage,
  parseSelectedFiles,
} from '@/lib/git/git-commit-message-service';
import { GitPanelError, resolveWorktreeGitTarget } from '@/lib/git/git-panel';
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
    const files = parseSelectedFiles(await request.json().catch(() => null));
    if ('message' in files) return jsonError('invalid_request', files.message, 400);

    const target = await resolveWorktreeGitTarget(id, auth.userId);
    const message = await generateConfiguredCommitMessage(
      target,
      auth.userId,
      files.files,
    );
    return NextResponse.json({ message });
  } catch (error) {
    if (error instanceof GitActionRejection) {
      const invalidPath = error.code === 'file_not_in_change_set';
      return jsonError(
        invalidPath ? 'invalid_file_path' : 'invalid_request',
        error.message,
        invalidPath ? 404 : 400,
      );
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    if (error instanceof CommitMessageGenerationError) {
      logger.warn({ error, worktreeId: id }, 'Worktree commit message generation failed');
      return jsonError('generation_failed', error.message, 502);
    }
    logger.error({ error, worktreeId: id }, 'Failed to generate Worktree commit message');
    return jsonError('internal_error', 'Failed to generate a commit message', 500);
  }
}
