"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/stores/chat-store";
import { wsClient } from "@/lib/ws/client";
import type { ServerTransportMessage } from "@/lib/ws/message-types";

const FALLBACK_POLL_INTERVAL_MS = 2_000;

type WorkspaceFilesChangedMessage = Extract<
  ServerTransportMessage,
  { type: "workspace_files_changed" }
>;

function createSubscriberId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}:${random}`;
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  return visible;
}

export function useStableWorkspaceFilesSubscriberId(prefix: string): string {
  const [subscriberId] = useState(() => createSubscriberId(prefix));
  return subscriberId;
}

export function useWorkspaceFilesLiveSync({
  enabled,
  onFilesChanged,
  onRefresh,
  refreshOnTreeChange = true,
  sessionId,
  subscriberId,
}: {
  enabled: boolean;
  onFilesChanged?: (msg: WorkspaceFilesChangedMessage) => void;
  onRefresh: () => void;
  refreshOnTreeChange?: boolean;
  sessionId: string | null;
  subscriberId: string;
}): void {
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const [fallbackPolling, setFallbackPolling] = useState(false);
  const onFilesChangedRef = useRef(onFilesChanged);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onFilesChangedRef.current = onFilesChanged;
  }, [onFilesChanged]);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled || !sessionId || connectionStatus !== "connected") {
      return;
    }

    const sent = wsClient.subscribeWorkspaceFiles(sessionId, subscriberId);
    if (!sent) {
      queueMicrotask(() => setFallbackPolling(true));
      onRefreshRef.current();
      return;
    }
    onRefreshRef.current();

    return () => {
      setFallbackPolling(false);
      wsClient.unsubscribeWorkspaceFiles(sessionId, subscriberId);
    };
  }, [connectionStatus, enabled, sessionId, subscriberId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    const unsubscribe = wsClient.subscribeServerMessages((msg: ServerTransportMessage) => {
      if (
        msg.type === "workspace_file_watch_status"
        && msg.sessionId === sessionId
        && msg.subscriberId === subscriberId
      ) {
        setFallbackPolling(msg.status === "fallback");
        return;
      }

      if (
        msg.type === "workspace_files_changed"
        && msg.sessionIds.includes(sessionId)
      ) {
        onFilesChangedRef.current?.(msg);
        if (refreshOnTreeChange && msg.treeChanged) {
          onRefreshRef.current();
        }
      }
    });

    return unsubscribe;
  }, [enabled, refreshOnTreeChange, sessionId, subscriberId]);

  useEffect(() => {
    if (!enabled || !sessionId || !fallbackPolling) return;
    const timer = window.setInterval(() => {
      onRefreshRef.current();
    }, FALLBACK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, fallbackPolling, sessionId]);
}
