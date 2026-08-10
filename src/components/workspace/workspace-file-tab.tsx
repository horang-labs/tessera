"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { toast } from "@/stores/notification-store";
import {
  clearSelfWrite,
  isSelfWrite,
  markSelfWrite,
} from "@/lib/workspace-files/workspace-self-write-registry";
import {
  clearWorkspaceFileDirty,
  markWorkspaceFileDirty,
} from "@/lib/workspace-files/workspace-dirty-registry";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";
import {
  buildWorkspaceFileSessionId,
  type WorkspaceFileRef,
} from "@/lib/workspace-tabs/special-session";
import type { ServerTransportMessage } from "@/lib/ws/message-types";
import type { WorkspaceTarget } from '@/types/worktree';

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

function getFileUrl(target: WorkspaceTarget, kind: 'file' | 'diff', filePath: string): string {
  const path = encodeURIComponent(filePath);
  if (target.kind === 'worktree') {
    return `/api/worktrees/${encodeURIComponent(target.id)}/file?path=${path}`;
  }
  const sessionId = encodeURIComponent(target.id);
  if (kind === "diff") return `/api/sessions/${sessionId}/git/diff?path=${path}`;
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
  surfaceActive = false,
  onClose,
  onFileRefChange,
}: {
  fileRef: WorkspaceFileRef;
  panelId: string;
  surfaceActive?: boolean;
  onClose?: () => void;
  onFileRefChange?: (fileRef: WorkspaceFileRef) => void;
}) {
  const { kind, path } = fileRef;
  const sourceSessionId = fileRef.type === 'workspace-file' ? fileRef.sourceSessionId : null;
  const sourceTargetKind = fileRef.type === 'worktree-file' ? 'worktree' : 'session';
  const sourceTargetId = fileRef.type === 'worktree-file'
    ? fileRef.sourceWorktreeId
    : fileRef.sourceSessionId;
  const sourceTarget = useMemo<WorkspaceTarget>(
    () => ({ kind: sourceTargetKind, id: sourceTargetId }),
    [sourceTargetId, sourceTargetKind],
  );
  const tabId = useContext(TabIdContext);
  const isTabActive = useTabStore((state) => surfaceActive || state.activeTabId === tabId);
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
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const requestSeqRef = useRef(0);
  const activeLoadsRef = useRef(0);
  const dirtyRef = useRef(false);

  const fileData = kind === "file" ? (state.data as WorkspaceFileData | null) : null;
  // A truncated buffer holds only the first 512 KB: saving it back would delete
  // everything past that. A binary file has no text buffer to edit at all.
  const editable = fileData !== null && !fileData.binary && !fileData.truncated;
  const dirty = editable && draft !== null && draft !== fileData.content;
  dirtyRef.current = dirty;

  // The explorer confirms deletes, and a delete discards the draft with the
  // file, so the dirty state has to be visible from outside this tab (#320).
  useEffect(() => {
    if (kind !== "file") return;
    if (!sourceSessionId) return;
    if (dirty) {
      markWorkspaceFileDirty(sourceSessionId, path);
    } else {
      clearWorkspaceFileDirty(sourceSessionId, path);
    }
    return () => clearWorkspaceFileDirty(sourceSessionId, path);
  }, [dirty, kind, path, sourceSessionId]);

  // A preview tab is replaced by the next previewed file without warning; pin
  // it as soon as there are unsaved edits so the draft cannot vanish.
  useEffect(() => {
    if (!dirty) return;
    if (!sourceSessionId) return;
    const tabStore = useTabStore.getState();
    const location = tabStore.findSessionLocation(
      buildWorkspaceFileSessionId(sourceSessionId, kind, path),
    );
    if (location) tabStore.pinTab(location.tabId);
  }, [dirty, kind, path, sourceSessionId]);

  const loadFile = useCallback(async (options?: {
    signal?: AbortSignal;
    silent?: boolean;
  }) => {
    // A silent refresh must not supersede an in-flight load: bumping the
    // sequence would discard that load's response while loading stays true.
    // Nor may it wipe unsaved edits — a draft outranks disk content.
    if (options?.silent && (dirtyRef.current || activeLoadsRef.current > 0)) return;

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    if (!options?.silent) {
      setState({
        loading: true,
        error: null,
        data: null,
      });
      setDraft(null);
      setConflict(false);
    }

    activeLoadsRef.current += 1;
    try {
      const response = await fetchWithTimeout(
        getFileUrl(sourceTarget, kind, path),
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
      // The dirty flag can flip while the request is in flight.
      if (options?.silent && dirtyRef.current) return;
      setState({
        loading: false,
        error: null,
        data: payload as WorkspaceFileData | GitDiffData,
      });
      setDraft(null);
      setConflict(false);
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
  }, [kind, path, sourceTarget]);

  const refreshFile = useCallback(() => {
    void loadFile({ silent: true });
  }, [loadFile]);

  /**
   * Decide whether a watcher event really touched *this* file.
   *
   * A watcher event is only a hint: `changedPaths` is capped, so
   * `hasMoreChangedPaths` says "the list overflowed", not "your file changed".
   * The mtime we loaded is the actual test — the same baseline the save sends —
   * so raising the banner on the event alone would nag on any large agent edit.
   */
  const confirmExternalChange = useCallback(async () => {
    const data = kind === "file" ? (state.data as WorkspaceFileData | null) : null;
    if (!data) return;

    try {
      const response = await fetchWithTimeout(
        getFileUrl(sourceTarget, kind, path),
        { timeoutMs: FILE_LOAD_TIMEOUT_MS, retries: 1 },
      );
      if (response.status === 404) {
        setConflict(true);
        return;
      }
      const payload = await response.json().catch(() => null) as WorkspaceFileData | null;
      if (!response.ok || payload === null) return;
      if (payload.mtimeMs !== data.mtimeMs) setConflict(true);
    } catch {
      // Leave it to the save's own 409: a failed probe is not evidence of a change.
    }
  }, [kind, path, sourceTarget, state.data]);

  const handleWorkspaceFilesChanged = useCallback((msg: WorkspaceFilesChangedMessage) => {
    if (!sourceSessionId) return;
    if (!msg.sessionIds.includes(sourceSessionId)) return;

    const renameTarget = findRenameTarget(msg, path);
    if (renameTarget) {
      if (onFileRefChange) {
        onFileRefChange({
          type: "workspace-file",
          sourceSessionId,
          kind,
          path: renameTarget,
        });
        return;
      }
      assignSession(
        panelId,
        buildWorkspaceFileSessionId(sourceSessionId, kind, renameTarget),
      );
      return;
    }

    if (msg.deletedPaths.includes(path)) {
      // Reloading would drop the draft; let the save report the conflict.
      if (dirtyRef.current) {
        setConflict(true);
        return;
      }
      void loadFile();
      return;
    }

    if (msg.hasMoreChangedPaths || msg.changedPaths.includes(path)) {
      // The watcher echo of our own save is not an external change.
      if (isSelfWrite(sourceSessionId, path)) return;
      if (dirtyRef.current) {
        void confirmExternalChange();
        return;
      }
      refreshFile();
    }
  }, [
    assignSession,
    confirmExternalChange,
    kind,
    loadFile,
    onFileRefChange,
    panelId,
    path,
    refreshFile,
    sourceSessionId,
  ]);

  useWorkspaceFilesLiveSync({
    enabled: Boolean(sourceSessionId) && isTabActive && isDocumentVisible,
    onFilesChanged: handleWorkspaceFilesChanged,
    onRefresh: refreshFile,
    refreshOnTreeChange: false,
    sessionId: sourceSessionId ?? '',
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
      if (sourceSessionId && shouldRefreshForSession(msg, sourceSessionId)) {
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

  const saveFile = useCallback(async (options?: { overwrite?: boolean }) => {
    const data = kind === "file" ? (state.data as WorkspaceFileData | null) : null;
    if (!data || data.binary || data.truncated || draft === null || saving) return;
    if (!sourceSessionId) return;

    setSaving(true);
    // Stamped before the request so the watcher event, which can arrive while
    // the PUT is still in flight, is already recognised as our own.
    markSelfWrite(sourceSessionId, path);
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sourceSessionId)}/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            content: draft,
            // Overwrite deliberately drops the lock: the user has seen the
            // banner and chosen their version over what is on disk.
            ...(options?.overwrite ? {} : { baseMtimeMs: data.mtimeMs }),
          }),
          timeoutMs: FILE_LOAD_TIMEOUT_MS,
        },
      );
      const payload = await response.json().catch(() => null) as
        | { mtimeMs?: number; size?: number; error?: { code?: string; message?: string } }
        | null;
      if (response.status === 409) {
        clearSelfWrite(sourceSessionId, path);
        setConflict(true);
        return;
      }
      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, "Failed to save file."));
      }

      // Invalidate loads started before the save so a stale response cannot
      // overwrite the freshly saved state.
      requestSeqRef.current += 1;
      setState({
        loading: false,
        error: null,
        data: {
          ...data,
          content: draft,
          // The new mtime is the next baseline, which is what actually stops
          // our own write from reading as an external change.
          mtimeMs: payload?.mtimeMs ?? data.mtimeMs,
          size: payload?.size ?? data.size,
        },
      });
      // Only clear the draft when it still equals what was saved — the user
      // may have kept typing while the PUT was in flight.
      setDraft((current) => (current === draft ? null : current));
      setConflict(false);
      toast.success(`Saved ${path}`);
    } catch (error) {
      clearSelfWrite(sourceSessionId, path);
      const message = isTimeoutError(error)
        ? "The file did not save in time. The workspace filesystem may be unresponsive."
        : error instanceof Error ? error.message : "Failed to save file.";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [draft, kind, path, saving, sourceSessionId, state.data]);

  return (
    <WorkspaceCodeView
      conflict={conflict}
      data={state.data}
      dirty={dirty}
      draft={draft}
      editable={editable}
      error={state.error}
      loading={state.loading}
      mode={fileRef.kind}
      onCancelConflict={() => setConflict(false)}
      onDraftChange={setDraft}
      onOverwrite={() => void saveFile({ overwrite: true })}
      onReload={() => void loadFile()}
      onSave={() => void saveFile()}
      saving={saving}
      onClose={() => {
        if (onClose) {
          onClose();
          return;
        }
        if (panelCount >= 2) {
          closePanel(panelId);
        } else {
          assignSession(panelId, null);
        }
      }}
      onRetry={() => void loadFile()}
      path={fileRef.path}
      sourceTarget={sourceTarget}
    />
  );
}
