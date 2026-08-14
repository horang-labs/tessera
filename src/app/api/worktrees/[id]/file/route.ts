import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getWorktree } from '@/lib/db/worktrees';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
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
  const { path, content, baseMtimeMs } = (body ?? {}) as WorkspaceWriteBody;
  if (typeof path !== 'string') {
    throw new WorkspaceFileError('invalid_file_path', 'Missing file path', 400);
  }
  if (typeof content !== 'string' && !(options.contentOptional && content === undefined)) {
    throw new WorkspaceFileError('invalid_request', 'Expected file content', 400);
  }
  return {
    path,
    content: typeof content === 'string' ? content : '',
    baseMtimeMs:
      typeof baseMtimeMs === 'number' && Number.isFinite(baseMtimeMs) ? baseMtimeMs : null,
  };
}

async function authenticateAndResolveRoot(
  request: NextRequest,
  worktreeId: string,
): Promise<{ root: string } | { response: NextResponse }> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return { response: auth.response };

  const worktree = getWorktree(worktreeId);
  if (!worktree) {
    return { response: jsonError('worktree_not_found', 'Worktree not found', 404) };
  }
  if (!worktree.filesystemPath) {
    return {
      response: jsonError('missing_work_dir', 'Worktree has no working directory', 422),
    };
  }
  return { root: worktree.filesystemPath };
}

function toErrorResponse(error: unknown, worktreeId: string, action: string): NextResponse {
  if (error instanceof WorkspaceFileError) {
    return jsonError(error.code, error.message, error.status);
  }
  logger.error({ error, worktreeId }, `Failed to ${action} Worktree file`);
  return jsonError('internal_error', `Failed to ${action} Worktree file`, 500);
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
      worktreeId: id,
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
      worktreeId: id,
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
      worktreeId: id,
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
      worktreeId: id,
      path: renamed.relativePath,
      previousPath: renamed.previousPath,
      kind: renamed.kind,
    });
  } catch (error) {
    return toErrorResponse(error, id, 'rename');
  }
}
