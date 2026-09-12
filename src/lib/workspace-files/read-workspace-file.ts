import { NextResponse } from 'next/server';
import { Buffer } from 'node:buffer';
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
import { inferWorkspaceFileContentType } from '@/lib/workspace-files/workspace-file-preview';

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

const VIDEO_STREAM_CHUNK_BYTES = 64 * 1024;

interface ByteRange {
  start: number;
  end: number;
}

/**
 * This route deliberately supports only a single byte range. Invalid or
 * multiple ranges are ignored and receive the complete 200 response; a valid
 * but unsatisfiable single range receives 416.
 */
function parseSingleByteRange(rangeHeader: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start: bigint;
  let end: bigint;
  try {
    if (match[1]) {
      start = BigInt(match[1]);
      end = match[2] ? BigInt(match[2]) : BigInt(size - 1);
    } else {
      const suffixLength = BigInt(match[2]);
      if (suffixLength === 0n || size === 0) return 'unsatisfiable';
      start = suffixLength >= BigInt(size) ? 0n : BigInt(size) - suffixLength;
      end = BigInt(size - 1);
    }
  } catch {
    return null;
  }

  if (start > end || start >= BigInt(size)) return 'unsatisfiable';
  const clampedEnd = end >= BigInt(size) ? BigInt(size - 1) : end;
  return { start: Number(start), end: Number(clampedEnd) };
}

function createWorkspaceFileStream(
  absolutePath: string,
  range: ByteRange,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let handle: fs.FileHandle | null = null;
  let position = range.start;
  let closed = false;
  let abortListener: (() => void) | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    const openHandle = handle;
    handle = null;
    if (openHandle) void openHandle.close().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      abortListener = () => {
        close();
        controller.error(new DOMException('The request was aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        abortListener();
        return;
      }
      signal?.addEventListener('abort', abortListener, { once: true });
      try {
        handle = await withFsDeadline(fs.open(absolutePath, 'r'));
        if (closed) return;
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    async pull(controller) {
      if (closed || !handle) return;
      if (position > range.end) {
        close();
        controller.close();
        return;
      }
      const length = Math.min(VIDEO_STREAM_CHUNK_BYTES, range.end - position + 1);
      const buffer = Buffer.allocUnsafe(length);
      try {
        const { bytesRead } = await withFsDeadline(handle.read(buffer, 0, length, position));
        if (bytesRead === 0) {
          close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
}

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

export async function readWorkspaceFileResponse({
  raw,
  rawPath,
  root,
  sourceId,
  rangeHeader,
  signal,
}: {
  raw: boolean;
  rawPath: string;
  root: string;
  sourceId: string;
  rangeHeader?: string | null;
  signal?: AbortSignal;
}): Promise<NextResponse> {
  const { absolutePath, relativePath } = await resolveRequestedFile(root, rawPath);
  const fileStat = await withFsDeadline(fs.stat(absolutePath));
  if (!fileStat.isFile()) {
    throw new WorkspaceFileError('invalid_file_path', 'Path is not a file', 400);
  }

  if (raw) {
    const contentType = inferWorkspaceFileContentType(relativePath);
    if (contentType === 'video/mp4') {
      if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
        throw new WorkspaceFileError('file_too_large', 'File is too large to preview', 413);
      }
      const requestedRange = parseSingleByteRange(rangeHeader ?? null, fileStat.size);
      const headers = new Headers({
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=30',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
      });
      if (requestedRange === 'unsatisfiable') {
        headers.set('Content-Range', `bytes */${fileStat.size}`);
        return new NextResponse(null, { status: 416, headers });
      }
      const range = requestedRange ?? { start: 0, end: fileStat.size - 1 };
      const contentLength = Math.max(0, range.end - range.start + 1);
      headers.set('Content-Length', String(contentLength));
      if (requestedRange) {
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`);
      }
      return new NextResponse(createWorkspaceFileStream(absolutePath, range, signal), {
        status: requestedRange ? 206 : 200,
        headers,
      });
    }
    if (fileStat.size > MAX_RAW_FILE_BYTES) {
      throw new WorkspaceFileError('file_too_large', 'File is too large to preview', 413);
    }
    const buffer = await withFsDeadline(fs.readFile(absolutePath));
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=30',
        'Content-Length': String(buffer.byteLength),
        'X-Content-Type-Options': 'nosniff',
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
    mimeType: inferWorkspaceFileContentType(relativePath),
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    truncated,
    binary,
  });
}
