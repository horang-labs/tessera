import * as dbProjects from '@/lib/db/projects';
import * as dbCollections from '@/lib/db/collections';
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

export type ProjectViewSession = dbSessions.SessionRow & {
  /** Stable representative Project for global surfaces, independent of this view. */
  originProjectId: string;
};

function getProjectCollectionIds(projectId: string): Set<string> {
  return new Set(dbCollections.getCollections(projectId).map((collection) => collection.id));
}

function projectSessions<T extends { sessions: dbSessions.SessionRow[] }>(
  result: T,
  projectCollectionIds: Set<string>,
): Omit<T, 'sessions'> & { sessions: ProjectViewSession[] } {
  return {
    ...result,
    sessions: result.sessions.map((session) => ({
      ...session,
      originProjectId: session.project_id,
      collection_id:
        session.collection_id && projectCollectionIds.has(session.collection_id)
          ? session.collection_id
          : null,
    })),
  };
}

function projectWorktrees(
  projectId: string,
  activeSessionIds: Set<string>,
  projectCollectionIds: Set<string>,
) {
  const projectWorktree = dbProjects.getProjectWorktree(projectId);
  const worktrees = projectWorktree
    ? dbTasks.getTasks(projectId, activeSessionIds, {
        viewScope: {
          originWorktreeId: projectWorktree.id,
          branch: projectWorktree.currentBranch,
        },
      })
    : dbTasks.getTasks(projectId, activeSessionIds);

  return worktrees.map((worktree) => ({
    ...worktree,
    collectionId:
      worktree.collectionId && projectCollectionIds.has(worktree.collectionId)
        ? worktree.collectionId
        : undefined,
  }));
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
  const projectCollectionIds = getProjectCollectionIds(projectId);
  const result = projectSessions(dbSessions.getSessionsByProjectGrouped(projectId, {
    limitPerStatus: options.limitPerStatus,
    viewScope: projectWorktree
      ? { worktreeId: projectWorktree.id, currentBranch: projectWorktree.currentBranch }
      : undefined,
  }), projectCollectionIds);
  const linkedWorktrees = projectWorktrees(
    projectId,
    options.activeSessionIds ?? new Set(),
    projectCollectionIds,
  );
  const branchRenameWarning = projectWorktree
    ? getBranchRenameWarning(projectWorktree)
    : undefined;
  return { projectWorktree, linkedWorktrees, branchRenameWarning, ...result };
}

export function getProjectViewWorktrees(
  projectId: string,
  activeSessionIds: Set<string> = new Set(),
) {
  return projectWorktrees(projectId, activeSessionIds, getProjectCollectionIds(projectId));
}

export function getProjectViewSessions(
  projectId: string,
  options: { limit?: number; cursor?: string } = {},
) {
  return projectSessions(dbSessions.getSessionsByProject(projectId, {
    ...options,
    viewScope: getViewScope(projectId),
  }), getProjectCollectionIds(projectId));
}

export function getProjectViewSessionsByStatus(
  projectId: string,
  statusGroup: string,
  options: { limit?: number; cursor?: string } = {},
) {
  return projectSessions(dbSessions.getSessionsByStatus(projectId, statusGroup, {
    ...options,
    viewScope: getViewScope(projectId),
  }), getProjectCollectionIds(projectId));
}
