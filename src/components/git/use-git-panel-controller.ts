"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wsClient } from "@/lib/ws/client";
import { isTurnInFlight, useChatStore } from "@/stores/chat-store";
import { useGitPanelStore } from "@/stores/git-panel-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useSessionStore } from "@/stores/session-store";
import { useTaskStore } from "@/stores/task-store";
import type {
  GitChangedFilesData,
  GitDiffData,
  GitPanelData,
} from "@/types/git";
import type { WorkflowStatus } from "@/types/task-entity";
import type { GitActionId } from "@/lib/git/action-templates";
import { buildGitActionPrompt } from "./git-action-prompts";
import {
  type ActiveGitAction,
  extractGitPanelErrorMessage,
  getGitHubActionBlockReason,
} from "./git-panel-shared";

// Optimistic session IDs created by use-session-crud.ts before the server
// responds with the real id. These never exist in the server DB, so any
// /git fetch against them would 404 with "Session not found".
function isTransientSessionId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith("temp-");
}

interface GitPanelSessionCacheEntry {
  diffCache: Record<string, GitDiffData>;
  selectedPath: string | null;
}

const PANEL_CACHE_LIMIT = 20;
const gitPanelSessionCache = new Map<string, GitPanelSessionCacheEntry>();

function getPanelSessionCache(
  sessionId: string | null,
): GitPanelSessionCacheEntry | null {
  if (!sessionId) return null;
  const cached = gitPanelSessionCache.get(sessionId) ?? null;
  if (!cached) return null;

  gitPanelSessionCache.delete(sessionId);
  gitPanelSessionCache.set(sessionId, cached);
  return cached;
}

function rememberPanelSessionCache(
  sessionId: string | null,
  entry: GitPanelSessionCacheEntry,
) {
  if (!sessionId) return;

  gitPanelSessionCache.delete(sessionId);
  gitPanelSessionCache.set(sessionId, entry);

  while (gitPanelSessionCache.size > PANEL_CACHE_LIMIT) {
    const oldest = gitPanelSessionCache.keys().next().value;
    if (!oldest) break;
    gitPanelSessionCache.delete(oldest);
  }
}

export function useGitPanelController(sessionId: string | null) {
  const initialCache = getPanelSessionCache(sessionId);
  const data = useGitPanelStore((state) =>
    sessionId ? state.dataBySessionId[sessionId] ?? null : null,
  );
  const applyGitPanelData = useGitPanelStore((state) => state.applyGitPanelData);
  const [loading, setLoading] = useState(() => {
    if (!sessionId || isTransientSessionId(sessionId)) return false;
    return !useGitPanelStore.getState().dataBySessionId[sessionId];
  });
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => initialCache?.selectedPath ?? null,
  );
  const [diffCache, setDiffCache] = useState<Record<string, GitDiffData>>(
    () => initialCache?.diffCache ?? {},
  );
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [activeAction, setActiveAction] = useState<ActiveGitAction>(null);
  const [actionInput, setActionInput] = useState("");
  const [mergeSource, setMergeSource] = useState("");
  const [mergePrPromptDraft, setMergePrPromptDraft] = useState("");
  const [prBaseBranch, setPrBaseBranch] = useState("");
  const lastDiffStatsTokenRef = useRef<string | null>(null);

  const isSessionBusy = useChatStore(
    (state) => (sessionId ? isTurnInFlight(state, sessionId) : false),
  );
  const sessionSnapshot = useSessionStore((state) =>
    sessionId ? state.getSession(sessionId) : undefined,
  );
  const taskSnapshot = useTaskStore((state) =>
    sessionId ? state.getTaskBySessionId(sessionId) : undefined,
  );
  const liveTaskId = data?.taskId ?? taskSnapshot?.id;
  const livePrStatus = useTaskStore((state) =>
    liveTaskId ? state.prStatusByTaskId[liveTaskId] : undefined,
  );
  const gitConfig = useSettingsStore((state) => state.settings.gitConfig);

  const loadPanel = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;

    if (!sessionId || isTransientSessionId(sessionId)) {
      setError(null);
      setLoading(false);
      return;
    }

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git`);
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Race: optimistic session id resolved on the client before the DB
        // row is visible. Stay quiet — the next sessionId change (or a retry
        // via visibilitychange) will pick up the real state.
        if (
          response.status === 404 &&
          (payload as { error?: { code?: string } } | null)?.error?.code ===
            "session_not_found"
        ) {
          return;
        }
        throw new Error(
          extractGitPanelErrorMessage(payload, "Failed to load git summary."),
        );
      }

      applyGitPanelData(sessionId, payload as GitPanelData);
      setError(null);
    } catch (nextError) {
      if (!silent) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to load git summary.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [applyGitPanelData, sessionId]);

  const loadChangedFiles = useCallback(async () => {
    if (!sessionId) return;

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/changes`,
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          extractGitPanelErrorMessage(payload, "Failed to load changed files."),
        );
      }

      const changedFilesPayload = payload as GitChangedFilesData;
      const current =
        useGitPanelStore.getState().dataBySessionId[sessionId];
      if (current && current.sessionId === sessionId) {
        applyGitPanelData(sessionId, {
          ...current,
          changedFiles: changedFilesPayload.changedFiles,
        });
      }
    } catch (nextError) {
      setDiffError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to load changed files.",
      );
    }
  }, [applyGitPanelData, sessionId]);

  useEffect(() => {
    const cached = getPanelSessionCache(sessionId);

    setError(null);
    setSelectedPath(cached?.selectedPath ?? null);
    setDiffCache(cached?.diffCache ?? {});
    setDiffError(null);

    if (!sessionId || isTransientSessionId(sessionId)) {
      setLoading(false);
      return;
    }

    const hasStoreData = Boolean(
      useGitPanelStore.getState().dataBySessionId[sessionId],
    );
    setLoading(!hasStoreData);

    void loadPanel({ silent: hasStoreData });
  }, [loadPanel, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    rememberPanelSessionCache(sessionId, {
      diffCache,
      selectedPath,
    });
  }, [diffCache, selectedPath, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (typeof document === "undefined") return;

    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        void loadPanel({ silent: true });
      }
    };

    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
    };
  }, [loadPanel, sessionId]);

  const panelData = useMemo<GitPanelData | null>(() => {
    if (!data) return null;

    const storeDiffStats =
      taskSnapshot?.diffStats !== undefined
        ? taskSnapshot.diffStats
        : sessionSnapshot?.diffStats;

    const livePr = taskSnapshot
      ? {
          prStatus: taskSnapshot.prStatus,
          prUnsupported: taskSnapshot.prUnsupported,
          remoteBranchExists: taskSnapshot.remoteBranchExists,
        }
      : livePrStatus;

    return {
      ...data,
      diffStats: storeDiffStats !== undefined ? storeDiffStats : data.diffStats,
      prStatus: livePr?.prStatus ?? data.prStatus,
      prUnsupported: livePr?.prUnsupported ?? data.prUnsupported,
      remoteBranchExists:
        livePr?.remoteBranchExists ?? data.remoteBranchExists,
    };
  }, [data, livePrStatus, sessionSnapshot?.diffStats, taskSnapshot]);

  const closeAction = useCallback(() => {
    setActiveAction(null);
    setActionInput("");
    setMergePrPromptDraft("");
  }, []);

  useEffect(() => {
    const files = panelData?.changedFiles ?? [];
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }

    if (!selectedPath || !files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0]?.path ?? null);
    }
  }, [panelData, selectedPath]);

  useEffect(() => {
    lastDiffStatsTokenRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const diffStatsToken = panelData?.diffStats?.computedAt ?? null;
    if (!sessionId || !diffStatsToken) return;

    if (lastDiffStatsTokenRef.current === null) {
      lastDiffStatsTokenRef.current = diffStatsToken;
      if (data?.diffStats?.computedAt === diffStatsToken) return;
    } else if (lastDiffStatsTokenRef.current === diffStatsToken) {
      return;
    } else {
      lastDiffStatsTokenRef.current = diffStatsToken;
    }

    const timer = window.setTimeout(() => {
      setDiffCache({});
      setDiffError(null);
      void loadChangedFiles();
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    data?.diffStats?.computedAt,
    loadChangedFiles,
    panelData?.diffStats?.computedAt,
    sessionId,
  ]);

  useEffect(() => {
    const prState = panelData?.prStatus?.state;
    const branchStillOnRemote = panelData?.remoteBranchExists !== false;
    const hasMergeablePr = prState === "open" && branchStillOnRemote;
    if (activeAction === "merge-pr" && !hasMergeablePr) {
      closeAction();
      return;
    }
    if (activeAction === "create-pr" && hasMergeablePr) {
      closeAction();
    }
  }, [
    activeAction,
    closeAction,
    panelData?.prStatus?.state,
    panelData?.remoteBranchExists,
  ]);

  useEffect(() => {
    if (!sessionId || !selectedPath || diffCache[selectedPath]) {
      return;
    }

    let cancelled = false;

    const loadDiff = async () => {
      setDiffLoading(true);
      setDiffError(null);

      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?path=${encodeURIComponent(selectedPath)}`,
        );
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            extractGitPanelErrorMessage(payload, "Failed to load diff preview."),
          );
        }

        if (!cancelled) {
          setDiffCache((current) => ({
            ...current,
            [selectedPath]: payload as GitDiffData,
          }));
        }
      } catch (nextError) {
        if (!cancelled) {
          setDiffError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load diff preview.",
          );
        }
      } finally {
        if (!cancelled) {
          setDiffLoading(false);
        }
      }
    };

    void loadDiff();

    return () => {
      cancelled = true;
    };
  }, [diffCache, selectedPath, sessionId]);

  const selectedFile = useMemo(
    () =>
      panelData?.changedFiles.find((file) => file.path === selectedPath) ?? null,
    [panelData, selectedPath],
  );
  const selectedFileIndex = useMemo(
    () =>
      selectedPath
        ? (panelData?.changedFiles.findIndex((file) => file.path === selectedPath) ?? -1)
        : -1,
    [panelData, selectedPath],
  );

  const changedFileCount = panelData?.changedFiles.length ?? 0;
  const diffData = selectedPath ? (diffCache[selectedPath] ?? null) : null;
  const checksUrl = panelData?.prStatus?.url
    ? `${panelData.prStatus.url}/checks`
    : null;

  const reloadPanel = useCallback(async () => {
    setDiffCache({});
    setDiffError(null);
    await loadPanel();
  }, [loadPanel]);

  const copyBranch = useCallback(async () => {
    if (!data?.branch || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(data.branch);
  }, [data?.branch]);

  const openExternal = useCallback((url: string | null | undefined) => {
    if (!url || typeof window === "undefined") return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      const files = panelData?.changedFiles ?? [];
      if (files.length === 0) return;

      const nextIndex = Math.max(
        0,
        Math.min(
          files.length - 1,
          (selectedFileIndex >= 0 ? selectedFileIndex : 0) + direction,
        ),
      );
      setSelectedPath(files[nextIndex]?.path ?? null);
    },
    [panelData, selectedFileIndex],
  );

  const sendActionPrompt = useCallback(
    (action: GitActionId, vars: Record<string, string>, hint?: string) => {
      if (!sessionId) return;

      wsClient.sendMessage(
        sessionId,
        buildGitActionPrompt({
          action,
          globalGuidelines: gitConfig.globalGuidelines,
          override: gitConfig.actionTemplates?.[action],
          vars,
          hint,
        }),
      );
    },
    [
      gitConfig.actionTemplates,
      gitConfig.globalGuidelines,
      sessionId,
    ],
  );

  const mergePrPromptPreview = useMemo(() => {
    const prNumber = panelData?.prStatus?.number;
    if (prNumber == null) return "";

    return buildGitActionPrompt({
      action: "mergePr",
      globalGuidelines: gitConfig.globalGuidelines,
      override: gitConfig.actionTemplates?.mergePr,
      vars: {
        branch: panelData?.branch ?? "",
        prNumber: String(prNumber),
      },
    });
  }, [
    gitConfig.actionTemplates,
    gitConfig.globalGuidelines,
    panelData?.branch,
    panelData?.prStatus?.number,
  ]);

  const updateCurrentTaskWorkflowStatus = useCallback(
    (workflowStatus: WorkflowStatus) => {
      const taskId = liveTaskId ?? sessionSnapshot?.taskId;
      if (!taskId) return;

      const taskFromStore = useTaskStore.getState().getTask(taskId);
      const previousWorkflowStatus =
        taskFromStore?.workflowStatus
        ?? taskSnapshot?.workflowStatus
        ?? sessionSnapshot?.workflowStatus
        ?? "todo";

      if (previousWorkflowStatus === workflowStatus) return;

      const shouldSyncSessionFallback =
        !taskFromStore && !!sessionId && sessionSnapshot?.taskId === taskId;

      if (shouldSyncSessionFallback) {
        useSessionStore.getState().syncTaskWorkflowStatus(
          taskId,
          previousWorkflowStatus,
          workflowStatus,
          sessionId,
        );
      }

      void useTaskStore.getState().updateTask(taskId, { workflowStatus }).then((ok) => {
        if (ok || !shouldSyncSessionFallback) return;
        useSessionStore.getState().syncTaskWorkflowStatus(
          taskId,
          workflowStatus,
          previousWorkflowStatus,
        );
      });
    },
    [
      liveTaskId,
      sessionId,
      sessionSnapshot?.taskId,
      sessionSnapshot?.workflowStatus,
      taskSnapshot?.workflowStatus,
    ],
  );

  const handleCommit = useCallback(() => {
    if (!sessionId) return;
    sendActionPrompt("commit", {}, actionInput);
    closeAction();
  }, [actionInput, closeAction, sendActionPrompt, sessionId]);

  const handlePush = useCallback(() => {
    if (!sessionId) return;
    sendActionPrompt("push", { branch: data?.branch ?? "" });
  }, [data?.branch, sendActionPrompt, sessionId]);

  const handlePull = useCallback(() => {
    if (!sessionId) return;
    sendActionPrompt("pull", { branch: data?.branch ?? "" });
  }, [data?.branch, sendActionPrompt, sessionId]);

  const handleMerge = useCallback(() => {
    if (!sessionId || !mergeSource) return;
    sendActionPrompt("merge", {
      source: mergeSource,
      current: data?.branch ?? "",
    });
    closeAction();
  }, [closeAction, data?.branch, mergeSource, sendActionPrompt, sessionId]);

  const handleCreatePr = useCallback(() => {
    if (!sessionId) return;
    if (panelData?.github && getGitHubActionBlockReason(panelData.github)) {
      closeAction();
      return;
    }

    const base = prBaseBranch || data?.defaultBranch || "main";
    const branch = data?.branch ?? "";

    sendActionPrompt(
      "createPr",
      { branch, base },
      actionInput,
    );
    updateCurrentTaskWorkflowStatus("in_review");
    closeAction();
  }, [
    actionInput,
    closeAction,
    data?.branch,
    data?.defaultBranch,
    panelData?.github,
    prBaseBranch,
    sendActionPrompt,
    sessionId,
    updateCurrentTaskWorkflowStatus,
  ]);

  const handleMergePr = useCallback(() => {
    if (!sessionId) return;
    if (panelData?.github && getGitHubActionBlockReason(panelData.github)) {
      closeAction();
      return;
    }
    const prNumber = panelData?.prStatus?.number;
    if (prNumber == null) return;
    const prompt = mergePrPromptDraft.trim();
    if (!prompt) return;

    wsClient.sendMessage(sessionId, prompt);
    updateCurrentTaskWorkflowStatus("done");
    closeAction();
  }, [
    closeAction,
    mergePrPromptDraft,
    panelData?.github,
    panelData?.prStatus?.number,
    sessionId,
    updateCurrentTaskWorkflowStatus,
  ]);

  const resetMergePrPromptDraft = useCallback(() => {
    setMergePrPromptDraft(mergePrPromptPreview);
  }, [mergePrPromptPreview]);

  const openAction = useCallback(
    (action: Exclude<ActiveGitAction, null>) => {
      setActiveAction(action);
      setActionInput("");

      if (action === "merge") {
        setMergeSource(data?.defaultBranch ?? "main");
      } else if (action === "create-pr") {
        setPrBaseBranch(data?.defaultBranch ?? "main");
      } else if (action === "merge-pr") {
        setMergePrPromptDraft(mergePrPromptPreview);
      }
    },
    [data?.defaultBranch, mergePrPromptPreview],
  );

  return {
    actionInput,
    activeAction,
    changedFileCount,
    checksUrl,
    closeAction,
    copyBranch,
    data: panelData,
    diffData,
    diffError,
    diffLoading,
    error,
    handleCommit,
    handleCreatePr,
    handleMerge,
    handleMergePr,
    handlePull,
    handlePush,
    isSessionBusy,
    loading,
    mergePrPromptDraft,
    mergePrPromptPreview,
    mergeSource,
    moveSelection,
    openAction,
    openExternal,
    prBaseBranch,
    selectedFile,
    selectedFileIndex,
    selectedPath,
    setActionInput,
    setMergePrPromptDraft,
    setMergeSource,
    setPrBaseBranch,
    setSelectedPath,
    resetMergePrPromptDraft,
  };
}
