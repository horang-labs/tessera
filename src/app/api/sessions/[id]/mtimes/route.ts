import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { resolveSessionWorkspaceFilesystemRoot } from '@/lib/session/session-workspace-root';
import { readWorkspaceDirectoryMtimes } from '@/lib/workspace-files/read-workspace-root';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const root = await resolveSessionWorkspaceFilesystemRoot(id, {
    agentEnvironment: await getAgentEnvironment(auth.userId),
  });
  if (!root) return NextResponse.json({ mtimes: {} });
  const directory = request.nextUrl.searchParams.get('directory') ?? '';
  return NextResponse.json({
    directory,
    mtimes: await readWorkspaceDirectoryMtimes(root, directory),
  });
}
