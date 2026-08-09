import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';
import { readExactOneHopBranchRename } from '@/lib/db/worktree-identity';
import type { ProjectBranchRenameWarning } from './branch-rename-warning';

function getBranchRenameWarning(
  projectWorktree: NonNullable<ReturnType<typeof dbProjects.getProjectWorktree>>,
): ProjectBranchRenameWarning | undefined {
  if (!projectWorktree.filesystemPath || !projectWorktree.currentBranch) return undefined;
  const rename = readExactOneHopBranchRename(
    projectWorktree.filesystemPath,
    projectWorktree.currentBranch,
  );
  if (!rename) return undefined;
  const hasHiddenScope = dbSessions.hasActiveSessionScope(
    projectWorktree.id,
    rename.previousBranch,
  ) || dbTasks.hasActiveWorktreeCreationScope(
    projectWorktree.id,
    rename.previousBranch,
  );
  return hasHiddenScope ? rename : undefined;
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
  const result = dbSessions.getSessionsByProjectGrouped(projectId, {
    limitPerStatus: options.limitPerStatus,
    viewScope: projectWorktree
      ? { worktreeId: projectWorktree.id, currentBranch: projectWorktree.currentBranch }
      : undefined,
  });
  const linkedWorktrees = getProjectViewWorktrees(projectId, options.activeSessionIds);
  const branchRenameWarning = projectWorktree
    ? getBranchRenameWarning(projectWorktree)
    : undefined;
  return { projectWorktree, linkedWorktrees, branchRenameWarning, ...result };
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
  return dbSessions.getSessionsByProject(projectId, {
    ...options,
    viewScope: getViewScope(projectId),
  });
}

export function getProjectViewSessionsByStatus(
  projectId: string,
  statusGroup: string,
  options: { limit?: number; cursor?: string } = {},
) {
  return dbSessions.getSessionsByStatus(projectId, statusGroup, {
    ...options,
    viewScope: getViewScope(projectId),
  });
}
