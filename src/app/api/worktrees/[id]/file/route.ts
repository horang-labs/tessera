import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktree } from '@/lib/db/worktrees';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import {
  readWorkspaceFileResponse,
  WorkspaceFileError,
} from '@/lib/workspace-files/read-workspace-file';

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

    const worktree = getWorktree(id);
    if (!worktree) return jsonError('worktree_not_found', 'Worktree not found', 404);
    if (!worktree.filesystemPath) {
      return jsonError('missing_work_dir', 'Worktree has no working directory', 422);
    }

    return await readWorkspaceFileResponse({
      raw: request.nextUrl.searchParams.get('raw') === '1',
      rawPath: request.nextUrl.searchParams.get('path') ?? '',
      root: worktree.filesystemPath,
      sourceId: id,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to load Worktree file');
    return jsonError('internal_error', 'Failed to load Worktree file', 500);
  }
}
