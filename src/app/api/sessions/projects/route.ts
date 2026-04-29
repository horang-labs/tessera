import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { processManager } from '@/lib/cli/process-manager';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';

/**
 * GET /api/sessions/projects
 *
 * Returns registered projects with their sessions from Tessera's own DB.
 * Only projects imported through Tessera appear.
 * Sessions are limited per project (default: 5).
 * Projects are sorted: current project first, then alphabetically.
 */
export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(req.url);
    const limitPerStatus = parseInt(searchParams.get('limitPerStatus') || '100000', 10);

    // Get active/generating session IDs from process manager
    const activeSessionIds = processManager.getActiveSessionIds();
    const generatingSessionIds = processManager.getGeneratingSessionIds();

    // Current project directory (matches projects.id which is now the absolute path)
    const currentProjectId = process.cwd();

    // Ensure the currently running workspace always appears in the project list.
    // This matters for sibling worktrees because the Tessera DB is shared across
    // worktrees, but a fresh worktree may not be registered yet.
    if (!dbProjects.isRegistered(currentProjectId)) {
      dbProjects.registerProject(
        currentProjectId,
        currentProjectId,
        path.basename(currentProjectId)
      );
    }

    // Load all registered projects from DB
    const projects = dbProjects.getVisibleProjects();

    // Build project groups with sessions (per-status limit)
    const projectResults = projects.map((project) => {
      const result = dbSessions.getSessionsByProjectGrouped(project.id, { limitPerStatus });

      const sessions = result.sessions.map((row) => ({
        ...dbSessions.mapSessionRowToApi(row, activeSessionIds, generatingSessionIds),
        sortOrder: row.sort_order,
      }));

      return {
        encodedDir: project.id,
        displayName: project.display_name,
        decodedPath: project.decoded_path,
        isCurrent: project.id === currentProjectId,
        sessions,
        totalSessions: result.totalCount,
        countByStatus: result.countByStatus,
      };
    });

    // DB returns projects in sort_order; just bubble current project to top
    projectResults.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return 0; // preserve DB sort_order for the rest
    });

    const responseData = { projects: projectResults };

    const responseTime = Date.now() - startTime;
    logger.info({
      endpoint: '/api/sessions/projects',
      limitPerStatus,
      responseTime,
      projectCount: projectResults.length,
      sessionCount: projectResults.reduce((sum, p) => sum + p.sessions.length, 0),
      }, 'API Performance');

    return NextResponse.json(responseData);
  } catch (error: any) {
    logger.error({ error }, 'Failed to list projects');
    return NextResponse.json(
      { error: 'Failed to list projects' },
      { status: 500 }
    );
  }
}
