import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktree } from '@/lib/db/worktrees';
import { jsonError } from '@/lib/http/json-error';
import { handleWorkspaceTrashSupport } from '@/lib/workspace-files/workspace-transfer-handlers';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;
  const worktree = getWorktree(id);
  if (!worktree) return jsonError('worktree_not_found', 'Worktree not found', 404);
  if (!worktree.filesystemPath) {
    return jsonError('missing_work_dir', 'Worktree has no working directory', 422);
  }
  return handleWorkspaceTrashSupport(worktree.filesystemPath);
}
