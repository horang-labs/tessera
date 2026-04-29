import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { listArchiveItems, pruneExpiredArchivedWorktrees } from '@/lib/archive/archive-service';
import { SettingsManager } from '@/lib/settings/manager';
import logger from '@/lib/logger';

export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  try {
    const params = req.nextUrl.searchParams;
    const projectId = params.get('projectId') ?? undefined;
    const kindParam = params.get('kind') ?? 'all';
    const kind = ['all', 'chat', 'task'].includes(kindParam) ? kindParam as 'all' | 'chat' | 'task' : null;
    if (!kind) {
      return NextResponse.json({ error: 'Invalid archive kind' }, { status: 400 });
    }
    const limitParam = params.get('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const result = await listArchiveItems({
      projectId,
      kind,
      query: params.get('query') ?? undefined,
      limit,
      cursor: params.get('cursor'),
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to list archive items');
    return NextResponse.json({ error: 'Failed to list archive items' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  try {
    const settings = await SettingsManager.load(auth.userId);
    const result = await pruneExpiredArchivedWorktrees(settings.archivedWorktreeRetentionDays);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    logger.error({ error }, 'Failed to prune archived worktrees');
    return NextResponse.json({ error: 'Failed to prune archived worktrees' }, { status: 500 });
  }
}
