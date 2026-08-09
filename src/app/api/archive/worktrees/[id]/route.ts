import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { removeArchivedWorktreeById } from '@/lib/archive/archive-service';
import logger from '@/lib/logger';
import { isTerminalHandoffConflictError } from '@/lib/terminal/terminal-handoff-lock';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id.startsWith('wt_') || id.includes('/') || id.includes('..')) {
    return NextResponse.json({ error: 'Invalid Worktree ID' }, { status: 400 });
  }

  try {
    await removeArchivedWorktreeById(id, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete Worktree';
    const handoffConflict = isTerminalHandoffConflictError(error);
    logger.warn({ worktreeId: id, error: message }, 'Failed to delete archived Worktree');
    return NextResponse.json(
      { error: message, ...(handoffConflict ? { code: error.code } : {}) },
      { status: handoffConflict ? 409 : 400 },
    );
  }
}
