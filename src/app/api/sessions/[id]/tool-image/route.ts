import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { resolvePathForHostFilesystem } from '@/lib/filesystem/host-path';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import * as dbSessions from '@/lib/db/sessions';
import { sessionHistory } from '@/lib/session-history';
import {
  readTerminalToolCallParams,
  supportsTerminalTranscriptHistory,
} from '@/lib/session/terminal-session-history';
import { inferImageMime, isImagePath } from '@/lib/tool-results/tool-image';

// Codex screenshots / large reads can be a few MB; cap to avoid serving huge files.
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Serves the image bytes for an image-producing tool call (Codex `view_image`,
 * Claude Code image `Read`). The on-disk path is re-derived server-side from the
 * session's recorded tool call by `toolUseId`, so no client-supplied filesystem
 * path is trusted. Only image files are served.
 */
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

    const toolUseId = request.nextUrl.searchParams.get('toolUseId');
    if (!toolUseId || !toolUseId.trim()) {
      return jsonError('invalid_params', 'toolUseId is required', 400);
    }

    const session = dbSessions.getSession(id);
    if (!session) {
      return jsonError('not_found', 'Session not found', 404);
    }

    // A PTY session's conversation never reaches Tessera's own history, so its
    // tool calls only exist in the provider transcript the chat view decodes.
    const toolParams = supportsTerminalTranscriptHistory(session)
      ? await readTerminalToolCallParams(session, toolUseId, auth.userId)
      : await sessionHistory.readToolCallParams(id, toolUseId);
    if (!toolParams) {
      return jsonError('not_found', 'Tool call not found', 404);
    }

    // `path` for Codex view_image, `file_path` for Claude Code Read.
    const rawPath = typeof toolParams.path === 'string'
      ? toolParams.path
      : typeof toolParams.file_path === 'string'
        ? toolParams.file_path
        : '';

    if (!rawPath.trim() || rawPath.includes('\0')) {
      return jsonError('invalid_file_path', 'Tool call has no image path', 422);
    }
    if (!isImagePath(rawPath)) {
      return jsonError('unsupported_media', 'Tool call path is not an image', 415);
    }

    // The recorded path is the one the CLI saw, which is not always readable by
    // this process: a Windows-hosted server driving a WSL agent records
    // `/home/...` and `/mnt/c/...`, neither of which `fs` can open. Re-resolve
    // against the host filesystem (`\\wsl.localhost\<distro>\...`, `C:\...`)
    // before touching disk.
    const hostPath = await resolvePathForHostFilesystem(rawPath);

    let stat;
    try {
      stat = await fs.stat(hostPath);
    } catch {
      return jsonError('file_not_found', 'Image file not found', 404);
    }
    if (!stat.isFile()) {
      return jsonError('invalid_file_path', 'Path is not a file', 400);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return jsonError('file_too_large', 'Image is too large to preview', 413);
    }

    const buffer = await fs.readFile(hostPath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': inferImageMime(rawPath) ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=30',
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    logger.error({ error, sessionId: id }, 'Failed to serve tool image');
    return jsonError('internal_error', 'Failed to serve tool image', 500);
  }
}
