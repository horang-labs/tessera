import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { WorkspaceFileError } from './workspace-file-io';
import { getWorkspaceTrashSupport } from './workspace-file-trash';
import {
  transferWorkspaceEntries,
  uploadWorkspaceFiles,
  type WorkspaceUploadItem,
} from './workspace-file-transfer';

function errorResponse(error: unknown, action: string): NextResponse {
  if (error instanceof WorkspaceFileError) {
    return jsonError(error.code, error.message, error.status);
  }
  logger.error({ error }, `Failed to ${action} workspace entries`);
  return jsonError('internal_error', `Failed to ${action} workspace entries`, 500);
}

export async function handleWorkspaceTransfer(root: string, request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null) ?? {}) as {
      operation?: unknown;
      sources?: unknown;
      destination?: unknown;
    };
    if (body.operation !== 'move' && body.operation !== 'copy') {
      throw new WorkspaceFileError('invalid_request', 'Unknown operation', 400);
    }
    if (!Array.isArray(body.sources) || body.sources.some((source) => typeof source !== 'string')) {
      throw new WorkspaceFileError('invalid_file_path', 'Missing file path', 400);
    }
    if (typeof body.destination !== 'string') {
      throw new WorkspaceFileError('invalid_file_path', 'Missing destination', 400);
    }
    const result = await transferWorkspaceEntries(root, {
      operation: body.operation,
      sources: body.sources as string[],
      destination: body.destination,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 'transfer');
  }
}

export async function handleWorkspaceUpload(root: string, request: Request): Promise<NextResponse> {
  try {
    const form = await request.formData().catch(() => null);
    if (!form) throw new WorkspaceFileError('invalid_request', 'Expected form data', 400);
    const destination = form.get('destination');
    if (typeof destination !== 'string') {
      throw new WorkspaceFileError('invalid_file_path', 'Missing destination', 400);
    }
    const files = form.getAll('files').filter((entry): entry is File => typeof entry !== 'string');
    const paths = form.getAll('paths');
    const items: WorkspaceUploadItem[] = [];
    for (const [index, file] of files.entries()) {
      const relative = paths[index];
      items.push({
        relativePath: typeof relative === 'string' && relative ? relative : file.name,
        data: Buffer.from(await file.arrayBuffer()),
      });
    }
    if (items.length === 0) throw new WorkspaceFileError('invalid_request', 'Nothing to upload', 400);
    return NextResponse.json(await uploadWorkspaceFiles(root, { destination, items }));
  } catch (error) {
    return errorResponse(error, 'upload');
  }
}

export async function handleWorkspaceTrashSupport(root: string): Promise<NextResponse> {
  return NextResponse.json(await getWorkspaceTrashSupport(root));
}
