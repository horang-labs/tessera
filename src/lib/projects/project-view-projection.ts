import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';

export type ProjectViewSession = dbSessions.SessionRow & {
  /** Stable representative Project for global surfaces, independent of this view. */
  originProjectId: string;
};

function exposeSessionOrigins<T extends { sessions: dbSessions.SessionRow[] }>(
  result: T,
): Omit<T, 'sessions'> & { sessions: ProjectViewSession[] } {
  return {
    ...result,
    sessions: result.sessions.map((session) => ({
      ...session,
      originProjectId: session.project_id,
    })),
  };
}

function getViewScope(projectId: string): dbSessions.ProjectViewSessionScope | undefined {
  const projectWorktree = dbProjects.getProjectWorktree(projectId);
  return projectWorktree
    ? { worktreeId: projectWorktree.id, currentBranch: projectWorktree.currentBranch }
    : undefined;
}

/**
 * The read boundary for a selected Project. Direct Sessions are projected from
 * its canonical Worktree and live branch; null-scope history stays visible.
 */
export function getProjectViewProjection(
  projectId: string,
  options: { limitPerStatus?: number; activeSessionIds?: Set<string> } = {},
) {
  const projectWorktree = dbProjects.getProjectWorktree(projectId);
  const result = exposeSessionOrigins(dbSessions.getSessionsByProjectGrouped(projectId, {
    limitPerStatus: options.limitPerStatus,
    viewScope: projectWorktree
      ? { worktreeId: projectWorktree.id, currentBranch: projectWorktree.currentBranch }
      : undefined,
  }));
  const linkedWorktrees = getProjectViewWorktrees(projectId, options.activeSessionIds);
  return { projectWorktree, linkedWorktrees, ...result };
}

export function getProjectViewWorktrees(
  projectId: string,
  activeSessionIds: Set<string> = new Set(),
) {
  const projectWorktree = dbProjects.getProjectWorktree(projectId);
  return projectWorktree
    ? dbTasks.getTasks(projectId, activeSessionIds, {
        viewScope: {
          originWorktreeId: projectWorktree.id,
          branch: projectWorktree.currentBranch,
        },
      })
    : dbTasks.getTasks(projectId, activeSessionIds);
}

export function getProjectViewSessions(
  projectId: string,
  options: { limit?: number; cursor?: string } = {},
) {
  return exposeSessionOrigins(dbSessions.getSessionsByProject(projectId, {
    ...options,
    viewScope: getViewScope(projectId),
  }));
}

export function getProjectViewSessionsByStatus(
  projectId: string,
  statusGroup: string,
  options: { limit?: number; cursor?: string } = {},
) {
  return exposeSessionOrigins(dbSessions.getSessionsByStatus(projectId, statusGroup, {
    ...options,
    viewScope: getViewScope(projectId),
  }));
}
