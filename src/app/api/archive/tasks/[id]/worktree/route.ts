import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { removeArchivedTaskWorktree } from '@/lib/archive/archive-service';
import logger from '@/lib/logger';
import { isTerminalHandoffConflictError } from '@/lib/terminal/terminal-handoff-lock';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    await removeArchivedTaskWorktree(id, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete worktree';
    const handoffConflict = isTerminalHandoffConflictError(error);
    logger.warn({ taskId: id, error: message }, 'Failed to delete archived task worktree');
    return NextResponse.json(
      {
        error: message,
        ...(handoffConflict ? { code: error.code } : {}),
      },
      { status: handoffConflict ? 409 : 400 },
    );
  }
}
