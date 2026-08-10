import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { resolveSessionWorkspaceFilesystemRoot } from '@/lib/session/session-workspace-root';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
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

    const root = await resolveSessionWorkspaceFilesystemRoot(id, {
      agentEnvironment: await getAgentEnvironment(auth.userId),
    });
    if (!root) {
      return jsonError('missing_work_dir', 'Session has no working directory', 422);
    }

    return await readWorkspaceFileResponse({
      raw: request.nextUrl.searchParams.get('raw') === '1',
      rawPath: request.nextUrl.searchParams.get('path') ?? '',
      root,
      sourceId: id,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, sessionId: id }, 'Failed to load workspace file');
    return jsonError('internal_error', 'Failed to load workspace file', 500);
  }
}
