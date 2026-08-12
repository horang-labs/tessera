"use client";

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { selectIsTurnInFlight, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionNavigation } from "@/hooks/use-session-navigation";
import { useProjectViewSession } from "@/hooks/use-project-view-workspace-state";
import { useWindowedMessages } from "@/hooks/use-windowed-messages";
import { useMessageSearch } from "@/hooks/use-message-search";
import { groupMessages } from "@/lib/chat/group-messages";
import { Header } from "./header";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { WorkflowStatusBar } from "./workflow/workflow-status-bar";
import { CompactStatusBar } from "./compact-status-bar";
import { TodoStatusBar } from "./todo/todo-status-bar";
import { TerminalChatComposer } from "./terminal-chat-composer";
import { InteractivePromptOverlay } from "./interactive-prompt-overlay";
import { MessageSquare, AlertCircle, CircleAlert, LoaderCircle, RotateCcw, X as XIcon } from "lucide-react";
import { ChatAreaSkeleton } from "./chat-area-skeleton";
import { Button } from "@/components/ui/button";
import { usePanelStore, selectActiveTab, EMPTY_PANELS, TabIdContext } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { useI18n } from "@/lib/i18n";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { getSessionTerminalId } from "@/lib/terminal/terminal-surface-registry";
import { shouldShowSessionHeader } from "@/lib/terminal/session-header-visibility";
import { supportsTerminalChatView } from "@/lib/terminal/terminal-chat-view-support";
import { cancelTerminalChatRefresh } from "@/lib/chat/terminal-chat-live-refresh";
import { useTerminalViewMode } from "@/hooks/use-terminal-view-mode";
import {
  selectCanEscapeInterruptTerminal,
  selectIsTerminalTurnProcessing,
  useTerminalSessionStore,
} from "@/stores/terminal-session-store";
import { sendTerminalChatInterrupt } from '@/lib/terminal/terminal-chat-send';
import { toast } from '@/stores/notification-store';
import { wsClient } from '@/lib/ws/client';

interface ChatAreaProps {
  sessionId: string;
  panelId: string;
  presentation?: 'panel' | 'peek';
  projectViewDir?: string | null;
}

const PEEK_LOADING_DELAY_MS = 300;

export const ChatArea = memo(function ChatArea({
  sessionId,
  panelId,
  presentation = 'panel',
  projectViewDir: explicitProjectViewDir,
}: ChatAreaProps) {
  const { t } = useI18n();
  const tabId = useContext(TabIdContext);
  const isPeek = presentation === 'peek';
  const [peekLoadingReadySessionId, setPeekLoadingReadySessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!isPeek) return;
    const timer = setTimeout(() => {
      setPeekLoadingReadySessionId(sessionId);
    }, PEEK_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isPeek, sessionId]);
  const shouldShowPeekLoading = isPeek && peekLoadingReadySessionId === sessionId;
  // Side-by-side panels in the active tab are all on-screen even though only
  // one is the panel-store's "active" panel; gating autoscroll on isPanelActive
  // froze the unfocused panel's viewport during streaming (issue #16).
  const isViewActive = useTabStore((state) => isPeek || state.activeTabId === tabId);
  const isPreviewTab = useTabStore(
    (state) => !isPeek && (state.tabs.find((tab) => tab.id === tabId)?.isPreview ?? false),
  );
  const tabProjectViewDir = useTabStore(
    (state) => state.tabs.find((tab) => tab.id === tabId)?.projectDir ?? null,
  );
  const projectViewDir = explicitProjectViewDir === undefined
    ? tabProjectViewDir
    : explicitProjectViewDir;
  const { windowedMessages, hasMore, loadMore, isLoadingMore } =
    useWindowedMessages(sessionId);
  const isSinglePanel = usePanelStore(
    (state) => isPeek
      || Object.keys(selectActiveTab(state)?.panels ?? EMPTY_PANELS).length <= 1,
  );

  const session = useProjectViewSession(sessionId, projectViewDir);
  // 생성 중(낙관적 temp 세션): 서버 세션이 아직 없어서 PTY attach가 불가능하다 —
  // TerminalPanel을 붙이면 존재하지 않는 세션으로 terminal_create가 나가 에러가 뜬다.
  // 전역 creatingSessionId 슬롯은 동시 생성 시 덮여서 믿을 수 없다 — temp- 접두가
  // 낙관적 세션의 결정적 마커다(use-session-crud만 이 접두로 id를 만든다).
  const isPendingCreation = sessionId.startsWith('temp-');
  const messages = useChatStore((state) => state.messages.get(sessionId));
  const error = useChatStore((state) => state.errors.get(sessionId));
  const integrationRecovery = useChatStore((state) => state.providerIntegrationRecovery.get(sessionId));
  const clearError = useChatStore((state) => state.clearError);
  const setIntegrationRecovery = useChatStore((state) => state.setProviderIntegrationRecovery);
  const isLoading = useChatStore((state) => state.isLoading);
  const isTurnInFlight = useChatStore(selectIsTurnInFlight(sessionId));
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const { viewSession, isLoading: isHistoryLoading } = useSessionNavigation();

  const historyLoaded = useChatStore((state) =>
    state.isHistoryLoaded(sessionId),
  );
  // Track the last session this ChatArea instance auto-loaded for. Without
  // this per-session reset, switching panels to a session that was never
  // explicitly viewSession'd (e.g. opening a card forwarded from a popout
  // window — see chat-layout's onPopoutOpenSession listener) leaves the
  // panel stuck on ChatAreaSkeleton because the boolean ref short-circuits
  // the autoLoad after the first session.
  const autoLoadedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (autoLoadedSessionIdRef.current === session.id) return;
    if (historyLoaded) {
      autoLoadedSessionIdRef.current = session.id;
      return;
    }
    autoLoadedSessionIdRef.current = session.id;
    // Mounting a panel is passive. Its containing tab/panel action already owns
    // selection, so a delayed history request must never activate this surface.
    void viewSession(session, { activate: false });
  }, [session, historyLoaded, isPeek, viewSession]);
  const groupedMessagesForSearch = useMemo(
    () => groupMessages(windowedMessages),
    [windowedMessages],
  );
  const messageSearch = useMessageSearch(
    windowedMessages,
    groupedMessagesForSearch,
    sessionId,
  );

  // terminal-mode: 이 세션이 터미널 kind면 채팅 본문(메시지/컴포저) 대신 xterm 터미널을
  // 렌더하고, 마운트 시 provider PTY를 프롬프트 없이 자동 기동한다. 단일 패널에서는
  // 탭 제목과 중복되는 Header를 숨기고, 멀티 패널에서는 패널 제어를 위해 유지한다.
  const sessionProvider = session?.provider;
  const isTerminalSession = session?.kind === "terminal";
  // 세션당 안정적 terminalId. 렌더러 메모리가 아니라 서버의 session binding이 실제
  // PTY 소유권을 가지므로 reload/다중 창에서도 같은 런타임으로 attach된다.
  const terminalId = useMemo(
    () => (isTerminalSession ? getSessionTerminalId(sessionId) : null),
    [isTerminalSession, sessionId],
  );
  // PTY 세션을 GUI로 볼 때: 터미널은 그대로 살려두고 위에 채팅을 덮는다(Orca와 동일).
  // 언마운트하면 PTY가 새로 떠서 스크롤백이 날아간다.
  const terminalViewMode = useTerminalViewMode(sessionId);
  const isTerminalTurnProcessing = useTerminalSessionStore(
    selectIsTerminalTurnProcessing(sessionId),
  );
  const canEscapeInterrupt = useTerminalSessionStore(
    selectCanEscapeInterruptTerminal(sessionId),
  );
  const canToggleTerminalChatView = isTerminalSession && supportsTerminalChatView(sessionProvider);
  const isTerminalChatView = canToggleTerminalChatView
    && !isPendingCreation
    && terminalViewMode === 'chat';
  // 터미널에서 대화가 계속 진행되므로, 채팅으로 넘어올 때마다 transcript를 다시 읽는다.
  // 전환 순간에만 걸리도록 ref로 가드 — forceReload가 매 렌더 반복되면 안 된다.
  const reloadedChatViewKeyRef = useRef<string | null>(null);
  const terminalChatOverlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!session || !isTerminalChatView) {
      if (!isTerminalChatView) {
        reloadedChatViewKeyRef.current = null;
        // 터미널로 돌아갔으면 예약된 갱신도 의미가 없다.
        cancelTerminalChatRefresh(sessionId);
      }
      return;
    }
    if (reloadedChatViewKeyRef.current === sessionId) return;
    reloadedChatViewKeyRef.current = sessionId;
    void viewSession(session, { forceReload: true, activate: false });
  }, [session, sessionId, isTerminalChatView, viewSession]);

  const interruptTerminalChat = useCallback(() => {
    if (!sendTerminalChatInterrupt(sessionId)) {
      toast.error(t('chat.terminalSendFailed'));
      return;
    }
    requestAnimationFrame(() => {
      terminalChatOverlayRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-testid="terminal-chat-composer-input"]')
        ?.focus();
    });
  }, [sessionId, t]);

  const handleTerminalChatKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key !== 'Escape'
        || event.nativeEvent.isComposing
        || !isTerminalTurnProcessing
        || !canEscapeInterrupt
      ) return;
      event.preventDefault();
      interruptTerminalChat();
    },
    [canEscapeInterrupt, interruptTerminalChat, isTerminalTurnProcessing],
  );

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-(--chat-bg)">
        <div className="text-center">
          <MessageSquare className="w-12 h-12 text-(--text-muted) mx-auto mb-3 opacity-30" />
          <p className="text-(--text-muted)">
            {t("chat.selectOrCreateSession")}
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <SessionNotFound sessionId={sessionId} />;
  }

  if (integrationRecovery) {
    return (
      <div className="flex flex-1 items-center justify-center bg-(--chat-bg) p-6">
        <section
          role="alert"
          data-testid="provider-integration-recovery"
          data-reason={integrationRecovery.reason}
          className="w-full max-w-lg rounded-2xl border border-amber-500/30 bg-(--chat-header-bg) p-5 shadow-xl"
        >
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="font-semibold text-(--text-primary)">{integrationRecovery.title}</h3>
              <p className="mt-1 text-sm leading-6 text-(--text-secondary)">{integrationRecovery.message}</p>
              {integrationRecovery.updateCommand ? (
                <code className="mt-3 block overflow-x-auto rounded-lg bg-black/10 px-3 py-2 text-xs dark:bg-white/8">
                  {integrationRecovery.updateCommand}
                </code>
              ) : null}
              <Button
                className="mt-4"
                size="sm"
                onClick={() => {
                  setIntegrationRecovery(sessionId, null);
                  wsClient.retrySession(sessionId);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {integrationRecovery.retryLabel}
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-(--chat-bg)">
        <div className="text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-(--status-error-text) mx-auto" />
          <p className="text-(--text-muted)">{error}</p>
          <Button
            onClick={() => {
              clearError(sessionId);
              viewSession(session, { activate: false });
            }}
          >
            {t("chat.retry")}
          </Button>
        </div>
      </div>
    );
  }

  // 터미널 세션은 메시지 히스토리 도착을 기다릴 이유가 없다 — GUI 메시지 골격을
  // 그리면 PTY로 교체될 때 깜빡인다. 터미널 분기로 바로 진행한다.
  if (messages === undefined && !isTerminalSession) {
    if (!isPeek) return <ChatAreaSkeleton isSinglePanel={isSinglePanel} />;
    return shouldShowPeekLoading ? <SessionPeekLoading /> : null;
  }

  const isUnifiedSession = "isRunning" in session;
  const isReadOnly = isUnifiedSession ? Boolean(session.isReadOnly || session.archived) : false;
  const rawStatus =
    isUnifiedSession && "status" in session ? session.status : undefined;
  const sessionStatus = isUnifiedSession
    ? session.isRunning
      ? "running"
      : rawStatus || "completed"
    : (session as any).status;

  const isStopped = sessionStatus !== "running";
  const isInputDisabled =
    connectionStatus !== "connected" || sessionStatus === "error";

  return (
    <div className="flex-1 flex flex-col h-full bg-(--chat-bg)">
      {!isPeek && shouldShowSessionHeader({
        isTerminalSession,
        isSinglePanel,
        canToggleTerminalChatView,
      }) && (
        <Header
          sessionId={sessionId}
          panelId={panelId}
          projectViewDir={projectViewDir}
          isSinglePanel={isSinglePanel}
          search={{
            isOpen: messageSearch.isSearchOpen,
            query: messageSearch.query,
            matchCount: messageSearch.matches.length,
            activeMatchIndex: messageSearch.activeMatchIndex,
            hasMore,
            onOpen: messageSearch.openSearch,
            onClose: messageSearch.closeSearch,
            onQueryChange: messageSearch.setQuery,
            onNext: messageSearch.goToNextMatch,
            onPrevious: messageSearch.goToPreviousMatch,
          }}
        />
      )}

      <div className="relative flex-1 overflow-hidden">
        {isTerminalSession ? (
          isPendingCreation ? (
            // 생성 대기 표면: 터미널 기본 배경(TERMINAL_LIGHT/DARK_THEME)과 같은 색만
            // 유지해 GUI 골격 없이 실제 TerminalPanel로 이어지게 한다.
            <div
              className="h-full w-full bg-[#fafaf9] dark:bg-[#161616]"
              data-testid="terminal-pending-surface"
            />
          ) : terminalId && sessionProvider ? (
            <TerminalPanel
              key={terminalId}
              panelId={panelId}
              terminalId={terminalId}
              terminalSessionId={sessionId}
              runtimeOwnership={isPeek
                ? 'session-peek'
                : isPreviewTab
                  ? 'session-preview'
                  : 'session-retained'}
              surfaceActive={isPeek}
              startupOverlay={shouldShowPeekLoading ? <SessionPeekLoading /> : undefined}
              launch={{ providerId: sessionProvider, sessionId }}
              offerSkillOnboarding={session.hasStarted === false}
            />
          ) : null
        ) : (
          <MessageList
            messages={windowedMessages}
            isLoading={isLoading}
            sessionId={sessionId}
            projectViewDir={projectViewDir}
            hasMore={hasMore}
            onLoadMore={loadMore}
            isLoadingMore={isLoadingMore}
            isSinglePanel={isSinglePanel}
            isTabActive={isViewActive}
            isTurnInFlight={isTurnInFlight}
            search={{
              activeMatchMessageId: messageSearch.activeMatch?.messageId ?? null,
              activeGroupedRowIndex: messageSearch.activeGroupedRowIndex,
            }}
          />
        )}

        {/* PTY 위에 덮는 읽기 전용 대화. 밑의 TerminalPanel은 계속 살아 있다. */}
        {isTerminalChatView && (
          <div
            ref={terminalChatOverlayRef}
            className="absolute inset-0 z-10 flex flex-col bg-(--chat-bg)"
            data-testid="terminal-chat-overlay"
            onKeyDownCapture={handleTerminalChatKeyDown}
          >
            {/* MessageList는 h-full이라 높이를 부모가 확정해줘야 한다. flex 아이템의
                기본 min-height:auto 때문에 min-h-0이 없으면 목록이 자연 높이로
                늘어나 컴포저를 화면 밖으로 밀어낸다. */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <MessageList
                messages={windowedMessages}
                isLoading={isLoading || isHistoryLoading}
                sessionId={sessionId}
                projectViewDir={projectViewDir}
                hasMore={hasMore}
                onLoadMore={loadMore}
                isLoadingMore={isLoadingMore}
                isSinglePanel={isSinglePanel}
                isTabActive={isViewActive}
                isTurnInFlight={isTerminalTurnProcessing}
                // PTY 세션의 턴은 chat-store가 아니라 provider 훅이 소유한다.
                forceWaitingIndicator={isTerminalTurnProcessing}
                search={{
                  activeMatchMessageId: messageSearch.activeMatch?.messageId ?? null,
                  activeGroupedRowIndex: messageSearch.activeGroupedRowIndex,
                }}
              />
            </div>
            <TerminalChatComposer
              sessionId={sessionId}
              isSinglePanel={isSinglePanel}
              onInterrupt={interruptTerminalChat}
            />
          </div>
        )}
      </div>

      {/* 채팅 전용 하단 UI — 터미널 세션에서는 숨긴다(입력은 터미널에 직접). */}
      {!isTerminalSession && (
        <>
          {!isReadOnly && <InteractivePromptOverlay sessionId={sessionId} />}

          <div className="max-h-[45vh] overflow-y-auto">
            <WorkflowStatusBar sessionId={sessionId} isSinglePanel={isSinglePanel} />
            <TodoStatusBar sessionId={sessionId} isSinglePanel={isSinglePanel} />
            <CompactStatusBar sessionId={sessionId} isSinglePanel={isSinglePanel} />
          </div>

          <MessageInput
            sessionId={sessionId}
            projectViewDir={projectViewDir}
            isDisabled={isInputDisabled}
            isReadOnly={isReadOnly}
            isStopped={isStopped}
            isSinglePanel={isSinglePanel}
            surfaceActive={isPeek}
          />
        </>
      )}
    </div>
  );
});

function SessionPeekLoading() {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full flex-1 items-center justify-center bg-(--chat-bg)"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="kanban-session-peek-loading"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <LoaderCircle
          className="h-7 w-7 animate-spin text-(--accent) motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-sm text-(--text-muted)">{t("chat.loadingSession")}</p>
      </div>
    </div>
  );
}

function SessionNotFound({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const panelCount = usePanelStore((s) => Object.keys(selectActiveTab(s)?.panels ?? EMPTY_PANELS).length);
  const closePanel = usePanelStore((s) => s.closePanel);
  const clearSession = usePanelStore((s) => s.assignSession);

  const panelId = usePanelStore((s) => {
    const panels = selectActiveTab(s)?.panels ?? EMPTY_PANELS;
    const entry = Object.entries(panels).find(
      ([, p]) => p.sessionId === sessionId,
    );
    return entry?.[0] ?? null;
  });

  const handleClose = () => {
    if (!panelId) return;
    if (panelCount >= 2) {
      closePanel(panelId);
    } else {
      clearSession(panelId, null);
    }
  };

  return (
    <div className="relative flex-1 flex items-center justify-center bg-(--chat-bg)">
      <button
        onClick={handleClose}
        title={
          panelCount >= 2 ? t("chat.removePanel") : t("chat.releaseSession")
        }
        className="absolute top-3 right-3 p-1.5 rounded hover:bg-(--sidebar-hover) text-(--text-muted) hover:text-(--text-primary) transition-colors"
      >
        <XIcon className="w-4 h-4" />
      </button>
      <div className="text-center">
        <MessageSquare className="w-12 h-12 text-(--text-muted) mx-auto mb-3 opacity-30" />
        <p className="text-(--text-muted)">{t("chat.sessionNotFound")}</p>
        <p className="text-xs text-(--text-muted) mt-2 opacity-60">
          {panelCount >= 2
            ? t("chat.removePanelHint")
            : t("chat.releaseSessionHint")}
        </p>
      </div>
    </div>
  );
}
