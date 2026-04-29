'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FolderGit2, MessageSquare, ListTodo, X as XIcon } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useWorktreeSession } from '@/hooks/use-worktree-session';
import {
  buildManagedWorktreePreviewPath,
  buildManagedWorktreeSlug,
  isManagedWorktreeSlugInputAllowed,
  normalizeManagedWorktreeBranchPrefix,
  normalizeManagedWorktreeSlug,
} from '@/lib/worktrees/naming';
import { useSettingsStore } from '@/stores/settings-store';
import type { Collection } from '@/types/collection';
import type { WorkflowStatus } from '@/types/task-entity';
import { CliProviderChipSelector } from './cli-provider-chip-selector';

type QuickCreateMode = 'chat' | 'task';
type QuickCreatePlacement = 'side' | 'top';

interface CollectionQuickCreateSheetProps {
  collection: Collection | null;
  collections?: Collection[];
  projectDir: string;
  projectId: string;
  initialMode?: QuickCreateMode;
  availableModes?: QuickCreateMode[];
  workflowStatus?: WorkflowStatus;
  allowCollectionSelection?: boolean;
  className?: string;
  scopeId?: string;
  onClose: () => void;
  allowedModes?: Array<'chat' | 'task'>;
  boundaryRef?: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorPlacement?: QuickCreatePlacement;
  continuationSourceTitle?: string;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

const ANCHORED_SHEET_WIDTH = 272;
const ANCHORED_SHEET_GAP = 8;
const ANCHORED_VIEWPORT_MARGIN = 12;

export function CollectionQuickCreateSheet({
  collection,
  collections = [],
  projectDir,
  projectId,
  initialMode = 'chat',
  availableModes = ['chat', 'task'],
  workflowStatus,
  allowCollectionSelection = false,
  className,
  scopeId,
  onClose,
  allowedModes = ['chat', 'task'],
  boundaryRef,
  anchorRef,
  anchorPlacement = 'side',
  continuationSourceTitle,
  onSessionCreated,
}: CollectionQuickCreateSheetProps) {
  const { t } = useI18n();
  const { createSession } = useSessionCrud();
  const { createWorktreeSession } = useWorktreeSession();
  const branchPrefix = useSettingsStore((state) => state.settings.gitConfig.branchPrefix);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [isTaskExpanded, setIsTaskExpanded] = useState(initialMode === 'task');
  const [taskTitle, setTaskTitle] = useState('');
  const [branchSlug, setBranchSlug] = useState(() => buildManagedWorktreeSlug());
  const [branchSlugEdited, setBranchSlugEdited] = useState(false);
  const [submittingMode, setSubmittingMode] = useState<'chat' | 'task' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawSelectedCollectionId, setSelectedCollectionId] = useState<string | null>(collection?.id ?? null);
  const containerRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const useAnchoredPortal = Boolean(anchorRef);
  const [anchoredPosition, setAnchoredPosition] = useState<{ left: number; top: number } | null>(null);
  const hasChatMode = availableModes.includes('chat');
  const hasTaskMode = availableModes.includes('task');
  const canCreateChat = hasChatMode && allowedModes.includes('chat');
  const canCreateTask = hasTaskMode && allowedModes.includes('task');
  const canSelectCollection = allowCollectionSelection;
  const resolvedScopeId = scopeId ?? collection?.id ?? 'uncategorized';
  const isContinuation = Boolean(continuationSourceTitle);

  const selectedCollection = useMemo(() => {
    if (!canSelectCollection) return collection;
    if (rawSelectedCollectionId === null) return null;
    return collections.find((item) => item.id === rawSelectedCollectionId) ?? null;
  }, [canSelectCollection, collection, collections, rawSelectedCollectionId]);

  useEffect(() => {
    if (!canSelectCollection) {
      setSelectedCollectionId(collection?.id ?? null);
    }
  }, [canSelectCollection, collection?.id]);

  useEffect(() => {
    if (!canCreateTask || initialMode !== 'task') return;
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }, [canCreateTask, initialMode]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const sheetElement = containerRef.current;
      if (sheetElement?.contains(target)) return;
      const anchorElement = anchorRef?.current;
      if (anchorElement?.contains(target)) return;
      const boundaryElement = boundaryRef?.current;
      if (boundaryElement?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, boundaryRef, onClose]);

  const updateAnchoredPosition = useCallback(() => {
    const anchorElement = anchorRef?.current;
    if (!anchorElement) return;
    const rect = anchorElement.getBoundingClientRect();
    const sheetWidth = containerRef.current?.offsetWidth ?? ANCHORED_SHEET_WIDTH;
    const sheetHeight = containerRef.current?.offsetHeight ?? 360;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left: number;
    let top: number;

    if (anchorPlacement === 'top') {
      const maxLeft = Math.max(ANCHORED_VIEWPORT_MARGIN, viewportWidth - sheetWidth - ANCHORED_VIEWPORT_MARGIN);
      const maxTop = Math.max(ANCHORED_VIEWPORT_MARGIN, viewportHeight - sheetHeight - ANCHORED_VIEWPORT_MARGIN);
      left = Math.min(
        Math.max(ANCHORED_VIEWPORT_MARGIN, rect.right - sheetWidth),
        maxLeft,
      );
      top = rect.top - sheetHeight - ANCHORED_SHEET_GAP;
      if (top < ANCHORED_VIEWPORT_MARGIN) {
        top = Math.min(rect.bottom + ANCHORED_SHEET_GAP, maxTop);
      }
    } else {
      left = rect.right + ANCHORED_SHEET_GAP;
      if (left + sheetWidth > viewportWidth - ANCHORED_VIEWPORT_MARGIN) {
        const fallbackLeft = rect.left - sheetWidth - ANCHORED_SHEET_GAP;
        left = fallbackLeft >= ANCHORED_VIEWPORT_MARGIN
          ? fallbackLeft
          : Math.max(ANCHORED_VIEWPORT_MARGIN, viewportWidth - sheetWidth - ANCHORED_VIEWPORT_MARGIN);
      }

      top = rect.top;
      if (top + sheetHeight > viewportHeight - ANCHORED_VIEWPORT_MARGIN) {
        top = Math.max(ANCHORED_VIEWPORT_MARGIN, viewportHeight - sheetHeight - ANCHORED_VIEWPORT_MARGIN);
      }
      if (top < ANCHORED_VIEWPORT_MARGIN) top = ANCHORED_VIEWPORT_MARGIN;
    }

    setAnchoredPosition({ left, top });
  }, [anchorPlacement, anchorRef]);

  useLayoutEffect(() => {
    if (!useAnchoredPortal) return;
    updateAnchoredPosition();
  }, [useAnchoredPortal, updateAnchoredPosition, isTaskExpanded, canSelectCollection]);

  useEffect(() => {
    if (!useAnchoredPortal) return;
    const handle = () => updateAnchoredPosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [useAnchoredPortal, updateAnchoredPosition]);

  const normalizedBranchPrefix = useMemo(
    () => normalizeManagedWorktreeBranchPrefix(branchPrefix),
    [branchPrefix]
  );
  const worktreePathPreview = useMemo(
    () => buildManagedWorktreePreviewPath(projectDir, branchPrefix, branchSlug),
    [branchPrefix, branchSlug, projectDir]
  );

  const handleCreateChat = useCallback(async () => {
    setError(null);
    if (!selectedProvider) {
      setError(t('errors.providerRequired'));
      return;
    }
    setSubmittingMode('chat');
    try {
      const sessionId = await createSession({
        workDir: projectDir,
        providerId: selectedProvider,
        collectionId: selectedCollection?.id,
      });
      if (!sessionId) return;

      await onSessionCreated?.(sessionId);
      onClose();
    } finally {
      setSubmittingMode(null);
    }
  }, [createSession, onClose, onSessionCreated, projectDir, selectedCollection?.id, selectedProvider, t]);

  const handleCreateTask = useCallback(async () => {
    setError(null);
    if (!selectedProvider) {
      setError(t('errors.providerRequired'));
      return;
    }
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
    setSubmittingMode('task');
    let shouldClose = false;
    try {
      const result = await createWorktreeSession({
        projectDir,
        parentProjectId: projectId,
        providerId: selectedProvider,
        taskTitle: trimmedTaskTitle || t('task.creation.title'),
        hasCustomTitle: trimmedTaskTitle.length > 0,
        branchSlug: normalizedBranchSlug,
        allowBranchSlugSuffix: !branchSlugEdited,
        suppressErrorToast: true,
        collectionId: selectedCollection?.id ?? undefined,
        workflowStatus,
      });
      if (!result.ok) {
        setError(
          result.code === 'name_unavailable'
            ? t('task.creation.errorBranchSlugTaken')
            : result.error ?? t('errors.unknownError')
        );
        return;
      }
      if (result.sessionId) {
        await onSessionCreated?.(result.sessionId);
      }
      shouldClose = true;
    } finally {
      setSubmittingMode(null);
    }
    if (shouldClose) {
      onClose();
    }
  }, [
    createWorktreeSession,
    onClose,
    onSessionCreated,
    branchSlug,
    branchSlugEdited,
    projectDir,
    projectId,
    selectedCollection?.id,
    selectedProvider,
    t,
    taskTitle,
    workflowStatus,
  ]);

  const sheetContainerClassName = useAnchoredPortal
    ? cn(
        'fixed z-[10001] w-[17rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl',
        'border border-[color-mix(in_srgb,var(--accent)_38%,var(--divider))]',
        'bg-[color-mix(in_srgb,var(--input-bg)_80%,var(--accent)_20%)]',
        'shadow-[0_24px_60px_rgba(0,0,0,0.46),0_0_0_1px_color-mix(in_srgb,var(--accent)_24%,transparent),0_0_34px_color-mix(in_srgb,var(--accent)_10%,transparent)] backdrop-blur-xl',
        className,
      )
    : cn(
        'absolute right-2 top-10 z-40 w-[min(17rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl',
        'border border-[color-mix(in_srgb,var(--accent)_38%,var(--divider))]',
        'bg-[color-mix(in_srgb,var(--input-bg)_80%,var(--accent)_20%)]',
        'shadow-[0_24px_60px_rgba(0,0,0,0.46),0_0_0_1px_color-mix(in_srgb,var(--accent)_24%,transparent),0_0_34px_color-mix(in_srgb,var(--accent)_10%,transparent)] backdrop-blur-xl',
        className,
      );

  const sheetStyle = useAnchoredPortal && anchoredPosition
    ? { left: anchoredPosition.left, top: anchoredPosition.top }
    : useAnchoredPortal
      ? { visibility: 'hidden' as const, left: -9999, top: -9999 }
      : undefined;

  const sheetMarkup = (
    <div
      ref={containerRef}
      className={sheetContainerClassName}
      style={sheetStyle}
      onClick={(event) => event.stopPropagation()}
      data-testid={`collection-quick-create-${resolvedScopeId}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--accent)_28%,var(--divider))] bg-[color-mix(in_srgb,var(--accent)_18%,var(--input-bg))] px-2.5 py-2">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-(--text-muted)">
            {isContinuation ? t('task.creation.continueFromLabel') : t('task.creation.collectionLabel')}
          </p>
          <p className="truncate text-[13px] font-semibold text-(--sidebar-text-active)">
            {isContinuation
              ? t('task.creation.continueSourcePrefix', { title: continuationSourceTitle ?? '' })
              : selectedCollection?.label ?? t('task.creation.noCollection')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
          aria-label={t('common.close')}
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>

      <div className="space-y-2.5 p-2.5">
        <div className="space-y-1">
          <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
            {t('settings.provider.label')}
          </span>
          <CliProviderChipSelector
            value={selectedProvider}
            onChange={setSelectedProvider}
            className="gap-1"
            chipClassName="px-2 py-0.5 text-[10px]"
          />
        </div>

        {canSelectCollection && (
          <div className="space-y-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
              {t('task.creation.collectionLabel')}
            </span>
            <select
              value={rawSelectedCollectionId ?? ''}
              onChange={(event) => setSelectedCollectionId(event.target.value || null)}
              className="w-full rounded-lg border border-(--divider) bg-(--input-bg) px-2.5 py-1.5 text-[13px] text-(--sidebar-text-active) outline-none transition-colors focus:border-(--accent)"
              data-testid={`collection-quick-create-select-${resolvedScopeId}`}
            >
              <option value="">{t('task.creation.noCollection')}</option>
              {collections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {(canCreateChat || canCreateTask) && (
          <div
            className={cn(
              'grid gap-1 rounded-lg border border-[color-mix(in_srgb,var(--accent)_12%,var(--divider))] bg-(--sidebar-bg) p-1',
              canCreateChat && canCreateTask ? 'grid-cols-2' : 'grid-cols-1',
            )}
          >
            {canCreateChat && (
              <button
                type="button"
                onClick={handleCreateChat}
                disabled={submittingMode !== null || !selectedProvider}
                className={cn(
                  'flex w-full flex-col items-start rounded-lg border px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  !isTaskExpanded
                    ? 'border-[color-mix(in_srgb,var(--accent)_24%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                    : 'border-transparent bg-transparent hover:border-(--accent)/16 hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
                )}
                data-testid={`collection-quick-create-chat-${resolvedScopeId}`}
              >
                <MessageSquare className="h-3.5 w-3.5 text-(--accent-hover)" />
                <span className="mt-1.5 block text-[13px] font-semibold text-(--sidebar-text-active)">
                  {isContinuation ? t('task.creation.continueChatLabel') : t('task.newChat.chat')}
                </span>
                <span className="mt-0.5 block text-[10px] leading-[13px] text-(--text-muted)">
                  {submittingMode === 'chat'
                    ? t('common.loading')
                    : isContinuation
                      ? t('task.creation.continueChatHint')
                      : t('task.creation.chatInstantHint')}
                </span>
              </button>
            )}

            {canCreateTask && (
              <button
                type="button"
                onClick={() => {
                  setIsTaskExpanded(true);
                  requestAnimationFrame(() => titleInputRef.current?.focus());
                }}
                disabled={submittingMode !== null || !selectedProvider}
                className={cn(
                  'flex w-full flex-col items-start rounded-lg border px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  isTaskExpanded
                    ? 'border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                    : 'border-transparent bg-transparent hover:border-(--accent)/16 hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
                )}
                data-testid={`collection-quick-create-task-${resolvedScopeId}`}
              >
                <ListTodo className="h-3.5 w-3.5 text-(--accent-hover)" />
                <span className="mt-1.5 block text-[13px] font-semibold text-(--sidebar-text-active)">
                  {isContinuation ? t('task.creation.continueTaskLabel') : t('task.newChat.newTask')}
                </span>
                <span className="mt-0.5 block text-[10px] leading-[13px] text-(--text-muted)">
                  {isContinuation ? t('task.creation.continueTaskHint') : t('task.creation.taskWorktreeHint')}
                </span>
              </button>
            )}
          </div>
        )}

        {canCreateTask && isTaskExpanded && (
          <div className="space-y-2 rounded-lg border border-[color-mix(in_srgb,var(--accent)_14%,var(--divider))] bg-(--sidebar-bg) p-2">
            <div className="space-y-1">
              <label
                htmlFor={`collection-task-title-${resolvedScopeId}`}
                className="text-[9px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)"
              >
                {t('task.creation.titleLabel')}
              </label>
              <input
                ref={titleInputRef}
                id={`collection-task-title-${resolvedScopeId}`}
                type="text"
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && submittingMode === null) {
                    event.preventDefault();
                    void handleCreateTask();
                  }
                }}
                placeholder={t('task.creation.titlePlaceholder')}
                className="w-full rounded-lg border border-(--divider) bg-(--input-bg) px-2.5 py-1.5 text-[13px] text-(--sidebar-text-active) outline-none transition-colors placeholder:text-(--text-muted) focus:border-(--accent)"
                data-testid={`collection-task-title-input-${resolvedScopeId}`}
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor={`collection-task-branch-slug-${resolvedScopeId}`}
                className="text-[9px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)"
              >
                {t('task.creation.branchPreviewLabel')}
              </label>
              <div
                className="flex items-center gap-1.5 rounded-lg border border-(--divider) bg-[color-mix(in_srgb,var(--accent)_4%,var(--input-bg))] px-2.5 py-1.5"
                data-testid={`collection-task-branch-preview-${collection?.id ?? 'uncategorized'}`}
              >
                <FolderGit2 className="h-3 w-3 shrink-0 text-(--text-muted)" />
                {normalizedBranchPrefix ? (
                  <span className="shrink-0 font-mono text-[11px] text-(--text-muted)">
                    {normalizedBranchPrefix}
                  </span>
                ) : null}
                <input
                  id={`collection-task-branch-slug-${resolvedScopeId}`}
                  type="text"
                  value={branchSlug}
                  onChange={(event) => {
                    setBranchSlugEdited(true);
                    setBranchSlug(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && submittingMode === null) {
                      event.preventDefault();
                      void handleCreateTask();
                    }
                  }}
                  placeholder={t('task.creation.branchSlugPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-(--sidebar-text-active) outline-none placeholder:text-(--text-muted)"
                  data-testid={`collection-task-branch-slug-input-${resolvedScopeId}`}
                />
              </div>
              <p
                className="truncate px-1 font-mono text-[9px] text-(--text-muted)"
                title={worktreePathPreview}
                data-testid={`collection-task-worktree-path-preview-${resolvedScopeId}`}
              >
                {worktreePathPreview}
              </p>
            </div>

            {error && (
              <p className="text-[11px] text-[color:var(--error)]" role="alert">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (canCreateChat) {
                    setIsTaskExpanded(false);
                    return;
                  }
                  onClose();
                }}
                className="rounded-md px-2.5 py-1 text-[12px] text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
              >
                {canCreateChat ? t('common.cancel') : t('common.close')}
              </button>
              <button
                type="button"
                onClick={() => void handleCreateTask()}
                disabled={submittingMode !== null || !selectedProvider}
                className="rounded-md bg-(--accent) px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-(--accent-hover) disabled:cursor-not-allowed disabled:opacity-60"
                data-testid={`collection-task-submit-${resolvedScopeId}`}
              >
                {submittingMode === 'task'
                  ? t('task.creation.creating')
                  : isContinuation
                    ? t('task.creation.continueSubmit')
                    : t('task.creation.submit')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (useAnchoredPortal) {
    if (typeof document === 'undefined') return null;
    return createPortal(sheetMarkup, document.body);
  }

  return sheetMarkup;
}
