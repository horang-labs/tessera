import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { resolveSessionWorkspaceFilesystemRoot } from '@/lib/session/session-workspace-root';
import { readWorkspaceRootFiles } from '@/lib/workspace-files/read-workspace-root';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { getProjectViewReferenceSessions } from '@/lib/projects/project-view-projection';
import { routeCanonicalWorktreePaths } from '@/lib/db/worktrees';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) {
    return auth.response;
  }

  const projectId = request.nextUrl.searchParams.get('projectId')?.trim();
  if (!projectId) {
    return NextResponse.json(
      { error: 'projectId is required for Project View references' },
      { status: 400 },
    );
  }
  const agentEnvironment = await getAgentEnvironment(auth.userId);
  await routeCanonicalWorktreePaths(agentEnvironment);
  const refs = getProjectViewReferenceSessions(projectId, id);

  const root = await resolveSessionWorkspaceFilesystemRoot(id, {
    agentEnvironment,
  });
  if (!root) {
    return NextResponse.json({
      files: [],
      symlinks: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'no-root',
      workDir: null,
    });
  }

  return NextResponse.json({
    ...await readWorkspaceRootFiles(root),
    chats: refs.chats,
    tasks: refs.tasks,
  });
}
