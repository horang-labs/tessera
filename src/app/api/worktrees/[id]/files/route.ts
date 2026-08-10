import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktree } from '@/lib/db/worktrees';
import { readWorkspaceRootFiles } from '@/lib/workspace-files/read-workspace-root';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const worktree = getWorktree(id);
  if (!worktree) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
  }
  if (!worktree.filesystemPath) {
    return NextResponse.json({
      files: [],
      symlinks: [],
      truncated: false,
      reason: 'no-root',
      workDir: null,
    });
  }
  return NextResponse.json(await readWorkspaceRootFiles(worktree.filesystemPath));
}
