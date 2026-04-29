import fs from 'fs/promises';
import path from 'path';
import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';
import { processManager } from '@/lib/cli/process-manager';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import { isManagedWorktreePath, removeManagedWorktree } from '@/lib/worktrees/managed';
import logger from '@/lib/logger';
import type { SessionRow } from '@/lib/db/sessions';
import type { TaskEntity } from '@/types/task-entity';

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
  worktreeBranch?: string;
  worktreeDeletedAt?: string;
  worktreeStatus: WorktreeArchiveStatus;
  canRestore: boolean;
  sessions: Array<{
    id: string;
    title: string;
    provider?: string;
    lastModified: string;
    isRunning: boolean;
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
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

async function mapChat(row: SessionRow): Promise<ArchiveItem> {
  const worktreeStatus = await getWorktreeStatus(row.work_dir, row.worktree_deleted_at);
  const hasWorktreeDependency = Boolean(row.work_dir);
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
    workDir: row.work_dir ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
    worktreeDeletedAt: row.worktree_deleted_at ?? undefined,
    worktreeStatus,
    canRestore: hasWorktreeDependency ? worktreeStatus === 'present' : true,
    sessions: [{
      id: row.id,
      title: row.title,
      provider: row.provider,
      lastModified: row.updated_at,
      isRunning: processManager.getActiveSessionIds().has(row.id),
    }],
  };
}

async function mapTask(task: TaskEntity): Promise<ArchiveItem> {
  const worktreeStatus = await getWorktreeStatus(task.workDir, task.worktreeDeletedAt);
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
    worktreeBranch: task.worktreeBranch,
    worktreeDeletedAt: task.worktreeDeletedAt,
    worktreeStatus,
    canRestore: Boolean(task.workDir) && worktreeStatus === 'present',
    sessions: task.sessions,
  };
}

export async function listArchiveItems(options: ArchiveListOptions = {}): Promise<ArchiveListResult> {
  const normalizedProjectId = options.projectId && options.projectId !== 'all' ? options.projectId : undefined;
  const activeSessionIds = processManager.getActiveSessionIds();
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
  const items = [
    ...(await Promise.all(chatRows.map(mapChat))),
    ...(await Promise.all(tasks.map(mapTask))),
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

export async function restoreArchivedChat(sessionId: string): Promise<void> {
  const session = dbSessions.getSession(sessionId);
  if (!session || session.deleted) {
    throw new Error('Session not found');
  }
  if (session.task_id) {
    throw new Error('Task sessions must be restored through their task');
  }

  const worktreeStatus = await getWorktreeStatus(session.work_dir, session.worktree_deleted_at);
  if (session.work_dir && worktreeStatus !== 'present') {
    throw new Error('Cannot restore because the worktree is unavailable');
  }

  dbSessions.updateSession(sessionId, { archived: 0, archived_at: null });
}

export async function setTaskArchived(taskId: string, archived: boolean): Promise<void> {
  const task = dbTasks.getTask(taskId, processManager.getActiveSessionIds());
  if (!task) {
    throw new Error('Task not found');
  }

  if (!archived) {
    const worktreeStatus = await getWorktreeStatus(task.workDir, task.worktreeDeletedAt);
    if (!task.workDir || worktreeStatus !== 'present') {
      throw new Error('Cannot restore because the worktree is unavailable');
    }
  }

  dbTasks.setTaskArchived(taskId, archived);
}

export async function permanentlyDeleteArchivedTask(userId: string, taskId: string): Promise<void> {
  const task = dbTasks.getTask(taskId, processManager.getActiveSessionIds());
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

export async function removeArchivedTaskWorktree(taskId: string): Promise<void> {
  const { items } = await listArchiveItems();
  const item = items.find((entry) => entry.kind === 'task' && entry.id === taskId);
  if (!item) {
    throw new Error('Archived task not found');
  }
  if (!item.archivedAt) {
    throw new Error('Task is not archived');
  }
  if (!item.workDir) {
    throw new Error('Task has no worktree to delete');
  }
  if (item.worktreeDeletedAt || item.worktreeStatus === 'deleted') {
    throw new Error('Worktree already deleted');
  }
  if (!isManagedWorktreePath(item.workDir)) {
    throw new Error('Worktree is not managed by this app');
  }
  const activeIds = processManager.getActiveSessionIds();
  if (item.sessions.some((session) => activeIds.has(session.id))) {
    throw new Error('Cannot delete worktree while sessions are running');
  }
  const removed = await removeArchivedWorktree(item);
  if (!removed) {
    throw new Error('Failed to remove worktree');
  }
}

export async function removeArchivedWorktrees(options: Pick<ArchiveListOptions, 'projectId' | 'query'> = {}): Promise<RetentionResult> {
  const result: RetentionResult = { removed: 0, skipped: 0, errors: [] };
  const { items } = await listArchiveItems({
    projectId: options.projectId,
    query: options.query,
  });
  const activeIds = processManager.getActiveSessionIds();

  for (const item of items) {
    if (
      !item.workDir
      || item.worktreeStatus !== 'present'
      || !isManagedWorktreePath(item.workDir)
      || item.sessions.some((session) => activeIds.has(session.id))
    ) {
      result.skipped += 1;
      continue;
    }

    try {
      const removed = await removeArchivedWorktree(item);
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

async function removeArchivedWorktree(item: ArchiveItem): Promise<boolean> {
  if (!item.workDir || !item.archivedAt || item.worktreeDeletedAt) return false;
  if (!isManagedWorktreePath(item.workDir)) return false;
  if (item.worktreeStatus === 'deleted') return false;

  const activeIds = processManager.getActiveSessionIds();
  if (item.sessions.some((session) => activeIds.has(session.id))) {
    return false;
  }

  const deletedAt = new Date().toISOString();
  if (item.worktreeStatus === 'present') {
    const sourceProjectDir = resolveSourceProjectDir(item.projectId);
    if (!sourceProjectDir) {
      throw new Error('Failed to resolve source project for managed worktree cleanup');
    }
    try {
      await removeManagedWorktree(sourceProjectDir, item.workDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const worktreeStillExists = await pathExists(item.workDir);
      if (!isStaleManagedWorktreeRemovalError(message) && worktreeStillExists) {
        throw error;
      }
      if (worktreeStillExists) {
        await fs.rm(item.workDir, { recursive: true, force: true });
      }
    }
  }

  if (item.kind === 'task') {
    dbTasks.setTaskWorktreeDeletedAt(item.id, deletedAt);
  } else {
    dbSessions.setSessionWorktreeDeletedAt(item.id, deletedAt);
  }
  return true;
}

export async function pruneExpiredArchivedWorktrees(retentionDays: number): Promise<RetentionResult> {
  const result: RetentionResult = { removed: 0, skipped: 0, errors: [] };
  const { items } = await listArchiveItems();

  for (const item of items) {
    if (!item.workDir || !isExpired(item.archivedAt, retentionDays)) {
      result.skipped += 1;
      continue;
    }

    try {
      const removed = await removeArchivedWorktree(item);
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
