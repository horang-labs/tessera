'use client';

import { useState, useRef, useEffect, useCallback, useContext } from 'react';
import {
  Pencil,
  Check,
  Hash,
  MessageSquare,
  X as XIcon,
  MoreHorizontal,
  GitBranch,
  Search,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import { getTitleGeneratingStyle } from '@/lib/title-generating-style';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { usePanelStore, selectActiveTab, EMPTY_PANELS, TabIdContext } from '@/stores/panel-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useIsSessionAwaitingUser } from '@/hooks/use-session-awaiting-user';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';
import { useI18n } from '@/lib/i18n';
import { TaskContextMenu } from './task-context-menu';
import { wsClient } from '@/lib/ws/client';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import { ProviderBadge } from './provider-brand';
import { setPanelTitleDragData } from '@/lib/dnd/panel-session-drag';
import { MessageSearchBar } from './message-search-bar';
import {
  CODEX_NATIVE_COMMAND_EVENT,
  type CodexNativeCommandEventDetail,
} from '@/lib/chat/codex-native-command-events';
import { useIsSessionProcessing } from '@/hooks/use-session-processing';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { supportsTerminalChatView } from '@/lib/terminal/terminal-chat-view-support';
import { useTerminalViewMode } from '@/hooks/use-terminal-view-mode';
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { resolveSessionBranchPresentation } from '@/lib/session/session-branch-presentation';

interface HeaderProps {
  sessionId: string;
  panelId: string;
  projectViewDir?: string | null;
  isSinglePanel?: boolean;
  search?: {
    isOpen: boolean;
    query: string;
    matchCount: number;
    activeMatchIndex: number;
    hasMore: boolean;
    onOpen: () => void;
    onClose: () => void;
    onQueryChange: (query: string) => void;
    onNext: () => void;
    onPrevious: () => void;
  };
}

export function Header({ sessionId, panelId, projectViewDir, isSinglePanel = false, search }: HeaderProps) {
  const { t } = useI18n();
  const tabId = useContext(TabIdContext);
  const session = useSessionStore((state) =>
    state.getSession(sessionId, projectViewDir)
  );
  const liveWorktreeBranch = useSessionStore((state) => {
    if (!session?.worktreeId) return null;
    return state.projects
      .map((project) => project.projectWorktree)
      .find((worktree) => worktree?.id === session.worktreeId)?.currentBranch ?? null;
  });
  const dragSessionId = session?.id ?? null;
  const taskId = session?.taskId;
  const linkedTask = useTaskStore((state) =>
    taskId ? state.getTask(taskId) : undefined
  );
  const isGeneratingTitle = useSessionStore((state) => state.generatingTitleIds.has(sessionId));
  const { renameSession, generateTitle, deleteSession } = useSessionCrud();
  const isProcessing = useIsSessionProcessing(sessionId);
  const isAwaitingUser = useIsSessionAwaitingUser(sessionId, session?.kind);

  // PTY 세션을 읽기 전용 채팅으로 덮어 보는 토글. transcript를 되읽을 수 있는
  // provider에서만 노출한다 — 그 외에는 보여줄 대화가 없다.
  const terminalViewMode = useTerminalViewMode(sessionId);
  const toggleTerminalViewMode = useTerminalViewModeStore((state) => state.toggleMode);
  const canToggleTerminalView = session?.kind === 'terminal'
    && supportsTerminalChatView(session?.provider);
  const isTerminalChatView = canToggleTerminalView && terminalViewMode === 'chat';

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
    // stopPropagation keeps the surrounding row from picking the tap up, but it
    // also means the menu's own outside-click watcher never sees a click on the
    // trigger. Without a toggle branch here, re-tapping the button while the
    // menu is open does nothing and the user is stuck reaching for empty space.
    e.stopPropagation();
    setMenuAnchorRect((prev) => {
      if (prev) return null;
      const rect = moreButtonRef.current?.getBoundingClientRect();
      return rect ?? null;
    });
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

  useEffect(() => {
    const handleNativeCommand = (event: Event) => {
      const detail = (event as CustomEvent<CodexNativeCommandEventDetail>).detail;
      if (detail?.sessionId === sessionId && detail.action === 'rename') {
        handleRenameFromMenu();
      }
    };
    window.addEventListener(CODEX_NATIVE_COMMAND_EVENT, handleNativeCommand);
    return () => window.removeEventListener(CODEX_NATIVE_COMMAND_EVENT, handleNativeCommand);
  }, [handleRenameFromMenu, sessionId]);

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

  const branchPresentation = resolveSessionBranchPresentation({
    worktreeBranch: session?.worktreeBranch,
    scopeBranch: session?.scopeBranch,
    liveBranch: liveWorktreeBranch,
  });
  const branchTitle = branchPresentation
    ? `${t(branchPresentation.labelKind === 'scope' ? 'chat.sessionScopeLabel' : 'chat.branchLabel')}: ${branchPresentation.branch}${
        branchPresentation.liveBranch
          ? ` · ${t('chat.currentBranchLabel')}: ${branchPresentation.liveBranch}`
          : ''
      }${branchPresentation.labelKind === 'scope' ? ` · ${t('chat.presentationScopeHint')}` : ''}${
        session?.worktreeDeletedAt ? ` · ${t('chat.worktreeDeleted')}` : ''
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
  const runtimePresentation = resolveSessionRuntimePresentation(session);
  return (
    <div
      className={cn(
        'h-9 border-b border-(--chat-header-border) bg-(--chat-header-bg)',
        // At Phone viewport the row's four controls are 44px tall, which a
        // 36px row would clip. The height follows the targets instead of
        // being restated, so it stays right if the floor ever moves (#259).
        'max-sm:h-auto',
      )}
      onContextMenu={handleContextMenu}
    >
      <div
        className={cn(
          'group/header flex h-full w-full items-center justify-between gap-2.5',
          isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-2.5',
          // 44px targets take 176px of the 283px this row has at 360px. The
          // slack is taken back from the padding and the gap rather than from
          // the four controls, because the title is what is left to lose (#259).
          'max-sm:gap-1 max-sm:px-2',
        )}
      >
        {/* Left: Channel-style title */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden max-sm:gap-1">
        {isProcessing ? (
          <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-(--success)/30 border-t-(--success) animate-spin" />
        ) : (
          <Hash className="h-3.5 w-3.5 shrink-0 text-(--text-muted) max-sm:hidden" />
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 max-sm:gap-1">
            <button
              type="button"
              draggable
              onClick={handleTitleButtonClick}
              onDragStart={handleTitleDragStart}
              onDragEnd={handleTitleDragEnd}
              className="group flex h-full min-w-0 flex-1 cursor-grab items-center gap-1.5 text-left active:cursor-grabbing max-sm:gap-1"
              data-testid="panel-title-drag-handle"
            >
              <ProviderBadge
                providerId={session.provider}
                className="h-5 rounded-md px-2 text-[10px] leading-none max-sm:px-1"
                // "Claude Code" is 71px of a row that has 107px left once the
                // four 44px targets are placed. The mark alone still says
                // which provider this is, and what it gives back is the only
                // room the session title has (#259).
                labelClassName="max-sm:hidden"
                fullLabel={!session.provider || session.provider === 'claude-code'}
              />

              {session.integrationHealth === 'degraded' ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-1 text-[10px] font-medium text-amber-800 dark:text-amber-300"
                  title={t('chat.integrationDegraded')}
                  data-testid="provider-integration-degraded"
                >
                  <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                  <span className="max-sm:hidden">{t('chat.integrationDegraded')}</span>
                </span>
              ) : null}

              <span className="flex min-w-0 shrink items-center gap-1 max-sm:flex-1">
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
                    // Below the Phone viewport step the hint is simply shown: `hover:`
                    // compiles to `@media (hover: hover)`, so on a phone no rule exists
                    // to reveal it. The reveal is kept from `sm` up (#250).
                    !isGeneratingTitle && 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
                  )}
                />
              </span>

              {branchPresentation && (
                <>
                  <span className="h-3 w-px shrink-0 bg-(--divider) opacity-70 max-sm:hidden" aria-hidden="true" />
                  <span
                    className={cn(
                      'inline-flex min-w-0 max-w-[min(18rem,35vw)] shrink items-center gap-1',
                      'text-[11px] font-normal leading-none text-(--text-secondary)',
                      'max-sm:hidden',
                      (session.worktreeDeletedAt || branchPresentation.mismatch)
                        && 'text-(--status-error-text)'
                    )}
                    title={branchTitle}
                    aria-label={branchTitle}
                    data-testid="header-branch-chip"
                  >
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      {branchPresentation.labelKind === 'scope'
                        ? `${t('chat.sessionScopeLabel')}: `
                        : ''}
                      {branchPresentation.branch}
                    </span>
                    {branchPresentation.mismatch && branchPresentation.liveBranch ? (
                      <span className="min-w-0 truncate">
                        · {t('chat.currentBranchLabel')}: {branchPresentation.liveBranch}
                      </span>
                    ) : null}
                  </span>
                </>
              )}

              {/* Inert grab area, so the title button is draggable past the end
                  of its text. At Phone viewport there is no free space for it
                  to absorb and no panel to drag a session onto, and its 16px
                  minimum comes straight out of the title (#259). */}
              <span className="min-w-4 flex-1 max-sm:hidden" aria-hidden="true" />
            </button>
          </div>
        )}

        </div>

        {/* Right: actions */}
        <div
          className={cn(
            'ml-auto flex shrink-0 items-center gap-2',
            // Dropping the gap at Phone viewport does not bring the glyphs
            // closer together: each sits centred in 44px, so two neighbours
            // are ~26px apart where the 18px boxes used to be 8px apart. The
            // 24px it returns goes to the title.
            'max-sm:gap-0',
          )}
        >
          {search?.isOpen ? (
            <MessageSearchBar
              query={search.query}
              matchCount={search.matchCount}
              activeMatchIndex={search.activeMatchIndex}
              hasMore={search.hasMore}
              onQueryChange={search.onQueryChange}
              onNext={search.onNext}
              onPrevious={search.onPrevious}
              onClose={search.onClose}
            />
          ) : (
            <>
            {canToggleTerminalView && (
              <button
                type="button"
                onClick={() => toggleTerminalViewMode(sessionId)}
                title={isTerminalChatView ? t('chat.viewAsTerminal') : t('chat.viewAsChat')}
                aria-label={isTerminalChatView ? t('chat.viewAsTerminal') : t('chat.viewAsChat')}
                aria-pressed={isTerminalChatView}
                className={cn(
                  'rounded p-0.5 transition-all duration-150',
                  'text-(--text-muted) hover:text-(--sidebar-text-active)',
                  'hover:bg-(--sidebar-hover)',
                  PHONE_TOUCH_TARGET,
                  isTerminalChatView && 'text-(--sidebar-text-active)',
                )}
                data-testid="terminal-view-toggle"
              >
                {isTerminalChatView
                  ? <SquareTerminal className="h-3.5 w-3.5" />
                  : <MessageSquare className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={search?.onOpen}
              title={t('chat.search.open')}
              aria-label={t('chat.search.open')}
              className={cn(
                'rounded p-0.5 transition-all duration-150',
                'text-(--text-muted) hover:text-(--sidebar-text-active)',
                'hover:bg-(--sidebar-hover)',
                PHONE_TOUCH_TARGET,
                !search && 'pointer-events-none opacity-40',
              )}
              data-testid="message-search-open-button"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
            </>
          )}

          {/* More actions button — hover only */}
          <button
            ref={moreButtonRef}
            onClick={handleMoreClick}
            className={cn(
              'rounded p-0.5 transition-all duration-150',
              'text-(--text-muted) hover:text-(--sidebar-text-active)',
              'hover:bg-(--sidebar-hover)',
              PHONE_TOUCH_TARGET,
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
              className={cn(
                'rounded p-0.5 transition-colors hover:bg-(--sidebar-hover)',
                PHONE_TOUCH_TARGET,
              )}
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
          isRunning={runtimePresentation.showRunning}
          onStatusChange={isSingleSessionTask ? handleStatusChange : undefined}
          onArchive={session.taskId ? undefined : handleArchive}
          onUnarchive={session.taskId ? undefined : handleUnarchive}
          onRename={handleRenameFromMenu}
          onDelete={handleDelete}
          onGenerateTitle={() => generateTitle(sessionId)}
          onStopProcess={runtimePresentation.canStop ? handleStopProcess : undefined}
          onClose={handleCloseMenu}
        />
      )}
    </div>
  );
}
