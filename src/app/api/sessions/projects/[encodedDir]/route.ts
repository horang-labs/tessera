import { NextRequest, NextResponse } from 'next/server';
import { processManager } from '@/lib/cli/process-manager';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { validateEncodedPath } from '@/lib/validation/path';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import { getCachedOrScheduleBulk } from '@/lib/git/worktree-diff-stats-bulk';
import { broadcastSessionMutation, getOriginClientIdFromRequest } from '@/lib/ws/mutation-broadcast';
import logger from '@/lib/logger';
import { getSessionHistoryModifiedAt } from '@/lib/session-history';

function maxActivityTimestamp(left: string, right: string | null): string {
  if (!right) return left;
  return right > left ? right : left;
}

/**
 * GET /api/sessions/projects/:encodedDir
 *
 * Returns paginated sessions for a specific project from DB.
 *
 * Query Parameters:
 *   - limit: Maximum sessions to return (default: 20, min: 1, max: 100)
 *   - cursor: sort_order cursor for pagination
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ encodedDir: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  try {
    const { encodedDir } = await params;

    if (!validateEncodedPath(encodedDir)) {
      logger.warn({ encodedDir, userId }, 'Path traversal attempt detected');
      return NextResponse.json(
        { error: 'Invalid project directory' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const cursor = searchParams.get('cursor') || undefined;
    const statusGroup = searchParams.get('statusGroup') || undefined;

    if (limit < 1 || limit > 100000) {
      return NextResponse.json(
        { error: 'Invalid pagination parameters' },
        { status: 400 }
      );
    }

    if (cursor && !/^\d+$/.test(cursor)) {
      return NextResponse.json(
        { error: 'Invalid cursor format: must be a numeric sort_order cursor' },
        { status: 400 }
      );
    }

    const activeSessionIds = getActiveSessionIds(userId);
    const generatingSessionIds = processManager.getGeneratingSessionIds();
    const runtimeConfigs = processManager.getSessionRuntimeConfigs();

    const result = statusGroup
      ? dbSessions.getSessionsByStatus(encodedDir, statusGroup, { limit, cursor })
      : dbSessions.getSessionsByProject(encodedDir, { limit, cursor });

    const mapped = result.sessions.map((row) => ({
      ...dbSessions.mapSessionRowToApi(row, activeSessionIds, generatingSessionIds),
      lastModified: maxActivityTimestamp(row.updated_at, getSessionHistoryModifiedAt(row.id)),
      ...(runtimeConfigs.get(row.id) ?? {}),
    }));
    // Diff badge shows for any session whose work dir is a git worktree —
    // standalone chats included, not just worktree-branch-bound sessions. A
    // chat created inside a worktree directory has a workDir but no
    // worktreeBranch, yet still produces a real diff. computeWorktreeDiffStats
    // returns null for non-git paths, so this stays safe for plain dirs.
    const diffStatsByWorkDir = getCachedOrScheduleBulk(
      mapped.map((s) => s.workDir ?? undefined),
      userId,
    );
    const sessions = mapped.map((s) => ({
      ...s,
      diffStats: s.workDir
        ? diffStatsByWorkDir.get(s.workDir) ?? undefined
        : undefined,
    }));

    const hasMore = result.nextCursor !== null;

    const response = {
      encodedDir,
      sessions,
      totalSessions: result.totalCount,
      hasMore,
      nextCursor: result.nextCursor,
    };

    logger.info({
      userId,
      encodedDir,
      limit,
      sessionCount: sessions.length,
      hasMore,
      }, 'Load more sessions');

    return NextResponse.json(response);
  } catch (error: any) {
    logger.error({ error }, 'Failed to load more sessions');
    return NextResponse.json(
      { error: 'Failed to load sessions' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sessions/projects/:encodedDir
 *
 * Removes a project from the DB (hides from sidebar).
 * Also cascade-deletes session records.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ encodedDir: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  try {
    const { encodedDir } = await params;

    if (!validateEncodedPath(encodedDir)) {
      logger.warn({ encodedDir, userId }, 'Path traversal attempt detected');
      return NextResponse.json(
        { error: 'Invalid project directory' },
        { status: 400 }
      );
    }

    dbProjects.removeProject(encodedDir);

    logger.info({ userId, encodedDir }, 'Project removed from sidebar');

    broadcastSessionMutation(userId, {
      kind: 'project_deleted',
      projectId: encodedDir,
      originClientId: getOriginClientIdFromRequest(req),
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    logger.error({ error }, 'Failed to remove project');
    return NextResponse.json(
      { error: 'Failed to remove project' },
      { status: 500 }
    );
  }
}
