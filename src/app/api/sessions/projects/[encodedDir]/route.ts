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
import {
  getProjectViewSessions,
  getProjectViewSessionsByStatus,
} from '@/lib/projects/project-view-projection';

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
 *   - cursor: opaque stable cursor for pagination
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
    const creationBranch = searchParams.get('creationBranch') || undefined;

    if (limit < 1 || limit > 100000) {
      return NextResponse.json(
        { error: 'Invalid pagination parameters' },
        { status: 400 }
      );
    }

    if (cursor && !dbSessions.isValidSessionCursor(cursor)) {
      return NextResponse.json(
        { error: 'Invalid cursor format' },
        { status: 400 }
      );
    }

    const activeSessionIds = getActiveSessionIds(userId);
    const generatingSessionIds = processManager.getGeneratingSessionIds();
    const runtimeConfigs = processManager.getSessionRuntimeConfigs();

    const result = statusGroup
      ? getProjectViewSessionsByStatus(encodedDir, statusGroup, { limit, cursor, creationBranch })
      : getProjectViewSessions(encodedDir, { limit, cursor, creationBranch });

    const project = dbProjects.getProject(encodedDir);
    const projectWorktree = dbProjects.getProjectWorktree(encodedDir);
    const projectDiffWorkDir = projectWorktree?.filesystemPath ?? project?.decoded_path;

    const mapped = result.sessions.map((row) => ({
      ...dbSessions.mapSessionRowToApi(row, activeSessionIds, generatingSessionIds),
      projectDir: encodedDir,
      lastModified: maxActivityTimestamp(row.updated_at, getSessionHistoryModifiedAt(row.id)),
      ...(runtimeConfigs.get(row.id) ?? {}),
    }));
    // Direct chats share one Project checkout. A focused page schedules that
    // checkout once, regardless of how many Session rows the page contains.
    const diffStatsByWorkDir = getCachedOrScheduleBulk(
      [projectDiffWorkDir],
      userId,
    );
    const projectDiffStats = projectDiffWorkDir
      ? diffStatsByWorkDir.get(projectDiffWorkDir) ?? undefined
      : undefined;
    const sessions = mapped.map((s) => ({
      ...s,
      diffStats: projectDiffStats,
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
