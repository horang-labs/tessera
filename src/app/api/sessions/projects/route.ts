import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { processManager } from '@/lib/cli/process-manager';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import { hasPreparationScript } from '@/lib/projects/preparation-script-policy';
import { getProjectViewProjection } from '@/lib/projects/project-view-projection';
import {
  isElectronAppRuntimeProjectPath,
  shouldAutoRegisterCurrentProject,
} from '@/lib/projects/current-project';
import logger from '@/lib/logger';
import { getSessionHistoryModifiedAt } from '@/lib/session-history';
import { getCachedOrScheduleBulk } from '@/lib/git/worktree-diff-stats-bulk';
import { routeCanonicalWorktreePaths } from '@/lib/db/worktrees';

function maxActivityTimestamp(left: string, right: string | null): string {
  if (!right) return left;
  return right > left ? right : left;
}

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
  const { userId } = auth;

  try {
    const { searchParams } = new URL(req.url);
    const limitPerStatus = parseInt(searchParams.get('limitPerStatus') || '100000', 10);

    // Get active/generating session IDs from process manager
    const activeSessionIds = getActiveSessionIds(userId);
    const generatingSessionIds = processManager.getGeneratingSessionIds();
    const runtimeConfigs = processManager.getSessionRuntimeConfigs();
    const agentEnvironment = await getAgentEnvironment(userId);
    await routeCanonicalWorktreePaths(agentEnvironment);

    // Current project directory (matches projects.id which is now the absolute path)
    const currentProjectId = process.cwd();
    const shouldRegisterCurrentProject = shouldAutoRegisterCurrentProject(currentProjectId);

    // Ensure the currently running workspace always appears in the project list.
    // This matters for sibling worktrees because the Tessera DB is shared across
    // worktrees, but a fresh worktree may not be registered yet. Packaged
    // Electron runs the server from the app resources directory, which is not a
    // user project and must not be auto-imported.
    if (shouldRegisterCurrentProject && !dbProjects.isRegistered(currentProjectId)) {
      dbProjects.registerProject(
        currentProjectId,
        currentProjectId,
        path.basename(currentProjectId)
      );
    }

    // Load all registered projects from DB
    const projects = dbProjects
      .getVisibleProjects()
      .filter((project) => !isElectronAppRuntimeProjectPath(project.id));

    // Build project groups with sessions (per-status limit)
    const projectResults = projects.map((project) => {
      const { projectWorktree, ...result } = getProjectViewProjection(project.id, {
        limitPerStatus,
        activeSessionIds,
      });

      const mapped = result.sessions.map((row) => ({
        ...dbSessions.mapSessionRowToApi(row, activeSessionIds, generatingSessionIds),
        projectDir: project.id,
        lastModified: maxActivityTimestamp(row.updated_at, getSessionHistoryModifiedAt(row.id)),
        ...(runtimeConfigs.get(row.id) ?? {}),
        sortOrder: row.sort_order,
      }));
      // Diff badge for any session whose work dir is a git worktree (standalone
      // chats included). Cache-miss workDirs schedule a compute + WS push.
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

      return {
        encodedDir: project.id,
        displayName: project.display_name,
        decodedPath: project.decoded_path,
        displayPath: formatPathForAgentDisplay(project.decoded_path, agentEnvironment),
        ...(projectWorktree?.filesystemPath && {
          projectWorktree: {
            id: projectWorktree.id,
            path: projectWorktree.filesystemPath,
            displayPath: formatPathForAgentDisplay(
              projectWorktree.filesystemPath,
              agentEnvironment,
            ),
            currentBranch: projectWorktree.currentBranch,
          },
        }),
        ...(result.branchRenameWarning && {
          branchRenameWarning: result.branchRenameWarning,
        }),
        isCurrent: shouldRegisterCurrentProject && project.id === currentProjectId,
        // Without one there is nothing to prepare, and no surface should offer
        // it — either stage having something to run counts.
        hasPreparationScript: hasPreparationScript(project.preparation_script)
          || hasPreparationScript(project.preparation_after_script),
        sessions,
        totalSessions: result.totalCount,
        countByStatus: result.countByStatus,
        cursorByStatus: result.cursorByStatus,
        nextCursor: result.nextCursor,
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
