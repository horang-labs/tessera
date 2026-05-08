'use client';

import { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { Pencil, Check, Hash, X as XIcon, MoreHorizontal, GitBranch } from 'lucide-react';
import { getTitleGeneratingStyle } from '@/lib/title-generating-style';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { usePanelStore, selectActiveTab, EMPTY_PANELS, TabIdContext } from '@/stores/panel-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { selectIsAwaitingUserPrompt, selectIsTurnInFlight, useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { TaskContextMenu } from './task-context-menu';
import { wsClient } from '@/lib/ws/client';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import { ProviderBadge } from './provider-brand';
import { setPanelTitleDragData } from '@/lib/dnd/panel-session-drag';

interface HeaderProps {
  sessionId: string;
  panelId: string;
  isSinglePanel?: boolean;
}

export function Header({ sessionId, panelId, isSinglePanel = false }: HeaderProps) {
  const { t } = useI18n();
  const tabId = useContext(TabIdContext);
  const session = useSessionStore((state) =>
    state.getSession(sessionId)
  );
  const dragSessionId = session?.id ?? null;
  const taskId = session?.taskId;
  const linkedTask = useTaskStore((state) =>
    taskId ? state.getTask(taskId) : undefined
  );
  const isGeneratingTitle = useSessionStore((state) => state.generatingTitleIds.has(sessionId));
  const { renameSession, generateTitle, deleteSession } = useSessionCrud();
  const isProcessing = useChatStore(selectIsTurnInFlight(sessionId));
  const isAwaitingUser = useChatStore(selectIsAwaitingUserPrompt(sessionId));

  // Multi-panel unread indicator — active panel's unread is auto-cleared by
  // panel-wrapper, so this only appears on inactive panel headers.
  const hasUnread = !isSinglePanel && ((session?.unreadCount ?? 0) > 0);

  // session-store에서 상태 변경 액션 가져오기
  const updateLinkedTaskWorkflowStatus = useSessionStore((state) => state.updateLinkedTaskWorkflowStatus);
  const toggleArchive = useSessionStore((state) => state.toggleArchive);

  // Unit 4: 패널 닫기 버튼 (REQ-13, BR-CLOSE-004)
  const panels = usePanelStore((state) => selectActiveTab(state)?.panels ?? EMPTY_PANELS);
  const closePanel = usePanelStore((state) => state.closePanel);
  const assignSession = usePanelStore((state) => state.assignSession);
  const panelCount = Object.keys(panels).length;
  const panel = panels[panelId];

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(session?.title || '');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [titleMinWidth, setTitleMinWidth] = useState(0);
  const [titleInputWidth, setTitleInputWidth] = useState(0);

  // Context menu state
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const suppressTitleClickAfterDragRef = useRef(false);

  const handleTitleSave = () => {
    if (titleInput.trim() && session && titleInput.trim() !== session.title) {
      renameSession(session.id, titleInput.trim());
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleTitleSave();
    else if (e.key === 'Escape') {
      setTitleInput(session?.title || '');
      setIsEditingTitle(false);
    }
  };

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchorRect(rect);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuAnchorRect(new DOMRect(e.clientX, e.clientY, 0, 0));
  }, []);

  const handleCloseMenu = useCallback(() => {
    setMenuAnchorRect(null);
  }, []);

  const handleStatusChange = useCallback((status: string) => {
    if (!session?.taskId) return;
    updateLinkedTaskWorkflowStatus(sessionId, status);
  }, [session?.taskId, sessionId, updateLinkedTaskWorkflowStatus]);

  const isSingleSessionTask = Boolean(linkedTask && linkedTask.sessions.length === 1);
  const currentTaskStatus = linkedTask?.workflowStatus ?? session?.workflowStatus;

  const handleArchive = useCallback(() => {
    if (taskId) {
      void useTaskStore.getState().toggleTaskArchive(taskId, true);
      return;
    }
    toggleArchive(sessionId, true);
  }, [sessionId, taskId, toggleArchive]);

  const handleUnarchive = useCallback(() => {
    if (taskId) {
      void useTaskStore.getState().toggleTaskArchive(taskId, false);
      return;
    }
    toggleArchive(sessionId, false);
  }, [sessionId, taskId, toggleArchive]);

  const handleDelete = useCallback(() => {
    deleteSession(sessionId);
  }, [sessionId, deleteSession]);

  const handleRenameFromMenu = useCallback(() => {
    setTitleInput(session?.title || '');
    const nextMinWidth = titleRef.current?.offsetWidth ?? 0;
    setTitleMinWidth(nextMinWidth);
    setTitleInputWidth(nextMinWidth + 16);
    setIsEditingTitle(true);
  }, [session?.title]);

  const handleTitleButtonClick = useCallback(() => {
    if (suppressTitleClickAfterDragRef.current) return;
    setTitleInput(session?.title || '');
    const nextMinWidth = titleRef.current?.offsetWidth ?? 0;
    setTitleMinWidth(nextMinWidth);
    setTitleInputWidth(nextMinWidth + 16);
    setIsEditingTitle(true);
  }, [session?.title]);

  const handleTitleDragStart = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    if (!dragSessionId) {
      e.preventDefault();
      return;
    }
    suppressTitleClickAfterDragRef.current = true;
    const didSet = setPanelTitleDragData(e.dataTransfer, {
      tabId,
      panelId,
      sessionId: dragSessionId,
    });
    if (!didSet) e.preventDefault();
  }, [dragSessionId, panelId, tabId]);

  const handleTitleDragEnd = useCallback(() => {
    window.setTimeout(() => {
      suppressTitleClickAfterDragRef.current = false;
    }, 150);
  }, []);

  const handleStopProcess = useCallback(() => {
    wsClient.stopSession(sessionId);
  }, [sessionId]);

  const branchTitle = session?.worktreeBranch
    ? `${t('chat.branchLabel')}: ${session.worktreeBranch}${
        session.worktreeDeletedAt ? ` · ${t('chat.worktreeDeleted')}` : ''
      }`
    : undefined;

  useEffect(() => {
    if (!isEditingTitle) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const measuredWidth = Math.max(measureRef.current?.offsetWidth ?? titleMinWidth, titleMinWidth) + 16;
      setTitleInputWidth(measuredWidth);
    });

    return () => cancelAnimationFrame(frameId);
  }, [isEditingTitle, titleInput, titleMinWidth]);

  if (!session) return null;
  return (
    <div
      className="h-9 border-b border-(--chat-header-border) bg-(--chat-header-bg)"
      onContextMenu={handleContextMenu}
    >
      <div
        className={cn(
          'group/header flex h-full w-full items-center justify-between gap-2.5',
          isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-2.5'
        )}
      >
        {/* Left: Channel-style title */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {isProcessing ? (
          <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-(--success)/30 border-t-(--success) animate-spin" />
        ) : (
          <Hash className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        )}

        {isAwaitingUser ? (
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#facc15] attention-dot-blink"
            data-testid="header-attention-indicator"
            aria-label={t('status.inputRequired')}
          />
        ) : hasUnread && (
          <span
            className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#facc15]"
            data-testid="header-unread-indicator"
            aria-label="Unread messages"
          />
        )}

        {/* Hidden span to measure input text width (same font as h2) */}
        <span
          ref={measureRef}
          className="absolute invisible whitespace-pre text-[15px] font-semibold leading-none"
          aria-hidden="true"
        >
          {titleInput}
        </span>

        {isEditingTitle ? (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              style={{ width: titleInputWidth }}
              className="h-6 rounded border border-(--input-border) bg-(--input-bg) px-2 py-0 text-[15px] font-semibold leading-none text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
              autoFocus
            />
            <button onClick={handleTitleSave} className="rounded p-0.5 text-(--success) hover:bg-(--sidebar-hover)">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => { setTitleInput(session.title); setIsEditingTitle(false); }} className="rounded p-0.5 text-(--text-muted) hover:bg-(--sidebar-hover)">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              draggable
              onClick={handleTitleButtonClick}
              onDragStart={handleTitleDragStart}
              onDragEnd={handleTitleDragEnd}
              className="group flex h-full min-w-0 flex-1 cursor-grab items-center gap-1.5 text-left active:cursor-grabbing"
              data-testid="panel-title-drag-handle"
            >
              <ProviderBadge
                providerId={session.provider}
                className="h-5 rounded-md px-2 text-[10px] leading-none"
                fullLabel={!session.provider || session.provider === 'claude-code'}
              />

              <span className="flex min-w-0 shrink items-center gap-1">
                <h2
                  ref={titleRef}
                  className={cn(
                    'truncate text-[15px] font-semibold leading-none text-(--text-primary)',
                    isGeneratingTitle && 'title-generating'
                  )}
                  style={isGeneratingTitle ? getTitleGeneratingStyle(session.id) : undefined}
                >
                  {session.title}
                </h2>
                <Pencil
                  className={cn(
                    'h-3 w-3 shrink-0 text-(--text-muted) opacity-0 transition-opacity',
                    !isGeneratingTitle && 'group-hover:opacity-100'
                  )}
                />
              </span>

              {session.worktreeBranch && (
                <>
                  <span className="h-3 w-px shrink-0 bg-(--divider) opacity-70" aria-hidden="true" />
                  <span
                    className={cn(
                      'inline-flex min-w-0 max-w-[min(18rem,35vw)] shrink items-center gap-1',
                      'text-[11px] font-normal leading-none text-(--text-secondary)',
                      session.worktreeDeletedAt && 'text-(--status-error-text)'
                    )}
                    title={branchTitle}
                    aria-label={branchTitle}
                    data-testid="header-branch-chip"
                  >
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{session.worktreeBranch}</span>
                  </span>
                </>
              )}

              <span className="min-w-4 flex-1" aria-hidden="true" />
            </button>
          </div>
        )}

        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 items-center gap-2">
          {/* More actions button — hover only */}
          <button
            ref={moreButtonRef}
            onClick={handleMoreClick}
            className={cn(
              'rounded p-0.5 transition-all duration-150',
              'text-(--text-muted) hover:text-(--sidebar-text-active)',
              'hover:bg-(--sidebar-hover)',
              'opacity-100'
            )}
            data-testid="header-more-button"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={menuAnchorRect !== null}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>

          {/* 세션 닫기 / 패널 닫기 버튼 */}
          {/* 세션 열림 → 세션 해제(빈 패널), 멀티패널 빈 상태 → 패널 닫기, 싱글패널 빈 상태 → 숨김 */}
          {(panelCount >= 2 || panel?.sessionId) && (
            <button
              onClick={() => {
                if (panel?.sessionId) {
                  assignSession(panelId, null);
                } else {
                  closePanel(panelId);
                }
              }}
              title={panel?.sessionId ? t('chat.closeSession') : t('panel.closePanel')}
              aria-label={panel?.sessionId ? t('chat.closeSession') : t('panel.closePanel')}
              data-testid="panel-close-button"
              className="rounded p-0.5 transition-colors hover:bg-(--sidebar-hover)"
            >
              <XIcon className="h-3.5 w-3.5 text-(--text-muted)" />
            </button>
          )}
        </div>
      </div>

      {/* Context menu — rendered in portal */}
      {menuAnchorRect && (
        <TaskContextMenu
          anchorRect={menuAnchorRect}
          currentStatus={isSingleSessionTask ? currentTaskStatus : undefined}
          isArchived={session.archived ?? false}
          isRunning={session.isRunning}
          onStatusChange={isSingleSessionTask ? handleStatusChange : undefined}
          onArchive={session.taskId ? undefined : handleArchive}
          onUnarchive={session.taskId ? undefined : handleUnarchive}
          onRename={handleRenameFromMenu}
          onDelete={handleDelete}
          onGenerateTitle={() => generateTitle(sessionId)}
          onStopProcess={session.isRunning ? handleStopProcess : undefined}
          onClose={handleCloseMenu}
        />
      )}
    </div>
  );
}
