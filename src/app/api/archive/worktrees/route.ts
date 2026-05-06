import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { removeArchivedWorktrees } from '@/lib/archive/archive-service';
import logger from '@/lib/logger';

export async function DELETE(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  try {
    const params = req.nextUrl.searchParams;
    const result = await removeArchivedWorktrees({
      projectId: params.get('projectId') ?? undefined,
      query: params.get('query') ?? undefined,
    }, auth.userId);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete archived worktrees';
    logger.warn({ error: message }, 'Failed to bulk delete archived worktrees');
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
