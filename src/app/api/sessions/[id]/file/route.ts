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
import {
  createWorkspaceFile,
  saveWorkspaceFile,
} from '@/lib/workspace-files/workspace-file-write';
import {
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
} from '@/lib/workspace-files/workspace-file-mutations';

function toErrorResponse(error: unknown, sessionId: string, action: string): NextResponse {
  if (error instanceof WorkspaceFileError) {
    logger.error(
      { error, sessionId, code: error.code, status: error.status },
      `Failed to ${action} workspace file`,
    );
    return jsonError(error.code, error.message, error.status);
  }
  logger.error({ error, sessionId }, `Failed to ${action} workspace file`);
  return jsonError('internal_error', `Failed to ${action} workspace file`, 500);
}

interface WorkspaceWriteBody {
  path?: unknown;
  content?: unknown;
  baseMtimeMs?: unknown;
}

function parseWriteBody(body: unknown, options: { contentOptional?: boolean } = {}): {
  path: string;
  content: string;
  baseMtimeMs: number | null;
} {
  const { path: rawPath, content, baseMtimeMs } = (body ?? {}) as WorkspaceWriteBody;
  if (typeof rawPath !== 'string') {
    throw new WorkspaceFileError('invalid_file_path', 'Missing file path', 400);
  }
  if (typeof content !== 'string' && !(options.contentOptional && content === undefined)) {
    throw new WorkspaceFileError('invalid_request', 'Expected file content', 400);
  }
  return {
    path: rawPath,
    content: typeof content === 'string' ? content : '',
    baseMtimeMs:
      typeof baseMtimeMs === 'number' && Number.isFinite(baseMtimeMs) ? baseMtimeMs : null,
  };
}

async function authenticateAndResolveRoot(
  request: NextRequest,
  sessionId: string,
): Promise<{ root: string; userId: string } | { response: NextResponse }> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return { response: auth.response };

  const root = await resolveSessionWorkspaceFilesystemRoot(sessionId, {
    agentEnvironment: await getAgentEnvironment(auth.userId),
  });
  if (!root) {
    return { response: jsonError('missing_work_dir', 'Session has no working directory', 422) };
  }
  return { root, userId: auth.userId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ('response' in resolved) return resolved.response;

    return await readWorkspaceFileResponse({
      raw: request.nextUrl.searchParams.get('raw') === '1',
      rawPath: request.nextUrl.searchParams.get('path') ?? '',
      root: resolved.root,
      sourceId: id,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'load');
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ('response' in resolved) return resolved.response;
    const body = parseWriteBody(await request.json().catch(() => null));

    const saved = await saveWorkspaceFile(resolved.root, {
      baseMtimeMs: body.baseMtimeMs,
      content: body.content,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: saved.relativePath,
      size: saved.size,
      mtimeMs: saved.mtimeMs,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'save');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ('response' in resolved) return resolved.response;
    const body = parseWriteBody(await request.json().catch(() => null), { contentOptional: true });

    const created = await createWorkspaceFile(resolved.root, {
      content: body.content,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: created.relativePath,
      size: created.size,
      mtimeMs: created.mtimeMs,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'create');
  }
}

function parseOptionalMtime(rawValue: string | null): number | null {
  if (rawValue === null) return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ('response' in resolved) return resolved.response;

    const searchParams = request.nextUrl.searchParams;
    const deleted = await deleteWorkspaceEntry(resolved.root, {
      baseMtimeMs: parseOptionalMtime(searchParams.get('baseMtimeMs')),
      path: searchParams.get('path') ?? '',
      recursive: searchParams.get('recursive') === '1',
    });

    return NextResponse.json({
      sessionId: id,
      path: deleted.relativePath,
      kind: deleted.kind,
      deleted: true,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'delete');
  }
}

interface WorkspaceRenameBody {
  path?: unknown;
  newName?: unknown;
  baseMtimeMs?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ('response' in resolved) return resolved.response;

    const body = (await request.json().catch(() => null) ?? {}) as WorkspaceRenameBody;
    if (typeof body.path !== 'string') {
      throw new WorkspaceFileError('invalid_file_path', 'Missing file path', 400);
    }
    if (typeof body.newName !== 'string') {
      throw new WorkspaceFileError('invalid_file_name', 'Enter a name', 400);
    }

    const renamed = await renameWorkspaceEntry(resolved.root, {
      baseMtimeMs:
        typeof body.baseMtimeMs === 'number' && Number.isFinite(body.baseMtimeMs)
          ? body.baseMtimeMs
          : null,
      newName: body.newName,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: renamed.relativePath,
      previousPath: renamed.previousPath,
      kind: renamed.kind,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'rename');
  }
}
