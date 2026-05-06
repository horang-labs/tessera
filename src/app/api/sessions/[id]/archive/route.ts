import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { archiveSession } from '@/lib/session/session-archive';
import { pruneExpiredArchivedWorktrees, restoreArchivedChat } from '@/lib/archive/archive-service';
import { SettingsManager } from '@/lib/settings/manager';

/**
 * PATCH /api/sessions/[id]/archive
 *
 * Updates the archive status for a session.
 * Persists to ~/.tessera/task-metadata.json.
 * Invalidates the project cache.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  const { id: sessionId } = await params;

  // Validate sessionId format (prevent path traversal — defense in depth)
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { archived } = body as { archived?: unknown };

  // Validate archived is a boolean
  if (typeof archived !== 'boolean') {
    return NextResponse.json(
      { error: 'archived must be a boolean' },
      { status: 400 }
    );
  }

  try {
    const result = archived
      ? await archiveSession(sessionId, true)
      : (await restoreArchivedChat(sessionId), { ok: true, worktreeRemoved: false });

    if (archived) {
      const settings = await SettingsManager.load(auth.userId);
      if (settings.autoDeleteArchivedWorktrees) {
        await pruneExpiredArchivedWorktrees(settings.archivedWorktreeRetentionDays, auth.userId);
      }
    }

    logger.info({ sessionId, archived }, 'Session archive status updated');

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update archive status';
    const status = message === 'Session not found' ? 404 : 400;
    logger.error({ sessionId, error: err }, 'Failed to update archive status');
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
