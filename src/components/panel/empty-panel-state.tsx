'use client';

import { useState, useCallback, useContext, useEffect, useMemo, useRef, type DragEvent, type MouseEvent } from 'react';
import { X as XIcon, KeyboardIcon, FolderGit2, ListTodo, MessageSquare, AlertCircle, GripVertical, Plus, Terminal } from 'lucide-react';
import { usePanelStore, TabIdContext, EMPTY_PANELS } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useBoardStore } from '@/stores/board-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useWorktreeBaseRefs } from '@/hooks/use-worktree-base-refs';
import { useWorktreeSession } from '@/hooks/use-worktree-session';
import { WorktreeStartFromControl } from '@/components/task/worktree-start-from-control';
import { useI18n } from '@/lib/i18n';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import {
  buildManagedWorktreeBranchName,
  buildManagedWorktreePreviewPath,
  buildManagedWorktreeSlug,
  isManagedWorktreeSlugInputAllowed,
  normalizeManagedWorktreeBranchPrefix,
  normalizeManagedWorktreeSlug,
} from '@/lib/worktrees/naming';
import { CliProviderChipSelector } from '@/components/chat/cli-provider-chip-selector';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useProvidersStore } from '@/stores/providers-store';
import { useFolderBrowserStore } from '@/stores/folder-browser-store';
import type { Collection } from '@/types/collection';
import { setPanelNodeDragData } from '@/lib/dnd/panel-session-drag';
import { v4 as uuidv4 } from 'uuid';

interface EmptyPanelStateProps {
  panelId: string;
}

const EMPTY_COLLECTIONS: Collection[] = [];

export function EmptyPanelState({ panelId }: EmptyPanelStateProps) {
  const { t } = useI18n();
  const tabId = useContext(TabIdContext);
  const setActivePanelId = usePanelStore((state) => state.setActivePanelId);
  const closePanel = usePanelStore((state) => state.closePanel);
  const assignTerminal = usePanelStore((state) => state.assignTerminal);
  const isActivePanel = usePanelStore((state) => state.tabPanels[tabId]?.activePanelId === panelId);
  const panelCount = usePanelStore((state) => Object.keys(state.tabPanels[tabId]?.panels ?? EMPTY_PANELS).length);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const branchPrefix = useSettingsStore((state) => state.settings.gitConfig.branchPrefix);
  const pathTemplate = useSettingsStore((state) => state.settings.managedWorktreePathTemplate);
  const providers = useProvidersStore((state) => state.providers);
  const { createSession, isCreating } = useSessionCrud();
  const { createWorktreeSession } = useWorktreeSession();
  const openFolderBrowser = useFolderBrowserStore((state) => state.open);

  const activeProject = useSessionStore((state) => {
    if (selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL) {
      return state.projects.find((project) => project.encodedDir === selectedProjectDir) ?? null;
    }
    const selectionSessionId = getSessionSelectionId(state.activeSessionId);
    if (selectionSessionId) {
      return state.projects.find((project) =>
        project.sessions.some((session) => session.id === selectionSessionId)
      ) ?? null;
    }
    return state.projects[0] ?? null;
  });
  const activeProjectId = activeProject?.encodedDir ?? null;
  const collections = useCollectionStore((state) =>
    activeProjectId ? state.collectionsByProject?.[activeProjectId] ?? EMPTY_COLLECTIONS : EMPTY_COLLECTIONS
  );

  const [selectedProvider, setSelectedProvider] = useState('');
  const [mode, setMode] = useState<'chat' | 'task'>('chat');
  const [rawSelectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [branchSlug, setBranchSlug] = useState(() => buildManagedWorktreeSlug());
  const [branchSlugEdited, setBranchSlugEdited] = useState(false);
  const [isSubmittingTask, setIsSubmittingTask] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const connectedProviders = useMemo(
    () => (providers ?? []).filter((provider) => provider.status === 'connected'),
    [providers],
  );
  const isSelectedProviderReady = connectedProviders.some(
    (provider) => provider.id === selectedProvider,
  );

  useEffect(() => {
    if (!activeProjectId) return;
    void useCollectionStore.getState().loadCollections(activeProjectId);
  }, [activeProjectId]);

  // Derive: clear selection if collection no longer exists
  const selectedCollectionId =
    rawSelectedCollectionId !== null && collections.some((c) => c.id === rawSelectedCollectionId)
      ? rawSelectedCollectionId
      : null;
  const {
    refs: baseRefs,
    selectedBaseRef,
    selectedBaseRefForCreate,
    selectedRef,
    setSelectedBaseRef,
    isLoading: isLoadingBaseRefs,
    error: baseRefError,
  } = useWorktreeBaseRefs(mode === 'task' ? activeProject?.decodedPath : null);

  const handleSetModeTask = useCallback((_e: MouseEvent) => {
    setMode('task');
    // Focus the title input after React commits the DOM update
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }, []);

  const handleClose = useCallback(() => {
    closePanel(panelId);
  }, [closePanel, panelId]);

  const handlePanelDragStart = useCallback((event: DragEvent<HTMLButtonElement>) => {
    const didSet = setPanelNodeDragData(event.dataTransfer, { tabId, panelId });
    if (!didSet) {
      event.preventDefault();
    }
  }, [panelId, tabId]);

  const handleLaunch = useCallback(async () => {
    if (!activeProject) {
      setError(t('task.worktree.errorNoProject'));
      return;
    }
    if (!isSelectedProviderReady) {
      setError('Install or log in to an AI CLI before creating a session.');
      return;
    }

    setError(null);
    setActivePanelId(panelId);

    if (mode === 'chat') {
      await createSession({
        workDir: activeProject.decodedPath,
        providerId: selectedProvider,
        collectionId: selectedCollectionId ?? undefined,
      });
      return;
    }

    setIsSubmittingTask(true);
    try {
      const trimmedTaskTitle = taskTitle.trim();
      const rawBranchSlug = branchSlug.trim();
      if (!isManagedWorktreeSlugInputAllowed(rawBranchSlug)) {
        setError(t('task.creation.errorInvalidBranchSlug'));
        return;
      }
      const normalizedBranchSlug = normalizeManagedWorktreeSlug(rawBranchSlug);
      if (!normalizedBranchSlug) {
        setError(t('task.creation.errorEmptyBranchSlug'));
        return;
      }
      const result = await createWorktreeSession({
        projectDir: activeProject.decodedPath,
        parentProjectId: activeProject.encodedDir,
        providerId: selectedProvider,
        taskTitle: trimmedTaskTitle || t('task.creation.title'),
        hasCustomTitle: trimmedTaskTitle.length > 0,
        branchSlug: normalizedBranchSlug,
        baseRef: selectedBaseRefForCreate,
        allowBranchSlugSuffix: !branchSlugEdited,
        suppressErrorToast: true,
        collectionId: selectedCollectionId ?? undefined,
      });
      if (!result.ok) {
        setError(
          result.code === 'name_unavailable'
            ? t('task.creation.errorBranchSlugTaken')
            : result.error ?? t('errors.unknownError')
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.unknownError');
      setError(message);
    } finally {
      setIsSubmittingTask(false);
    }
  }, [
    activeProject,
    createSession,
    createWorktreeSession,
    isSelectedProviderReady,
    mode,
    panelId,
    selectedCollectionId,
    selectedBaseRefForCreate,
    selectedProvider,
    setActivePanelId,
    t,
    branchSlug,
    branchSlugEdited,
    taskTitle,
  ]);

  const handleOpenTerminal = useCallback(() => {
    setError(null);
    setActivePanelId(panelId);
    assignTerminal(panelId, uuidv4());
  }, [assignTerminal, panelId, setActivePanelId]);

  useEffect(() => {
    if (!isActivePanel) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!isCreating && !isSubmittingTask) {
          void handleLaunch();
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleLaunch, isActivePanel, isCreating, isSubmittingTask]);

  const isSubmitting = isCreating || isSubmittingTask;
  const isLaunchDisabled = isSubmitting || !activeProject || !isSelectedProviderReady;
  const branchPreview = activeProject
    ? buildManagedWorktreeBranchName(branchSlug, branchPrefix)
    : '';
  const worktreePathPreview = activeProject
    ? buildManagedWorktreePreviewPath(activeProject.decodedPath, branchPrefix, branchSlug, pathTemplate)
    : '';
  const normalizedBranchPrefix = normalizeManagedWorktreeBranchPrefix(branchPrefix);
  const panelControls = panelCount >= 2 ? (
    <>
      <button
        type="button"
        draggable
        onDragStart={handlePanelDragStart}
        title={t('panel.movePanel')}
        aria-label={t('panel.movePanel')}
        data-testid="empty-panel-drag-handle"
        className="absolute left-3 top-3 cursor-grab rounded p-1.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        title={t('panel.closePanel')}
        aria-label={t('panel.closePanel')}
        data-testid="empty-panel-close-button"
        className="absolute right-3 top-3 rounded p-1.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </>
  ) : null;

  if (!activeProject) {
    return (
      <div
        className="relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden bg-(--chat-bg) px-6 py-10 text-(--text-muted)"
        data-testid="empty-panel-state"
        data-panel-id={panelId}
      >
        {panelControls}

        <div className="mx-auto max-w-md text-center" data-testid="empty-panel-import-project-state">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-(--divider) bg-(--sidebar-bg) text-(--text-muted)">
            <FolderGit2 className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-(--text-primary)">
            {t('sidebar.noProjects')}
          </h2>
          <p className="mt-2 text-sm leading-6 text-(--text-secondary)">
            {t('sidebar.runFromProject')}
          </p>
          <button
            type="button"
            onClick={openFolderBrowser}
            className="mt-5 inline-flex items-center gap-2 rounded-full border border-(--divider) bg-(--sidebar-bg) px-3 py-1.5 text-xs font-medium text-(--text-secondary) transition-colors hover:border-(--accent) hover:text-(--accent-hover) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            data-testid="empty-panel-add-project"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('projectStrip.addProject')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 items-start justify-center overflow-x-hidden overflow-y-auto bg-(--chat-bg) px-6 pb-10 pt-10 text-(--text-muted)"
      data-testid="empty-panel-state"
      data-panel-id={panelId}
    >
      {panelControls}

      <div className="mx-auto w-full max-w-3xl">
        <div className="border-y border-(--divider)">
          <section className="py-5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
              {t('settings.provider.label')}
            </span>
            <div className="mt-3">
              <CliProviderChipSelector
                value={selectedProvider}
                onChange={setSelectedProvider}
                className="gap-1.5"
                chipClassName="px-2.5 py-1 text-[10px]"
              />
            </div>
          </section>

          <section className="border-t border-(--divider) py-5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
              {t('task.creation.startAsLabel')}
            </span>

            <div className="mt-3 grid max-w-md grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setMode('chat')}
                className={cn(
                  'rounded-2xl border px-4 py-3 text-left transition-colors',
                  mode === 'chat'
                    ? 'border-[color-mix(in_srgb,var(--accent)_24%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                    : 'border-(--divider) bg-transparent hover:border-(--accent)/16 hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
                )}
                data-testid="empty-panel-mode-chat"
              >
                <MessageSquare className="h-4 w-4 text-(--accent-hover)" />
                <span className="mt-2 block text-sm font-semibold text-(--text-primary)">
                  {t('task.newChat.chat')}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-(--text-muted)">
                  {t('task.creation.chatInstantHint')}
                </span>
              </button>

              <button
                type="button"
                onClick={handleSetModeTask}
                className={cn(
                  'rounded-2xl border px-4 py-3 text-left transition-colors',
                  mode === 'task'
                    ? 'border-[color-mix(in_srgb,var(--accent)_24%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                    : 'border-(--divider) bg-transparent hover:border-(--accent)/16 hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
                )}
                data-testid="empty-panel-mode-task"
              >
                <ListTodo className="h-4 w-4 text-(--accent-hover)" />
                <span className="mt-2 block text-sm font-semibold text-(--text-primary)">
                  {t('task.newChat.newTask')}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-(--text-muted)">
                  {t('task.creation.taskWorktreeHint')}
                </span>
              </button>

              <button
                type="button"
                onClick={handleOpenTerminal}
                className="rounded-2xl border border-(--divider) bg-transparent px-4 py-3 text-left transition-colors hover:border-(--accent)/16 hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]"
                data-testid="empty-panel-mode-terminal"
              >
                <Terminal className="h-4 w-4 text-(--accent-hover)" />
                <span className="mt-2 block text-sm font-semibold text-(--text-primary)">
                  Terminal
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-(--text-muted)">
                  Open a shell here.
                </span>
              </button>
            </div>

            <div className="mt-5 space-y-4 border-l-2 border-[color-mix(in_srgb,var(--accent)_16%,transparent)] pl-4">
              {mode === 'task' && (
                <>
                  <div className="space-y-1.5">
                    <label
                      htmlFor={`empty-panel-task-title-${panelId}`}
                      className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)"
                    >
                      {t('task.creation.titleLabel')}
                    </label>
                    <input
                      ref={titleInputRef}
                      id={`empty-panel-task-title-${panelId}`}
                      type="text"
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !isSubmitting) {
                          event.preventDefault();
                          void handleLaunch();
                        }
                      }}
                      placeholder={t('task.creation.titlePlaceholder')}
                      className="w-full rounded-xl border border-(--divider) bg-(--input-bg) px-3 py-2.5 text-sm text-(--sidebar-text-active) outline-none transition-colors placeholder:text-(--text-muted) focus:border-(--accent)"
                      data-testid="empty-panel-task-title-input"
                    />
                  </div>

                  {activeProject && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`empty-panel-branch-slug-${panelId}`}
                        className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)"
                      >
                        {t('task.creation.branchPreviewLabel')}
                      </label>
                      <div className="flex items-center gap-2 rounded-xl border border-(--divider) bg-[color-mix(in_srgb,var(--accent)_4%,var(--input-bg))] px-3 py-2.5">
                        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
                        {normalizedBranchPrefix ? (
                          <span className="shrink-0 font-mono text-xs text-(--text-muted)">
                            {normalizedBranchPrefix}
                          </span>
                        ) : null}
                        <input
                          id={`empty-panel-branch-slug-${panelId}`}
                          type="text"
                          value={branchSlug}
                          onChange={(event) => {
                            setBranchSlugEdited(true);
                            setBranchSlug(event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !isSubmitting) {
                              event.preventDefault();
                              void handleLaunch();
                            }
                          }}
                          placeholder={t('task.creation.branchSlugPlaceholder')}
                          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted)"
                          data-testid="empty-panel-branch-slug-input"
                        />
                      </div>
                      <p className="truncate px-1 font-mono text-[11px] text-(--text-muted)">
                        {branchPreview}
                      </p>
                      {worktreePathPreview ? (
                        <p
                          className="truncate px-1 font-mono text-[11px] text-(--text-muted)"
                          title={worktreePathPreview}
                        >
                          {worktreePathPreview}
                        </p>
                      ) : null}
                    </div>
                  )}

                  {activeProject && (
                    <WorktreeStartFromControl
                      id={`empty-panel-base-ref-${panelId}`}
                      testId="empty-panel-base-ref"
                      refs={baseRefs}
                      selectedBaseRef={selectedBaseRef}
                      selectedRef={selectedRef}
                      isLoading={isLoadingBaseRefs}
                      error={baseRefError}
                      disabled={isSubmitting}
                      onSelectedBaseRefChange={setSelectedBaseRef}
                    />
                  )}
                </>
              )}

              <div className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
                  {t('task.creation.collectionLabel')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedCollectionId(null)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                      selectedCollectionId === null
                        ? 'border-[color-mix(in_srgb,var(--accent)_24%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--accent-hover)'
                        : 'border-(--divider) bg-(--input-bg) text-(--text-secondary) hover:border-(--text-muted)/40 hover:text-(--text-primary)',
                    )}
                  >
                    {t('task.creation.noCollection')}
                  </button>
                  {collections.map((collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      onClick={() => setSelectedCollectionId(collection.id)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                        selectedCollectionId === collection.id
                          ? 'border-[color-mix(in_srgb,var(--accent)_24%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--accent-hover)'
                          : 'border-(--divider) bg-(--input-bg) text-(--text-secondary) hover:border-(--text-muted)/40 hover:text-(--text-primary)',
                      )}
                    >
                      {collection.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="border-t border-(--divider) py-5">
              <div className="flex flex-col gap-4">
                <div className="max-w-xl text-sm leading-6 text-(--text-secondary)">
                  {mode === 'task'
                    ? t('task.creation.taskWorktreeDescription')
                    : t('task.creation.chatInstantHint')}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {isActivePanel && (
                  <div
                    className="flex items-center gap-2 text-xs text-(--text-muted)"
                    data-testid="empty-panel-keyboard-hint"
                  >
                    <KeyboardIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      <kbd className="rounded bg-(--input-bg) px-1 py-0.5 font-mono text-xs">Enter</kbd>
                      {' '}{t('common.or')}{' '}
                      <kbd className="rounded bg-(--input-bg) px-1 py-0.5 font-mono text-xs">Space</kbd>
                    </span>
                  </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void handleLaunch()}
                      disabled={isLaunchDisabled}
                      className="whitespace-nowrap rounded-full bg-(--text-primary) px-5 py-2 text-sm font-medium text-(--chat-bg) transition-colors hover:opacity-92 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid="empty-panel-create-session"
                    >
                      {isSubmitting
                        ? t('panel.creating')
                        : mode === 'task'
                          ? t('task.creation.submit')
                          : t('task.newChat.label')}
                    </button>
                  </div>
                </div>
              </div>
          </section>
        </div>

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="mt-4 p-3 rounded-lg bg-[color-mix(in_srgb,var(--error)_8%,transparent)] border border-[color:var(--error)]/30 animate-fade-in"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-[color:var(--error)] shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-[color:var(--error)] leading-tight">
                  {t('errors.title') || 'Error'}
                </p>
                <p className="text-xs text-[color:var(--error)]/75 mt-1 break-words">
                  {error}
                </p>
              </div>
              <button
                onClick={() => setError(null)}
                aria-label={t('common.close') || 'Close'}
                className="text-[color:var(--error)]/50 hover:text-[color:var(--error)] shrink-0 transition-colors"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
