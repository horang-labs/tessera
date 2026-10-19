import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { jsonError } from '@/lib/http/json-error';
import { resolveSessionWorkspaceFilesystemRoot } from '@/lib/session/session-workspace-root';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { handleWorkspaceUpload } from '@/lib/workspace-files/workspace-transfer-handlers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;
  const root = await resolveSessionWorkspaceFilesystemRoot(id, {
    agentEnvironment: await getAgentEnvironment(auth.userId),
  });
  if (!root) return jsonError('missing_work_dir', 'Session has no working directory', 422);
  return handleWorkspaceUpload(root, request);
}
