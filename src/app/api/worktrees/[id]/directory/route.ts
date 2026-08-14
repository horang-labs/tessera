import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktree } from '@/lib/db/worktrees';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { createWorkspaceDirectory } from '@/lib/workspace-files/workspace-file-mutations';
import { WorkspaceFileError } from '@/lib/workspace-files/workspace-file-io';

interface WorkspaceDirectoryBody {
  path?: unknown;
}

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

    const worktree = getWorktree(id);
    if (!worktree) return jsonError('worktree_not_found', 'Worktree not found', 404);
    if (!worktree.filesystemPath) {
      return jsonError('missing_work_dir', 'Worktree has no working directory', 422);
    }

    const body = (await request.json().catch(() => null) ?? {}) as WorkspaceDirectoryBody;
    if (typeof body.path !== 'string') {
      throw new WorkspaceFileError('invalid_file_path', 'Missing folder path', 400);
    }
    const created = await createWorkspaceDirectory(worktree.filesystemPath, { path: body.path });
    return NextResponse.json({
      worktreeId: id,
      path: created.relativePath,
      created: true,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, worktreeId: id }, 'Failed to create Worktree folder');
    return jsonError('internal_error', 'Failed to create Worktree folder', 500);
  }
}
