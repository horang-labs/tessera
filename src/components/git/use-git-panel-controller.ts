"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGitPanelStore } from "@/stores/git-panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionPrStore } from "@/stores/session-pr-store";
import { useTaskStore } from "@/stores/task-store";
import { captureTelemetryEvent } from "@/lib/telemetry/client";
import { toAbsoluteWorkspacePath } from "@/lib/workspace-tabs/file-path-actions";
import type {
  GitChangedFilesData,
  GitDiffData,
  GitPanelData,
} from "@/types/git";
import { extractGitPanelErrorMessage } from "./git-panel-shared";

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
const GIT_PANEL_POLL_INTERVAL_MS = 5000;
// Upper bound and slow-scan multiplier for adaptive polling: after a slow scan
// (e.g. a huge repo) we wait roughly `elapsed * BACKOFF` before the next tick so
// we never re-poll on top of an unfinished scan, capped at MAX.
const GIT_PANEL_POLL_MAX_INTERVAL_MS = 60_000;
const GIT_PANEL_POLL_SLOW_BACKOFF = 3;
const gitPanelSessionCache = new Map<string, GitPanelSessionCacheEntry>();

async function writeClipboardText(value: string | null | undefined) {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }

  await navigator.clipboard.writeText(value);
}

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
  const lastDiffStatsTokenRef = useRef<string | null>(null);

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
  const liveSessionPr = useSessionPrStore((state) =>
    !liveTaskId && sessionId ? state.prBySessionId[sessionId] : undefined,
  );
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
          changedFilesTotal: changedFilesPayload.changedFilesTotal,
          changedFilesTruncated: changedFilesPayload.changedFilesTruncated,
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
      if (document.visibilityState !== "visible") return;
      // Ask the server to re-probe git state + PR status (covers work done
      // outside Tessera — CLI push, external gh pr create, etc.). Don't await:
      // the WS broadcast and the loadPanel re-read below converge the UI.
      if (!isTransientSessionId(sessionId)) {
        void fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/refresh-git`,
          { method: "POST" },
        ).catch(() => {
          // Best-effort — staleness recovers on the next focus or poll tick.
        });
      }
      void loadPanel({ silent: true });
    };

    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
    };
  }, [loadPanel, sessionId]);

  useEffect(() => {
    if (!sessionId || isTransientSessionId(sessionId)) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;

    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = window.setTimeout(runTick, delayMs);
    };

    const runTick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible" || inFlight) {
        schedule(GIT_PANEL_POLL_INTERVAL_MS);
        return;
      }
      inFlight = true;
      const startedAt = performance.now();
      try {
        await loadChangedFiles();
      } finally {
        inFlight = false;
        const elapsed = performance.now() - startedAt;
        const nextDelay = Math.min(
          GIT_PANEL_POLL_MAX_INTERVAL_MS,
          Math.max(
            GIT_PANEL_POLL_INTERVAL_MS,
            Math.round(elapsed * GIT_PANEL_POLL_SLOW_BACKOFF),
          ),
        );
        schedule(nextDelay);
      }
    };

    schedule(GIT_PANEL_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadChangedFiles, sessionId]);

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
      : (livePrStatus ?? liveSessionPr);

    return {
      ...data,
      diffStats: storeDiffStats !== undefined ? storeDiffStats : data.diffStats,
      prStatus: livePr?.prStatus ?? data.prStatus,
      prUnsupported: livePr?.prUnsupported ?? data.prUnsupported,
      remoteBranchExists:
        livePr?.remoteBranchExists ?? data.remoteBranchExists,
    };
  }, [data, liveSessionPr, livePrStatus, sessionSnapshot?.diffStats, taskSnapshot]);

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

  const copyBranch = useCallback(async () => {
    await writeClipboardText(data?.branch);
    void captureTelemetryEvent("git_action_triggered", {
      source: "git_panel",
      action: "copy_branch",
      target: "branch",
      has_worktree: Boolean(data?.worktreePath),
      has_changes: Boolean(panelData?.changedFiles.length),
      has_pr: Boolean(panelData?.prStatus || panelData?.github.pullRequest),
    });
  }, [
    data?.branch,
    data?.worktreePath,
    panelData?.changedFiles.length,
    panelData?.github.pullRequest,
    panelData?.prStatus,
  ]);

  const copyWorktreePath = useCallback(async () => {
    await writeClipboardText(data?.worktreePath);
    void captureTelemetryEvent("git_action_triggered", {
      source: "git_panel",
      action: "copy_worktree_path",
      target: "worktree_path",
      has_worktree: Boolean(data?.worktreePath),
      has_changes: Boolean(panelData?.changedFiles.length),
      has_pr: Boolean(panelData?.prStatus || panelData?.github.pullRequest),
    });
  }, [
    data?.worktreePath,
    panelData?.changedFiles.length,
    panelData?.github.pullRequest,
    panelData?.prStatus,
  ]);

  const copyFilePath = useCallback(
    async (relativePath: string) => {
      const absolutePath = toAbsoluteWorkspacePath(data?.worktreePath, relativePath);
      await writeClipboardText(absolutePath);
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "copy_file_path",
        target: "file_path",
        has_worktree: Boolean(data?.worktreePath),
        has_changes: Boolean(panelData?.changedFiles.length),
        has_pr: Boolean(panelData?.prStatus || panelData?.github.pullRequest),
      });
    },
    [
      data?.worktreePath,
      panelData?.changedFiles.length,
      panelData?.github.pullRequest,
      panelData?.prStatus,
    ],
  );

  const openExternal = useCallback((url: string | null | undefined) => {
    if (!url || typeof window === "undefined") return;
    void captureTelemetryEvent("git_action_triggered", {
      source: "git_panel",
      action: "open_external",
      target: resolveGitExternalTarget(url, {
        repoUrl: data?.repoUrl,
        pullRequestUrl: panelData?.prStatus?.url ?? panelData?.github.pullRequest?.url,
        checksUrl,
      }),
      has_worktree: Boolean(data?.worktreePath),
      has_changes: Boolean(panelData?.changedFiles.length),
      has_pr: Boolean(panelData?.prStatus || panelData?.github.pullRequest),
    });
    window.open(url, "_blank", "noopener,noreferrer");
  }, [
    checksUrl,
    data?.repoUrl,
    data?.worktreePath,
    panelData?.changedFiles.length,
    panelData?.github.pullRequest,
    panelData?.prStatus,
  ]);

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


  return {
    changedFileCount,
    copyBranch,
    copyFilePath,
    copyWorktreePath,
    data: panelData,
    diffData,
    diffError,
    diffLoading,
    error,
    loading,
    moveSelection,
    openExternal,
    selectedFile,
    selectedFileIndex,
    selectedPath,
    setSelectedPath,
  };
}

function resolveGitExternalTarget(
  url: string,
  urls: {
    repoUrl?: string | null;
    pullRequestUrl?: string | null;
    checksUrl?: string | null;
  },
): string {
  if (url === urls.repoUrl) return "repository";
  if (url === urls.pullRequestUrl) return "pull_request";
  if (url === urls.checksUrl) return "checks";
  return "unknown";
}
