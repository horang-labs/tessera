"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { WorkspaceCodeView } from "@/components/workspace/workspace-code-view";
import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import {
  useDocumentVisibility,
  useStableWorkspaceFilesSubscriberId,
  useWorkspaceFilesLiveSync,
} from "@/hooks/use-workspace-files-live-sync";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { wsClient } from "@/lib/ws/client";
import { usePanelStore, selectActiveTab, EMPTY_PANELS, TabIdContext } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";
import {
  buildWorkspaceFileSessionId,
  type WorkspaceFileSessionRef,
} from "@/lib/workspace-tabs/special-session";
import type { ServerTransportMessage } from "@/lib/ws/message-types";

type WorkspaceFilesChangedMessage = Extract<
  ServerTransportMessage,
  { type: "workspace_files_changed" }
>;

interface WorkspaceFileTabState {
  loading: boolean;
  error: string | null;
  data: WorkspaceFileData | GitDiffData | null;
}

const FILE_LOAD_TIMEOUT_MS = 3_000;
const FILE_LOAD_TIMEOUT_MESSAGE =
  "The file did not load in time. The workspace filesystem or git may be unresponsive.";

function getFileUrl(ref: WorkspaceFileSessionRef): string {
  const sessionId = encodeURIComponent(ref.sourceSessionId);
  const path = encodeURIComponent(ref.path);
  if (ref.kind === "diff") return `/api/sessions/${sessionId}/git/diff?path=${path}`;
  return `/api/sessions/${sessionId}/file?path=${path}`;
}

function getDirectoryName(filePath: string): string {
  const slashIndex = filePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : filePath.slice(0, slashIndex);
}

function findRenameTarget(
  msg: WorkspaceFilesChangedMessage,
  filePath: string,
): string | null {
  if (
    msg.hasMoreChangedPaths
    || msg.deletedPaths.length !== 1
    || msg.addedPaths.length !== 1
    || msg.deletedPaths[0] !== filePath
  ) {
    return null;
  }

  const currentDirectory = getDirectoryName(filePath);
  const addedPath = msg.addedPaths[0];
  return getDirectoryName(addedPath) === currentDirectory ? addedPath : null;
}

function shouldRefreshForSession(
  msg: ServerTransportMessage,
  sessionId: string,
): boolean {
  switch (msg.type) {
    case "git_panel_state":
    case "session_history":
    case "session_stopped":
    case "cli_down":
      return msg.sessionId === sessionId;
    case "notification":
      return msg.sessionId === sessionId && msg.event === "completed";
    case "worktree_diff_stats":
      return msg.sessionIds.includes(sessionId);
    case "replay_events":
      return msg.sessionId === sessionId
        && msg.events.some((event) =>
          event.type === "tool_call"
          && event.status === "completed"
          && (event.toolKind === "file_edit" || event.toolKind === "file_write")
        );
    default:
      return false;
  }
}

export function WorkspaceFileTab({
  fileRef,
  panelId,
}: {
  fileRef: WorkspaceFileSessionRef;
  panelId: string;
}) {
  const { kind, path, sourceSessionId } = fileRef;
  const tabId = useContext(TabIdContext);
  const isTabActive = useTabStore((state) => state.activeTabId === tabId);
  const isDocumentVisible = useDocumentVisibility();
  const subscriberId = useStableWorkspaceFilesSubscriberId("workspace-file-tab");
  const panelCount = usePanelStore(
    (state) => Object.keys(selectActiveTab(state)?.panels ?? EMPTY_PANELS).length,
  );
  const closePanel = usePanelStore((state) => state.closePanel);
  const assignSession = usePanelStore((state) => state.assignSession);
  const [state, setState] = useState<WorkspaceFileTabState>({
    loading: true,
    error: null,
    data: null,
  });
  const requestSeqRef = useRef(0);
  const activeLoadsRef = useRef(0);

  const loadFile = useCallback(async (options?: {
    signal?: AbortSignal;
    silent?: boolean;
  }) => {
    // A silent refresh must not supersede an in-flight load: bumping the
    // sequence would discard that load's response while loading stays true.
    if (options?.silent && activeLoadsRef.current > 0) return;

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    if (!options?.silent) {
      setState({
        loading: true,
        error: null,
        data: null,
      });
    }

    activeLoadsRef.current += 1;
    try {
      const response = await fetchWithTimeout(
        getFileUrl({ type: "workspace-file", sourceSessionId, kind, path }),
        { signal: options?.signal, timeoutMs: FILE_LOAD_TIMEOUT_MS, retries: 1 },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, "Failed to load file."));
      }
      if (payload === null) {
        throw new Error("Failed to load file.");
      }

      if (requestSeqRef.current !== requestSeq) return;
      setState({
        loading: false,
        error: null,
        data: payload as WorkspaceFileData | GitDiffData,
      });
    } catch (error) {
      if (options?.signal?.aborted || requestSeqRef.current !== requestSeq) return;
      const message = isTimeoutError(error)
        ? FILE_LOAD_TIMEOUT_MESSAGE
        : error instanceof Error ? error.message : "Failed to load file.";
      if (options?.silent) {
        // Keep showing current content when a background refresh fails.
        setState((current) => (
          current.data ? current : { loading: false, error: message, data: null }
        ));
      } else {
        setState({
          loading: false,
          error: message,
          data: null,
        });
      }
    } finally {
      activeLoadsRef.current -= 1;
    }
  }, [kind, path, sourceSessionId]);

  const refreshFile = useCallback(() => {
    void loadFile({ silent: true });
  }, [loadFile]);

  const handleWorkspaceFilesChanged = useCallback((msg: WorkspaceFilesChangedMessage) => {
    if (!msg.sessionIds.includes(sourceSessionId)) return;

    const renameTarget = findRenameTarget(msg, path);
    if (renameTarget) {
      assignSession(
        panelId,
        buildWorkspaceFileSessionId(sourceSessionId, kind, renameTarget),
      );
      return;
    }

    if (msg.deletedPaths.includes(path)) {
      void loadFile();
      return;
    }

    if (msg.hasMoreChangedPaths || msg.changedPaths.includes(path)) {
      refreshFile();
    }
  }, [assignSession, kind, loadFile, panelId, path, refreshFile, sourceSessionId]);

  useWorkspaceFilesLiveSync({
    enabled: isTabActive && isDocumentVisible,
    onFilesChanged: handleWorkspaceFilesChanged,
    onRefresh: refreshFile,
    refreshOnTreeChange: false,
    sessionId: sourceSessionId,
    subscriberId,
  });

  useEffect(() => {
    const abortController = new AbortController();
    void loadFile({ signal: abortController.signal });
    return () => abortController.abort();
  }, [loadFile]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const abortController = new AbortController();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        void loadFile({ signal: abortController.signal, silent: true });
      }
    };

    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    return () => {
      abortController.abort();
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
    };
  }, [loadFile]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const abortController = new AbortController();
    const scheduleRefresh = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadFile({ signal: abortController.signal, silent: true });
      }, 250);
    };

    const unsubscribe = wsClient.subscribeServerMessages((msg) => {
      if (shouldRefreshForSession(msg, sourceSessionId)) {
        scheduleRefresh();
      }
    });

    return () => {
      unsubscribe();
      abortController.abort();
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [loadFile, sourceSessionId]);

  return (
    <WorkspaceCodeView
      data={state.data}
      error={state.error}
      loading={state.loading}
      mode={fileRef.kind}
      onClose={() => {
        if (panelCount >= 2) {
          closePanel(panelId);
        } else {
          assignSession(panelId, null);
        }
      }}
      onRetry={() => void loadFile()}
      path={fileRef.path}
      sourceSessionId={sourceSessionId}
    />
  );
}
