import { NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  getFilesystemPathModule,
  isAbsoluteFilesystemPath,
} from '@/lib/filesystem/host-path';
import {
  isInsideWorkspacePath,
  resolveWorkspaceReadTarget,
} from '@/lib/workspace-files/workspace-file-read-target';
import {
  isLikelyBinary as _isLikelyBinary,
  MAX_RAW_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  WorkspaceFileError,
  withFsDeadline,
} from '@/lib/workspace-files/workspace-file-io';

export { WorkspaceFileError };

async function resolveRequestedFile(root: string, rawPath: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (!rawPath.trim()) {
    throw new WorkspaceFileError('invalid_file_path', 'Missing file path', 400);
  }
  if (rawPath.includes('\0')) {
    throw new WorkspaceFileError('invalid_file_path', 'Invalid file path', 400);
  }

  const requestedPath = rawPath.replace(/\\/g, '/');
  if (isAbsoluteFilesystemPath(requestedPath)) {
    throw new WorkspaceFileError('invalid_file_path', 'File path must be relative', 400);
  }
  const pathModule = getFilesystemPathModule(root);

  let rootRealPath: string;
  try {
    rootRealPath = await withFsDeadline(fs.realpath(root));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError('missing_work_dir', 'Workspace directory is unavailable', 422);
  }

  const candidatePath = pathModule.resolve(rootRealPath, requestedPath);
  if (!isInsideWorkspacePath(rootRealPath, candidatePath, pathModule)) {
    throw new WorkspaceFileError('invalid_file_path', 'File path escapes the workspace', 400);
  }

  let absolutePath: string;
  try {
    absolutePath = await withFsDeadline(fs.realpath(candidatePath));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError('file_not_found', 'File not found', 404);
  }

  const candidateIsSymlink = await withFsDeadline(fs.lstat(candidatePath))
    .then((stats) => stats.isSymbolicLink())
    .catch(() => false);
  const target = resolveWorkspaceReadTarget({
    candidatePath,
    candidateIsSymlink,
    pathModule,
    rootRealPath,
    targetRealPath: absolutePath,
  });
  if (!target.allowed) {
    throw new WorkspaceFileError('invalid_file_path', 'File path escapes the workspace', 400);
  }

  return {
    absolutePath,
    relativePath: target.relativePath,
  };
}

const isLikelyBinary = _isLikelyBinary;

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  const aliases: Record<string, string> = {
    cjs: 'javascript', css: 'css', go: 'go', h: 'c', hpp: 'cpp', html: 'html',
    js: 'javascript', json: 'json', jsx: 'jsx', md: 'markdown', mjs: 'javascript',
    py: 'python', rs: 'rust', sh: 'bash', sql: 'sql', ts: 'typescript', tsx: 'tsx',
    txt: 'text', yaml: 'yaml', yml: 'yaml',
  };
  return aliases[ext] ?? ext ?? 'text';
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const aliases: Record<string, string> = {
    avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpeg: 'image/jpeg',
    jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
  };
  return aliases[ext] ?? 'application/octet-stream';
}

export async function readWorkspaceFileResponse({
  raw,
  rawPath,
  root,
  sourceId,
}: {
  raw: boolean;
  rawPath: string;
  root: string;
  sourceId: string;
}): Promise<NextResponse> {
  const { absolutePath, relativePath } = await resolveRequestedFile(root, rawPath);
  const fileStat = await withFsDeadline(fs.stat(absolutePath));
  if (!fileStat.isFile()) {
    throw new WorkspaceFileError('invalid_file_path', 'Path is not a file', 400);
  }

  if (raw) {
    if (fileStat.size > MAX_RAW_FILE_BYTES) {
      throw new WorkspaceFileError('file_too_large', 'File is too large to preview', 413);
    }
    const buffer = await withFsDeadline(fs.readFile(absolutePath));
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': inferContentType(relativePath),
        'Cache-Control': 'private, max-age=30',
        'Content-Length': String(buffer.byteLength),
      },
    });
  }

  const readLength = Math.min(fileStat.size, MAX_TEXT_FILE_BYTES + 1);
  const handle = await withFsDeadline(fs.open(absolutePath, 'r'));
  let buffer = Buffer.alloc(readLength);
  let bytesRead = 0;
  try {
    const result = await withFsDeadline(handle.read(buffer, 0, readLength, 0));
    bytesRead = result.bytesRead;
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    void handle.close().catch(() => {});
  }

  const binary = isLikelyBinary(buffer);
  const truncated = fileStat.size > MAX_TEXT_FILE_BYTES || bytesRead > MAX_TEXT_FILE_BYTES;
  const contentBuffer = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_FILE_BYTES));
  return NextResponse.json({
    sessionId: sourceId,
    workDir: root,
    path: relativePath,
    content: binary ? '' : contentBuffer.toString('utf8'),
    language: inferLanguage(relativePath),
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    truncated,
    binary,
  });
}
