import fs from 'fs/promises';
import path from 'path';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';
import * as dbWorktrees from '@/lib/db/worktrees';
import {
  closeSessionRuntimes,
  getActiveSessionIds,
} from '@/lib/session/active-session-runtime';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { isManagedWorktreePath, removeManagedWorktree } from '@/lib/worktrees/managed';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';
import logger from '@/lib/logger';
import { resolvePathForHostFilesystem } from '@/lib/filesystem/host-path';
import { pathExists } from '@/lib/filesystem/path-exists';
import {
  beginTesseraSessionOperations,
  endTesseraSessionOperations,
  TerminalHandoffConflictError,
  withExclusiveTesseraSessionOperation,
  withExclusiveTesseraSessionOperations,
  withTesseraSessionOperation,
  withTesseraSessionOperations,
} from '@/lib/terminal/terminal-handoff-lock';
import type { SessionRow } from '@/lib/db/sessions';
import type { TaskEntity } from '@/types/task-entity';
import { syncCodexThreadsArchived } from '@/lib/session/codex-thread-lifecycle';
import { getTaskProjectViewIdsByTask } from '@/lib/projects/project-view-projection';

export type ArchiveItemKind = 'chat' | 'task';
export type WorktreeArchiveStatus = 'none' | 'present' | 'deleted' | 'missing';

export interface ArchiveItem {
  id: string;
  kind: ArchiveItemKind;
  title: string;
  projectId: string;
  projectName: string;
  collectionId?: string;
  workflowStatus?: string;
  archivedAt?: string;
  updatedAt: string;
  createdAt: string;
  workDir?: string;
  worktreeId?: string;
  worktreeBranch?: string;
  worktreeManaged: boolean;
  worktreeDeletedAt?: string;
  worktreeStatus: WorktreeArchiveStatus;
  canRestore: boolean;
  /**
   * True when this entry's worktree belongs to a task that is still live — an
   * individually archived task session. Deleting the worktree would pull it out
   * from under the task and its remaining sessions, so worktree removal (manual
   * or by retention) must skip these entries.
   */
  sharedWorktree: boolean;
  /** Owning Worktree Task for an individually archived child Session. */
  taskId?: string;
  /** Every visible Project View where restoring this canonical entity must reappear. */
  affectedProjectIds: string[];
  sessions: Array<{
    id: string;
    title: string;
    provider?: string;
    lastModified: string;
    isRunning: boolean;
    archived: boolean;
  }>;
}

export interface ArchiveProjectOption {
  id: string;
  displayName: string;
  decodedPath: string;
  visible: boolean;
}

export interface ArchiveListResult {
  items: ArchiveItem[];
  projects: ArchiveProjectOption[];
  summary: {
    total: number;
    chats: number;
    tasks: number;
    worktreesPresent: number;
    worktreesDeleted: number;
    worktreesMissing: number;
  };
  pagination: {
    kind: ArchiveItemKind | 'all';
    limit: number | null;
    cursor: string | null;
    nextCursor: string | null;
    returned: number;
    total: number;
  };
}

export interface RetentionResult {
  removed: number;
  skipped: number;
  errors: Array<{ id: string; kind: ArchiveItemKind; error: string }>;
}

export interface ArchiveListOptions {
  projectId?: string;
  kind?: ArchiveItemKind | 'all';
  query?: string;
  limit?: number;
  cursor?: string | null;
}

const MAX_ARCHIVE_PAGE_SIZE = 200;

function normalizePageLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.min(MAX_ARCHIVE_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function normalizeOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function getWorktreeStatus(
  workDir: string | null | undefined,
  deletedAt: string | null | undefined,
): Promise<WorktreeArchiveStatus> {
  if (!workDir) return 'none';
  if (deletedAt) return 'deleted';
  return (await pathExists(workDir)) ? 'present' : 'missing';
}

function getProjectName(projectId: string | null | undefined): string {
  if (!projectId) return 'Unknown Project';
  const project = dbProjects.getProject(projectId);
  return project?.display_name ?? path.basename(projectId);
}

function resolveSourceProjectDir(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  return dbProjects.getProject(projectId)?.decoded_path
    ?? (path.isAbsolute(projectId) ? projectId : null);
}

function retentionCutoff(days: number): number {
  return Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
}

function isExpired(archivedAt: string | undefined, days: number): boolean {
  if (!archivedAt) return false;
  return new Date(archivedAt).getTime() <= retentionCutoff(days);
}

function isStaleManagedWorktreeRemovalError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('not a working tree')
    || normalized.includes('gitdir file points to non-existent location')
    || (normalized.includes('.git') && normalized.includes('does not exist'));
}

function isRecordedManagedWorktree(
  workDir: string | null | undefined,
  worktreeManaged: boolean | number | null | undefined,
): boolean {
  if (!workDir) return false;
  return worktreeManaged === true || worktreeManaged === 1 || isManagedWorktreePath(workDir);
}

async function mapChat(
  row: SessionRow,
  affectedProjectIds: string[],
): Promise<ArchiveItem> {
  const checkout = dbSessions.getSessionWorktreeContext(row.id);
  const workDir = checkout?.workDir ?? row.work_dir;
  const worktreeBranch = checkout?.worktreeBranch ?? row.worktree_branch;
  const worktreeStatus = await getWorktreeStatus(workDir, row.worktree_deleted_at);
  const hasWorktreeDependency = Boolean(workDir);
  const worktreeManaged = checkout
    ? checkout.worktreeManaged
    : isRecordedManagedWorktree(workDir, row.worktree_managed);
  return {
    id: row.id,
    kind: 'chat',
    title: row.title,
    projectId: row.project_id,
    projectName: getProjectName(row.project_id),
    collectionId: row.collection_id ?? undefined,
    workflowStatus: row.workflow_status ?? undefined,
    archivedAt: row.archived_at ?? row.updated_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    workDir: workDir ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    worktreeBranch: worktreeBranch ?? undefined,
    worktreeManaged,
    worktreeDeletedAt: row.worktree_deleted_at ?? undefined,
    worktreeStatus,
    canRestore: hasWorktreeDependency ? worktreeStatus === 'present' : true,
    sharedWorktree: Boolean(row.task_id),
    taskId: row.task_id ?? undefined,
    affectedProjectIds,
    sessions: [{
      id: row.id,
      title: row.title,
      provider: row.provider,
      lastModified: row.updated_at,
      isRunning: getActiveSessionIds().has(row.id),
      archived: true,
    }],
  };
}

async function mapTask(
  task: TaskEntity,
  affectedProjectIds: string[],
): Promise<ArchiveItem> {
  const worktreeStatus = await getWorktreeStatus(task.workDir, task.worktreeDeletedAt);
  const worktreeManaged = isRecordedManagedWorktree(task.workDir, task.worktreeManaged);
  return {
    id: task.id,
    kind: 'task',
    title: task.title,
    projectId: task.projectId,
    projectName: getProjectName(task.projectId),
    collectionId: task.collectionId,
    workflowStatus: task.workflowStatus,
    archivedAt: task.archivedAt ?? task.updatedAt,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
    workDir: task.workDir,
    worktreeId: task.worktreeId,
    worktreeBranch: task.worktreeBranch,
    worktreeManaged,
    worktreeDeletedAt: task.worktreeDeletedAt,
    worktreeStatus,
    canRestore: Boolean(task.workDir) && worktreeStatus === 'present',
    sharedWorktree: false,
    affectedProjectIds,
    sessions: task.sessions.map((session) => ({
      ...session,
      archived: session.archived ?? false,
    })),
  };
}

export async function listArchiveItems(options: ArchiveListOptions = {}): Promise<ArchiveListResult> {
  const normalizedProjectId = options.projectId && options.projectId !== 'all' ? options.projectId : undefined;
  const activeSessionIds = getActiveSessionIds();
  const kind = options.kind ?? 'all';
  const limit = normalizePageLimit(options.limit);
  const offset = normalizeOffset(options.cursor);
  const query = options.query?.trim() || undefined;
  const pageOptions = limit === undefined
    ? { query }
    : { query, limit, offset };
  const chatTotal = dbSessions.countArchivedChatSessions(normalizedProjectId, query);
  const taskTotal = dbTasks.countArchivedTasks(normalizedProjectId, query);

  const chatRows = kind === 'task'
    ? []
    : dbSessions.getArchivedChatSessions(normalizedProjectId, pageOptions);
  const tasks = kind === 'chat'
    ? []
    : dbTasks.getArchivedTasks(activeSessionIds, normalizedProjectId, pageOptions);
  const taskIds = [
    ...chatRows.flatMap((row) => row.task_id ? [row.task_id] : []),
    ...tasks.map((task) => task.id),
  ];
  const affectedProjectIdsByTask = getTaskProjectViewIdsByTask(taskIds);
  const items = [
    ...(await Promise.all(chatRows.map((row) => mapChat(
      row,
      row.task_id
        ? affectedProjectIdsByTask.get(row.task_id) ?? [row.project_id]
        : [row.project_id],
    )))),
    ...(await Promise.all(tasks.map((task) => mapTask(
      task,
      affectedProjectIdsByTask.get(task.id) ?? [task.projectId],
    )))),
  ].sort((a, b) => (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt));
  const pageTotal = kind === 'chat'
    ? chatTotal
    : kind === 'task'
      ? taskTotal
      : chatTotal + taskTotal;

  return {
    items,
    projects: dbProjects.getProjectsWithHistory().map((project) => ({
      id: project.id,
      displayName: project.display_name,
      decodedPath: project.decoded_path,
      visible: project.visible === 1,
    })),
    summary: {
      total: chatTotal + taskTotal,
      chats: chatTotal,
      tasks: taskTotal,
      worktreesPresent: items.filter((item) => item.worktreeStatus === 'present').length,
      worktreesDeleted: items.filter((item) => item.worktreeStatus === 'deleted').length,
      worktreesMissing: items.filter((item) => item.worktreeStatus === 'missing').length,
    },
    pagination: {
      kind,
      limit: limit ?? null,
      cursor: String(offset),
      nextCursor: limit !== undefined && offset + items.length < pageTotal
        ? String(offset + items.length)
        : null,
      returned: items.length,
      total: pageTotal,
    },
  };
}

export async function restoreArchivedChat(sessionId: string, userId?: string): Promise<void> {
  return withExclusiveTesseraSessionOperation(sessionId, async () => {
    const session = dbSessions.getSession(sessionId);
    if (!session || session.deleted) {
      throw new Error('Session not found');
    }
    // A session archived on its own restores back into its task. Only a session
    // whose task is archived too has to go through the task, which restores the
    // worktree and every sibling as one unit.
    if (session.task_id && dbTasks.getTask(session.task_id)?.archived) {
      throw new Error('Sessions of an archived task must be restored through their task');
    }

    const workDir = dbSessions.getSessionWorktreeContext(sessionId)?.workDir ?? session.work_dir;
    const worktreeStatus = await getWorktreeStatus(workDir, session.worktree_deleted_at);
    if (workDir && worktreeStatus !== 'present') {
      throw new Error('Cannot restore because the worktree is unavailable');
    }

    await syncCodexThreadsArchived([session], false, userId);
    try {
      dbSessions.updateSession(sessionId, { archived: 0, archived_at: null });
    } catch (error) {
      try {
        await syncCodexThreadsArchived([session], true, userId);
      } catch (compensationError) {
        logger.error({ sessionId, error: compensationError }, 'Failed to compensate Codex unarchive state');
      }
      throw error;
    }

  });
}

export async function setTaskArchived(taskId: string, archived: boolean, userId?: string): Promise<void> {
  const task = dbTasks.getTask(taskId, getActiveSessionIds());
  if (!task) {
    throw new Error('Task not found');
  }

  const sessionRows = task.sessions
    .map((session) => dbSessions.getSession(session.id))
    .filter((session): session is SessionRow => Boolean(session));
  return withExclusiveTesseraSessionOperations(task.sessions.map((session) => session.id), async () => {
    if (!archived) {
      const worktreeStatus = await getWorktreeStatus(task.workDir, task.worktreeDeletedAt);
      if (!task.workDir || worktreeStatus !== 'present') {
        throw new Error('Cannot restore because the worktree is unavailable');
      }
    }

    await syncCodexThreadsArchived(sessionRows, archived, userId);
    try {
      dbTasks.setTaskArchived(taskId, archived);
    } catch (error) {
      try {
        await syncCodexThreadsArchived(sessionRows, !archived, userId);
      } catch (compensationError) {
        logger.error({ taskId, archived, error: compensationError }, 'Failed to compensate task Codex archive state');
      }
      throw error;
    }

    if (archived) {
      await Promise.all(
        task.sessions.map((session) => closeSessionRuntimes(session.id, userId)),
      );
    }
  });
}

export async function permanentlyDeleteArchivedTask(userId: string, taskId: string): Promise<void> {
  // Includes children archived on their own — deleting the task must not leave
  // their rows or histories behind.
  const task = dbTasks.getTask(taskId, getActiveSessionIds(), { includeArchivedSessions: true });
  if (!task) {
    throw new Error('Task not found');
  }
  if (!task.archived) {
    throw new Error('Task is not archived');
  }
  for (const session of task.sessions) {
    await sessionOrchestrator.deleteSession(userId, session.id);
  }

  dbTasks.deleteTask(taskId);
}

export async function removeWorktreeById(worktreeId: string, userId?: string): Promise<void> {
  assertWorktreeDeletionAllowed(worktreeId);
  const archivedForDeletion: string[] = [];

  try {
    for (const taskId of dbWorktrees.getTaskIdsForWorktree(worktreeId)) {
      const task = dbTasks.getTask(taskId, getActiveSessionIds(), { includeArchivedSessions: true });
      if (task && !task.archived) {
        await setTaskArchived(taskId, true, userId);
        archivedForDeletion.push(taskId);
      }
    }
    await removeArchivedWorktreeById(worktreeId, userId);
  } catch (error) {
    for (const taskId of archivedForDeletion.reverse()) {
      try {
        await setTaskArchived(taskId, false, userId);
      } catch (compensationError) {
        logger.error(
          { taskId, worktreeId, error: compensationError },
          'Failed to restore Task after Worktree deletion failure',
        );
      }
    }
    throw error;
  }
}

export async function removeArchivedWorktreeById(worktreeId: string, userId?: string): Promise<void> {
  const { items } = await listArchiveItems();
  const item = items.find((entry) => entry.worktreeId === worktreeId && !entry.sharedWorktree);
  if (!item) {
    throw new Error('Archived Worktree not found');
  }
  if (!item.archivedAt) {
    throw new Error('Worktree is not archived');
  }
  if (!item.workDir) {
    throw new Error('Worktree has no checkout to delete');
  }
  if (item.worktreeDeletedAt || item.worktreeStatus === 'deleted') {
    throw new Error('Worktree already deleted');
  }
  if (!item.worktreeManaged) {
    throw new Error('Worktree is not managed by this app');
  }
  assertWorktreeDeletionAllowed(worktreeId);
  const activeIds = getActiveSessionIds();
  if (item.sessions.some((session) => activeIds.has(session.id))) {
    throw new Error('Cannot delete worktree while sessions are running');
  }
  const removed = await removeArchivedWorktree(
    item,
    await createArchiveGitRunner(userId),
    true,
  );
  if (!removed) {
    throw new Error('Worktree is unavailable; canonical records were preserved');
  }
}

export async function removeArchivedWorktrees(
  options: Pick<ArchiveListOptions, 'projectId' | 'query'> = {},
  userId?: string,
): Promise<RetentionResult> {
  const result: RetentionResult = { removed: 0, skipped: 0, errors: [] };
  const { items } = await listArchiveItems({
    projectId: options.projectId,
    query: options.query,
  });
  const activeIds = getActiveSessionIds();
  const runGit = await createArchiveGitRunner(userId);
  const visitedWorktreeIds = new Set<string>();

  for (const item of items) {
    if (
      !item.worktreeId
      || visitedWorktreeIds.has(item.worktreeId)
      || !item.workDir
      || item.worktreeStatus !== 'present'
      || !item.worktreeManaged
      || item.sharedWorktree
      || item.sessions.some((session) => activeIds.has(session.id))
    ) {
      result.skipped += 1;
      continue;
    }
    visitedWorktreeIds.add(item.worktreeId);

    try {
      assertWorktreeDeletionAllowed(item.worktreeId);
      const removed = await removeArchivedWorktree(item, runGit);
      if (removed) {
        result.removed += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ archiveItemId: item.id, kind: item.kind, error: message }, 'Archived worktree bulk delete failed');
      result.errors.push({ id: item.id, kind: item.kind, error: message });
    }
  }

  return result;
}

async function removeArchivedWorktree(
  item: ArchiveItem,
  runGit?: GitRunner,
  throwOnHandoffConflict = false,
): Promise<boolean> {
  if (!item.worktreeId || !item.archivedAt || item.worktreeDeletedAt) return false;
  if (!item.worktreeManaged) return false;
  if (item.sharedWorktree) return false;
  if (item.worktreeStatus === 'deleted') return false;

  const worktree = dbWorktrees.getWorktree(item.worktreeId);
  if (!worktree?.filesystemPath || !(await pathExists(worktree.filesystemPath))) {
    return false;
  }

  const sessionIds = dbWorktrees.getSessionIdsForWorktree(item.worktreeId);
  const acquired = beginTesseraSessionOperations(sessionIds);
  if (!acquired) {
    if (throwOnHandoffConflict) {
      throw new TerminalHandoffConflictError();
    }
    return false;
  }

  try {
    const activeIds = getActiveSessionIds();
    if (sessionIds.some((sessionId) => activeIds.has(sessionId))) {
      return false;
    }

    const deletedAt = new Date().toISOString();
    if (item.worktreeStatus === 'present') {
      const sourceProjectDir = resolveSourceProjectDir(item.projectId);
      if (!sourceProjectDir) {
        throw new Error('Failed to resolve source project for managed worktree cleanup');
      }
      try {
        const gitRunner = runGit ?? createGitRunner(await resolveGitEnvironment({
          inferFromPaths: [sourceProjectDir, worktree.filesystemPath],
        }));
        // Project visibility can change while an environment-specific runner
        // is resolved, so enforce the identity guard at the destructive edge.
        assertWorktreeDeletionAllowed(item.worktreeId);
        // Cleanup can run without a user attached, so the environment comes
        // from the paths; a native fallback cannot remove a WSL worktree.
        await removeManagedWorktree(
          sourceProjectDir,
          worktree.filesystemPath,
          gitRunner,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const worktreeStillExists = await pathExists(worktree.filesystemPath);
        if (!isStaleManagedWorktreeRemovalError(message) && worktreeStillExists) {
          throw error;
        }
        if (worktreeStillExists) {
          assertWorktreeDeletionAllowed(item.worktreeId);
          await fs.rm(await resolvePathForHostFilesystem(worktree.filesystemPath), {
            recursive: true,
            force: true,
          });
        }
      }
    }

    dbWorktrees.markWorktreeDeleted(item.worktreeId, deletedAt);
    return true;
  } finally {
    endTesseraSessionOperations(acquired);
  }
}

function assertWorktreeDeletionAllowed(worktreeId: string): void {
  const project = dbWorktrees.getVisibleProjectWorktreeViews(worktreeId)[0];
  if (!project) return;
  throw new Error(
    `Cannot delete this Worktree because it is the Project Worktree of visible Project "${project.displayName}". `
    + 'The relevant Project must be removed or hidden before deletion can proceed.',
  );
}

export async function pruneExpiredArchivedWorktrees(
  retentionDays: number,
  userId?: string,
): Promise<RetentionResult> {
  const result: RetentionResult = { removed: 0, skipped: 0, errors: [] };
  const { items } = await listArchiveItems();
  const runGit = await createArchiveGitRunner(userId);
  const visitedWorktreeIds = new Set<string>();

  for (const item of items) {
    if (
      !item.worktreeId
      || visitedWorktreeIds.has(item.worktreeId)
      || !item.workDir
      || item.sharedWorktree
      || !isExpired(item.archivedAt, retentionDays)
    ) {
      result.skipped += 1;
      continue;
    }
    visitedWorktreeIds.add(item.worktreeId);

    try {
      assertWorktreeDeletionAllowed(item.worktreeId);
      const removed = await removeArchivedWorktree(item, runGit);
      if (removed) {
        result.removed += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ archiveItemId: item.id, kind: item.kind, error: message }, 'Archived worktree retention failed');
      result.errors.push({ id: item.id, kind: item.kind, error: message });
    }
  }

  return result;
}

async function createArchiveGitRunner(userId?: string): Promise<GitRunner | undefined> {
  if (!userId) return undefined;
  return createGitRunner(await resolveGitEnvironment({ userId }));
}
