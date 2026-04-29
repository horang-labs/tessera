'use client';

import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import type React from 'react';
import {
  Archive,
  FolderX,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { useWorktreeRetentionSettingsUpdate } from '@/hooks/use-worktree-retention-settings-update';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { UnifiedSession } from '@/types/chat';
import type { ArchiveItem, ArchiveProjectOption } from '@/lib/archive/archive-service';

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

type ArchiveKind = 'chat' | 'task';

interface ArchiveResponse {
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
    kind: ArchiveKind;
    limit: number | null;
    cursor: string | null;
    nextCursor: string | null;
    returned: number;
    total: number;
  };
}

interface WorktreeDeleteResult {
  removed: number;
  skipped: number;
  errors: Array<{ id: string; kind: string; error: string }>;
}

interface ArchiveKindState {
  items: ArchiveItem[];
  nextCursor: string | null;
  total: number;
}

const ARCHIVE_PAGE_SIZE = 100;

function emptyArchiveKindState(): ArchiveKindState {
  return { items: [], nextCursor: null, total: 0 };
}

function formatRelativeTime(iso: string | undefined, t: TranslateFn): string {
  if (!iso) return '-';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('time.just');
  if (minutes < 60) return t('time.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { days });
  return date.toLocaleDateString();
}

function primarySessionFromItem(item: ArchiveItem): UnifiedSession | null {
  const session = item.sessions[0];
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    projectDir: item.projectId,
    isRunning: session.isRunning,
    status: session.isRunning ? 'running' : 'completed',
    lastModified: session.lastModified,
    createdAt: item.createdAt,
    isReadOnly: true,
    archived: true,
    archivedAt: item.archivedAt,
    worktreeBranch: item.worktreeBranch,
    workDir: item.workDir,
    worktreeDeletedAt: item.worktreeDeletedAt,
    workflowStatus: item.workflowStatus as UnifiedSession['workflowStatus'],
    taskId: item.kind === 'task' ? item.id : undefined,
    collectionId: item.collectionId,
    sortOrder: 0,
  };
}

function getWorktreeText(item: ArchiveItem, t: TranslateFn): string {
  if (!item.workDir) return '-';
  if (item.worktreeDeletedAt || item.worktreeStatus === 'deleted') {
    return t('archive.worktreeDeleted', { path: item.workDir });
  }
  if (item.worktreeStatus === 'missing') {
    return t('archive.worktreeMissing', { path: item.workDir });
  }
  return item.workDir;
}

function getWorktreeTone(item: ArchiveItem): string {
  if (item.worktreeDeletedAt || item.worktreeStatus === 'deleted') {
    return 'text-(--status-error-text)';
  }
  if (item.worktreeStatus === 'missing') {
    return 'text-(--status-warning-text)';
  }
  return 'text-(--text-muted)';
}

async function fetchArchivePage(args: {
  kind: ArchiveKind;
  projectFilter: string;
  query: string;
  cursor?: string | null;
}): Promise<ArchiveResponse> {
  const params = new URLSearchParams({
    projectId: args.projectFilter,
    kind: args.kind,
    limit: String(ARCHIVE_PAGE_SIZE),
  });
  if (args.query) params.set('query', args.query);
  if (args.cursor) params.set('cursor', args.cursor);

  const res = await fetch(`/api/archive?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load archive');
  return res.json() as Promise<ArchiveResponse>;
}

export function ArchiveDashboard() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<ArchiveResponse['summary'] | null>(null);
  const [chatState, setChatState] = useState<ArchiveKindState>(() => emptyArchiveKindState());
  const [taskState, setTaskState] = useState<ArchiveKindState>(() => emptyArchiveKindState());
  const [archiveProjects, setArchiveProjects] = useState<ArchiveProjectOption[]>([]);
  const [projectFilter, setProjectFilter] = useState('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMoreKind, setLoadingMoreKind] = useState<ArchiveKind | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArchiveItem | null>(null);
  const [worktreeDeleteTarget, setWorktreeDeleteTarget] = useState<ArchiveItem | null>(null);
  const [bulkWorktreeDeleteOpen, setBulkWorktreeDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { handleSessionClick } = useSessionClickHandlers();

  const loadArchive = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const responses = await Promise.all(
        (['task', 'chat'] as const).map((kind) => fetchArchivePage({ kind, projectFilter, query: deferredQuery })),
      );
      const nextChat = responses.find((response) => response.pagination.kind === 'chat');
      const nextTask = responses.find((response) => response.pagination.kind === 'task');

      setSummary(responses[0]?.summary ?? null);
      setArchiveProjects(responses[0]?.projects ?? []);
      setChatState(nextChat
        ? {
          items: nextChat.items,
          nextCursor: nextChat.pagination.nextCursor,
          total: nextChat.pagination.total,
        }
        : emptyArchiveKindState());
      setTaskState(nextTask
        ? {
          items: nextTask.items,
          nextCursor: nextTask.pagination.nextCursor,
          total: nextTask.pagination.total,
        }
        : emptyArchiveKindState());
    } catch (err) {
      console.error(err);
      setError(t('archive.errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [deferredQuery, projectFilter, t]);

  useEffect(() => {
    void loadArchive();
  }, [loadArchive]);

  const {
    settings,
    updateSettings,
    retentionConfirmDialog,
  } = useWorktreeRetentionSettingsUpdate({ onApplied: loadArchive });

  const chatItems = chatState.items;
  const taskItems = taskState.items;

  const loadMore = useCallback(async (kind: ArchiveKind) => {
    const cursor = kind === 'chat' ? chatState.nextCursor : taskState.nextCursor;
    if (!cursor) return;

    setLoadingMoreKind(kind);
    setError(null);
    try {
      const response = await fetchArchivePage({ kind, projectFilter, query: deferredQuery, cursor });
      setSummary(response.summary);
      if (kind === 'chat') {
        setChatState((current) => ({
          items: [...current.items, ...response.items],
          nextCursor: response.pagination.nextCursor,
          total: response.pagination.total,
        }));
      } else {
        setTaskState((current) => ({
          items: [...current.items, ...response.items],
          nextCursor: response.pagination.nextCursor,
          total: response.pagination.total,
        }));
      }
    } catch (err) {
      console.error(err);
      setError(t('archive.errors.loadFailed'));
    } finally {
      setLoadingMoreKind(null);
    }
  }, [chatState.nextCursor, deferredQuery, projectFilter, taskState.nextCursor, t]);

  const openItem = useCallback(async (item: ArchiveItem, sessionId?: string) => {
    const session = primarySessionFromItem({
      ...item,
      sessions: sessionId
        ? [...item.sessions].sort((a) => (a.id === sessionId ? -1 : 1))
        : item.sessions,
    });
    if (!session) return;
    useSessionStore.getState().upsertSession(session);
    await handleSessionClick(session);
  }, [handleSessionClick]);

  const restoreItem = useCallback(async (item: ArchiveItem) => {
    const endpoint = item.kind === 'task'
      ? `/api/archive/tasks/${item.id}`
      : `/api/sessions/${item.id}/archive`;
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? t('archive.errors.restoreFailed'));
      return;
    }
    await Promise.all([
      loadArchive(),
      useSessionStore.getState().loadProjects(),
    ]);
    if (item.kind === 'task') {
      await useTaskStore.getState().loadTasks(item.projectId, { setCurrent: false });
    }
  }, [loadArchive, t]);

  const deleteItem = useCallback(async (item: ArchiveItem) => {
    const endpoint = item.kind === 'task'
      ? `/api/archive/tasks/${item.id}`
      : `/api/sessions/${item.id}`;
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      const message = body.error ?? t('archive.errors.deleteFailed');
      setError(message);
      throw new Error(message);
    }
    await Promise.all([
      loadArchive(),
      useSessionStore.getState().loadProjects(),
    ]);
  }, [loadArchive, t]);

  const deleteWorktreeOnly = useCallback(async (item: ArchiveItem) => {
    if (item.kind !== 'task') return;
    const res = await fetch(`/api/archive/tasks/${item.id}/worktree`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      const message = body.error ?? t('archive.errors.deleteWorktreeFailed');
      setError(message);
      throw new Error(message);
    }
    await Promise.all([
      loadArchive(),
      useSessionStore.getState().loadProjects(),
    ]);
  }, [loadArchive, t]);

  const confirmDeleteItem = useCallback(async () => {
    if (!deleteTarget) return;
    await deleteItem(deleteTarget);
    setDeleteTarget(null);
  }, [deleteItem, deleteTarget]);

  const confirmDeleteWorktree = useCallback(async () => {
    if (!worktreeDeleteTarget) return;
    await deleteWorktreeOnly(worktreeDeleteTarget);
    setWorktreeDeleteTarget(null);
  }, [deleteWorktreeOnly, worktreeDeleteTarget]);

  const confirmDeleteAllWorktrees = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectFilter !== 'all') params.set('projectId', projectFilter);
    if (deferredQuery) params.set('query', deferredQuery);

    const queryString = params.toString();
    const res = await fetch(`/api/archive/worktrees${queryString ? `?${queryString}` : ''}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({})) as { error?: string; result?: WorktreeDeleteResult };
    if (!res.ok) {
      const message = body.error ?? t('archive.errors.deleteWorktreeFailed');
      setError(message);
      throw new Error(message);
    }

    await Promise.all([
      loadArchive(),
      useSessionStore.getState().loadProjects(),
    ]);
    setBulkWorktreeDeleteOpen(false);

    if (body.result?.errors.length) {
      setError(t('archive.errors.bulkPartial', {
        removed: body.result.removed,
        errors: body.result.errors.length,
      }));
    } else {
      setError(null);
    }
  }, [deferredQuery, loadArchive, projectFilter, t]);

  const visibleItemCount = taskItems.length + chatItems.length;
  const hasNoResults = !isLoading && visibleItemCount === 0;
  const loadedItems = [...taskItems, ...chatItems];
  const loadedWorktreesPresent = loadedItems.filter((item) => item.worktreeStatus === 'present').length;
  const loadedWorktreesDeleted = loadedItems.filter((item) => item.worktreeStatus === 'deleted').length;
  const loadedWorktreesMissing = loadedItems.filter((item) => item.worktreeStatus === 'missing').length;
  const selectedProjectLabel = projectFilter === 'all'
    ? t('archive.allProjects')
    : archiveProjects.find((project) => project.id === projectFilter)?.displayName ?? projectFilter;

  return (
    <div className="h-full overflow-y-auto bg-(--board-bg)">
      <header className="sticky top-0 z-10 border-b border-(--divider) bg-(--chat-header-bg)">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-(--divider) bg-(--board-card-bg)">
              <Archive className="h-[18px] w-[18px] text-(--accent)" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold text-(--text-primary)">{t('archive.title')}</h1>
              <p className="text-xs text-(--text-muted)">{t('archive.description')}</p>
            </div>
            <button
              onClick={loadArchive}
              className="inline-flex items-center gap-1.5 rounded-lg border border-(--divider) px-3 py-1.5 text-xs text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('archive.refresh')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-[360px] sm:w-[360px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--text-muted)" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('archive.searchPlaceholder')}
                className="h-8 w-full rounded-lg border border-(--input-border) bg-(--input-bg) pl-8 pr-2.5 text-xs text-(--text-primary) outline-none focus:border-(--accent)"
              />
            </div>
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              className="ml-auto h-8 rounded-lg border border-(--input-border) bg-(--input-bg) px-2.5 text-xs text-(--text-primary) outline-none focus:border-(--accent)"
            >
              <option value="all">{t('archive.allProjects')}</option>
              {archiveProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.visible ? project.displayName : `${project.displayName} ${t('archive.closedSuffix')}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] space-y-4 px-6 py-5">
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--divider) bg-(--board-card-bg) p-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-(--text-muted)">
            <span>{settings.autoDeleteArchivedWorktrees ? t('archive.autoDeleteOn') : t('archive.autoDeleteOff')}</span>
            <span>{t('archive.retentionInfo', { days: settings.archivedWorktreeRetentionDays })}</span>
            <span>{t('archive.loadedCount', { loaded: visibleItemCount, total: summary?.total ?? 0 })}</span>
            <span>{t('archive.worktreesPresent', { count: loadedWorktreesPresent })}</span>
            <span>{t('archive.worktreesDeleted', { count: loadedWorktreesDeleted })}</span>
            <span>{t('archive.worktreesMissing', { count: loadedWorktreesMissing })}</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-1.5 text-xs text-(--text-muted)">
              <input
                type="checkbox"
                checked={settings.autoDeleteArchivedWorktrees}
                onChange={(event) => void updateSettings({ autoDeleteArchivedWorktrees: event.target.checked })}
                className="accent-(--accent)"
              />
              {t('archive.autoLabel')}
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={settings.archivedWorktreeRetentionDays}
              onChange={(event) => void updateSettings({ archivedWorktreeRetentionDays: Math.max(1, Number(event.target.value) || 1) })}
              className="h-7 w-16 rounded-md border border-(--input-border) bg-(--input-bg) px-2 text-xs text-(--text-primary) outline-none"
            />
            <button
              onClick={() => setBulkWorktreeDeleteOpen(true)}
              disabled={isLoading || visibleItemCount === 0}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--status-error-text)_32%,var(--divider))] bg-[color-mix(in_srgb,var(--status-error-text)_8%,transparent)] px-2.5 text-xs font-medium text-(--status-error-text) transition-colors hover:bg-(--status-error-bg) disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderX className="h-3.5 w-3.5" />
              {t('archive.deleteAllWorktrees')}
            </button>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-(--status-error-border) bg-(--status-error-bg) px-3 py-2 text-xs text-(--status-error-text)">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="py-20 text-center text-sm text-(--text-muted)">{t('archive.loading')}</div>
        ) : hasNoResults ? (
          <div className="rounded-xl border border-dashed border-(--divider) py-20 text-center text-sm text-(--text-muted)">
            {t('archive.empty')}
          </div>
        ) : (
          <div className="space-y-6">
            <ArchiveSection title={t('archive.sections.tasks')} count={taskState.total}>
              <TaskArchiveTable
                items={taskItems}
                onOpenSession={openItem}
                onRestore={restoreItem}
                onDelete={setDeleteTarget}
                onDeleteWorktree={setWorktreeDeleteTarget}
                t={t}
              />
              <ArchiveLoadMore
                loaded={taskItems.length}
                total={taskState.total}
                isLoading={loadingMoreKind === 'task'}
                onClick={() => void loadMore('task')}
                t={t}
              />
            </ArchiveSection>

            <ArchiveSection title={t('archive.sections.chats')} count={chatState.total}>
              <ChatArchiveTable
                items={chatItems}
                onOpen={openItem}
                onRestore={restoreItem}
                onDelete={setDeleteTarget}
                t={t}
              />
              <ArchiveLoadMore
                loaded={chatItems.length}
                total={chatState.total}
                isLoading={loadingMoreKind === 'chat'}
                onClick={() => void loadMore('chat')}
                t={t}
              />
            </ArchiveSection>
          </div>
        )}
      </main>

      <AsyncConfirmDialog
        open={deleteTarget !== null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteItem}
        title={deleteTarget?.kind === 'task' ? t('archive.dialog.deleteTaskTitle') : t('archive.dialog.deleteChatTitle')}
        icon={Trash2}
        cancelLabel={t('archive.dialog.cancel')}
        confirmLabel={t('archive.dialog.deleteAction')}
        confirmingLabel={t('archive.dialog.deleting')}
        iconContainerClassName="bg-(--error)/10"
        iconClassName="text-(--error)"
        confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
        dialogTestId="archive-delete-dialog"
        confirmTestId="archive-delete-confirm"
        errorLogLabel="Archive delete error:"
        description={(
          <>
            <p className="text-(--text-primary)">
              {deleteTarget
                ? t('archive.dialog.deleteDescription', { title: deleteTarget.title })
                : t('archive.dialog.deleteDescriptionDefault')}
            </p>
            <p className="mt-2 text-sm text-(--text-muted)">
              {t('archive.dialog.deleteWarning')}
            </p>
          </>
        )}
      />

      <AsyncConfirmDialog
        open={worktreeDeleteTarget !== null}
        onCancel={() => setWorktreeDeleteTarget(null)}
        onConfirm={confirmDeleteWorktree}
        title={t('archive.dialog.deleteWorktreeTitle')}
        icon={FolderX}
        cancelLabel={t('archive.dialog.cancel')}
        confirmLabel={t('archive.dialog.deleteWorktreeAction')}
        confirmingLabel={t('archive.dialog.deleting')}
        iconContainerClassName="bg-(--error)/10"
        iconClassName="text-(--error)"
        confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
        dialogTestId="archive-worktree-delete-dialog"
        confirmTestId="archive-worktree-delete-confirm"
        errorLogLabel="Archive worktree delete error:"
        description={(
          <>
            <p className="text-(--text-primary)">
              {worktreeDeleteTarget
                ? t('archive.dialog.deleteWorktreeDescription', { title: worktreeDeleteTarget.title })
                : t('archive.dialog.deleteWorktreeDescriptionDefault')}
            </p>
            {worktreeDeleteTarget?.workDir && (
              <p className="mt-2 break-all font-mono text-xs text-(--text-muted)">
                {worktreeDeleteTarget.workDir}
              </p>
            )}
            <p className="mt-2 text-sm text-(--text-muted)">
              {t('archive.dialog.deleteWorktreeNote')}
            </p>
          </>
        )}
      />

      <AsyncConfirmDialog
        open={bulkWorktreeDeleteOpen}
        onCancel={() => setBulkWorktreeDeleteOpen(false)}
        onConfirm={confirmDeleteAllWorktrees}
        title={t('archive.dialog.deleteAllWorktreesTitle')}
        icon={FolderX}
        cancelLabel={t('archive.dialog.cancel')}
        confirmLabel={t('archive.dialog.deleteAllWorktreesAction')}
        confirmingLabel={t('archive.dialog.deleting')}
        iconContainerClassName="bg-(--error)/10"
        iconClassName="text-(--error)"
        confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
        dialogTestId="archive-worktree-delete-all-dialog"
        confirmTestId="archive-worktree-delete-all-confirm"
        errorLogLabel="Archive bulk worktree delete error:"
        description={(
          <>
            <p className="text-(--text-primary)">
              {t('archive.dialog.deleteAllWorktreesDescription')}
            </p>
            <p className="mt-2 text-sm text-(--text-muted)">
              {t('archive.dialog.filterProject', { project: selectedProjectLabel })}
              {deferredQuery ? t('archive.dialog.filterSearch', { query: deferredQuery }) : ''}
            </p>
            <p className="mt-2 text-sm text-(--text-muted)">
              {t('archive.dialog.deleteAllWorktreesNote')}
            </p>
          </>
        )}
      />
      {retentionConfirmDialog}
    </div>
  );
}

function ArchiveSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-(--text-primary)">{title}</h2>
        <span className="text-xs text-(--text-muted)">{count}</span>
        <div className="h-px flex-1 bg-(--divider)" />
      </div>
      {children}
    </section>
  );
}

function ArchiveLoadMore({
  loaded,
  total,
  isLoading,
  onClick,
  t,
}: {
  loaded: number;
  total: number;
  isLoading: boolean;
  onClick: () => void;
  t: TranslateFn;
}) {
  if (loaded >= total) return null;

  return (
    <div className="flex items-center justify-center border-x border-b border-(--divider) bg-(--board-card-bg) px-3 py-2">
      <button
        onClick={onClick}
        disabled={isLoading}
        className="rounded-lg border border-(--divider) px-3 py-1.5 text-xs text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:opacity-50"
      >
        {isLoading ? t('archive.loadingMore') : t('archive.loadMore', { loaded, total })}
      </button>
    </div>
  );
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-(--divider) bg-(--board-card-bg)">
      <div className="max-h-[420px] overflow-auto">
        {children}
      </div>
    </div>
  );
}

function EmptyTableRow({ colSpan, t }: { colSpan: number; t: TranslateFn }) {
  return (
    <tr>
      <td colSpan={colSpan} className="h-16 px-3 text-center text-xs text-(--text-muted)">
        {t('archive.emptyTable')}
      </td>
    </tr>
  );
}

function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {children}
    </div>
  );
}

function ActionButton({
  children,
  tone = 'neutral',
  onClick,
  title,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'primary' | 'danger' | 'dangerOutline';
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
        tone === 'primary'
          ? 'border-[color-mix(in_srgb,var(--accent)_28%,var(--divider))] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--accent) hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]'
          : tone === 'dangerOutline'
            ? 'border-[color-mix(in_srgb,var(--status-error-text)_32%,var(--divider))] bg-[color-mix(in_srgb,var(--status-error-text)_8%,transparent)] text-(--status-error-text) hover:bg-(--status-error-bg)'
          : tone === 'danger'
            ? 'border-transparent bg-transparent text-(--status-error-text) hover:bg-(--status-error-bg)'
            : 'border-transparent bg-transparent text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
      )}
    >
      {children}
    </button>
  );
}

function ChatArchiveTable({
  items,
  onOpen,
  onRestore,
  onDelete,
  t,
}: {
  items: ArchiveItem[];
  onOpen: (item: ArchiveItem, sessionId?: string) => void;
  onRestore: (item: ArchiveItem) => void;
  onDelete: (item: ArchiveItem) => void;
  t: TranslateFn;
}) {
  return (
    <TableShell>
      <table className="min-w-[820px] w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col />
          <col className="w-[220px]" />
          <col className="w-[130px]" />
          <col className="w-[150px]" />
        </colgroup>
        <thead>
          <tr className="whitespace-nowrap border-b border-(--divider) bg-(--chat-header-bg) text-left text-[0.6875rem] uppercase tracking-wide text-(--text-muted)">
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.title')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.project')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.archived')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 text-right font-semibold">{t('archive.columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyTableRow colSpan={4} t={t} />
          ) : items.map((item) => (
            <tr
              key={item.id}
              className="group border-b border-(--divider) last:border-b-0 hover:bg-(--sidebar-hover)"
              data-testid={`archive-chat-row-${item.id}`}
            >
              <td className="h-10 min-w-0 px-3">
                <button
                  onClick={() => onOpen(item)}
                  className="block max-w-full truncate text-left font-medium text-(--text-primary) hover:underline"
                  title={item.title}
                >
                  {item.title}
                </button>
              </td>
              <td className="h-10 min-w-0 px-3 text-(--text-muted)">
                <span className="block truncate">{item.projectName}</span>
              </td>
              <td className="h-10 px-3 text-(--text-muted)">
                {formatRelativeTime(item.archivedAt, t)}
              </td>
              <td className="h-10 px-3">
                <RowActions>
                  {item.canRestore && (
                    <ActionButton tone="primary" onClick={() => onRestore(item)}>
                      <RotateCcw className="h-3 w-3" />
                      {t('archive.actions.restore')}
                    </ActionButton>
                  )}
                  <ActionButton tone="dangerOutline" onClick={() => onDelete(item)}>
                    <Trash2 className="h-3 w-3" />
                    {t('archive.actions.delete')}
                  </ActionButton>
                </RowActions>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function TaskArchiveTable({
  items,
  onOpenSession,
  onRestore,
  onDelete,
  onDeleteWorktree,
  t,
}: {
  items: ArchiveItem[];
  onOpenSession: (item: ArchiveItem, sessionId: string) => void;
  onRestore: (item: ArchiveItem) => void;
  onDelete: (item: ArchiveItem) => void;
  onDeleteWorktree: (item: ArchiveItem) => void;
  t: TranslateFn;
}) {
  return (
    <TableShell>
      <table className="min-w-[930px] w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col />
          <col className="w-[220px]" />
          <col className="w-[150px]" />
          <col className="w-[100px]" />
          <col className="w-[320px]" />
        </colgroup>
        <thead>
          <tr className="whitespace-nowrap border-b border-(--divider) bg-(--chat-header-bg) text-left text-[0.6875rem] uppercase tracking-wide text-(--text-muted)">
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.taskSession')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.worktree')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.project')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 font-semibold">{t('archive.columns.archived')}</th>
            <th className="sticky top-0 z-10 h-8 bg-(--chat-header-bg) px-3 text-right font-semibold">{t('archive.columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyTableRow colSpan={5} t={t} />
          ) : items.map((item) => {
            const hasMultipleSessions = item.sessions.length > 1;
            const singleSession = !hasMultipleSessions ? item.sessions[0] : null;
            return (
              <tr
                key={item.id}
                className="border-b border-(--divider) last:border-b-0 hover:bg-(--sidebar-hover)"
                data-testid={`archive-task-row-${item.id}`}
              >
                <td className="min-w-0 px-3 py-2 align-top">
                  {singleSession ? (
                    <button
                      onClick={() => onOpenSession(item, singleSession.id)}
                      className="block max-w-full truncate text-left font-medium text-(--text-primary) hover:underline"
                      title={item.title}
                    >
                      {item.title}
                    </button>
                  ) : (
                    <>
                      <div
                        className="max-w-full truncate font-medium text-(--text-primary)"
                        title={item.title}
                      >
                        {item.title}
                      </div>
                      <ul className="mt-1.5 space-y-0.5 border-l border-(--divider) pl-2.5">
                        {item.sessions.map((session) => (
                          <li key={session.id} data-testid={`archive-task-session-row-${session.id}`}>
                            <button
                              onClick={() => onOpenSession(item, session.id)}
                              className="block w-full max-w-full truncate text-left text-[0.6875rem] text-(--text-secondary) hover:text-(--text-primary) hover:underline"
                              title={session.title}
                            >
                              {session.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </td>
                <td className={cn('min-w-0 px-3 py-2 align-top font-mono text-[0.6875rem]', getWorktreeTone(item))}>
                  <span className="block truncate" title={getWorktreeText(item, t)}>{getWorktreeText(item, t)}</span>
                </td>
                <td className="min-w-0 px-3 py-2 align-top text-(--text-muted)">
                  <span className="block truncate">{item.projectName}</span>
                </td>
                <td className="px-3 py-2 align-top text-(--text-muted)">
                  {formatRelativeTime(item.archivedAt, t)}
                </td>
                <td className="px-3 py-2 align-top">
                  <RowActions>
                    {item.canRestore && (
                      <ActionButton tone="primary" onClick={() => onRestore(item)}>
                        <RotateCcw className="h-3 w-3" />
                        {t('archive.actions.restore')}
                      </ActionButton>
                    )}
                    {item.worktreeStatus === 'present' && (
                      <ActionButton tone="dangerOutline" onClick={() => onDeleteWorktree(item)} title={t('archive.actions.deleteWorktreeTooltip')}>
                        <FolderX className="h-3 w-3" />
                        {t('archive.actions.deleteWorktree')}
                      </ActionButton>
                    )}
                    <ActionButton tone="dangerOutline" onClick={() => onDelete(item)}>
                      <Trash2 className="h-3 w-3" />
                      {t('archive.actions.delete')}
                    </ActionButton>
                  </RowActions>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableShell>
  );
}
