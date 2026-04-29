"use client";

import { memo, useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionNavigation } from "@/hooks/use-session-navigation";
import { useWindowedMessages } from "@/hooks/use-windowed-messages";
import { Header } from "./header";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { InteractivePromptOverlay } from "./interactive-prompt-overlay";
import { MessageSquare, AlertCircle, X as XIcon } from "lucide-react";
import { ChatAreaSkeleton } from "./chat-area-skeleton";
import { Button } from "@/components/ui/button";
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from "@/stores/panel-store";
import { useI18n } from "@/lib/i18n";

interface ChatAreaProps {
  sessionId: string;
}

export const ChatArea = memo(function ChatArea({ sessionId }: ChatAreaProps) {
  const { t } = useI18n();
  const { windowedMessages, hasMore, loadMore, isLoadingMore } =
    useWindowedMessages(sessionId);
  const isSinglePanel = usePanelStore(
    (state) => Object.keys(selectActiveTab(state)?.panels ?? EMPTY_PANELS).length <= 1,
  );

  const session = useSessionStore((state) => state.getSession(sessionId));
  const messages = useChatStore((state) => state.messages.get(sessionId));
  const error = useChatStore((state) => state.errors.get(sessionId));
  const clearError = useChatStore((state) => state.clearError);
  const isLoading = useChatStore((state) => state.isLoading);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const { viewSession } = useSessionNavigation();

  const historyLoaded = useChatStore((state) =>
    state.isHistoryLoaded(sessionId),
  );
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (session && !historyLoaded) {
      autoLoadedRef.current = true;
      viewSession(session);
    }
  }, [session, historyLoaded, viewSession]);

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

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-(--chat-bg)">
        <div className="text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-(--status-error-text) mx-auto" />
          <p className="text-(--text-muted)">{error}</p>
          <Button
            onClick={() => {
              clearError(sessionId);
              viewSession(session);
            }}
          >
            {t("chat.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (messages === undefined) {
    return <ChatAreaSkeleton isSinglePanel={isSinglePanel} />;
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
      <Header sessionId={sessionId} isSinglePanel={isSinglePanel} />

      <div className="flex-1 overflow-hidden">
        <MessageList
          messages={windowedMessages}
          isLoading={isLoading}
          sessionId={sessionId}
          hasMore={hasMore}
          onLoadMore={loadMore}
          isLoadingMore={isLoadingMore}
          isSinglePanel={isSinglePanel}
        />
      </div>

      {!isReadOnly && <InteractivePromptOverlay sessionId={sessionId} />}

      <MessageInput
        sessionId={sessionId}
        isDisabled={isInputDisabled}
        isReadOnly={isReadOnly}
        isStopped={isStopped}
        isSinglePanel={isSinglePanel}
      />
    </div>
  );
});

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
