"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGitPanelStore } from "@/stores/git-panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionPrStore } from "@/stores/session-pr-store";
import { useTaskStore } from "@/stores/task-store";
import { useI18n } from "@/lib/i18n";
import { captureTelemetryEvent } from "@/lib/telemetry/client";
import { toAbsoluteWorkspacePath } from "@/lib/workspace-tabs/file-path-actions";
import { toast } from "@/stores/notification-store";
import type {
  GitActionResult,
  GitChangedFile,
  GitChangedFilesData,
  GitDiffData,
  GitPanelData,
} from "@/types/git";
import {
  derivePrimaryGitAction,
  gitStateSnapshotFromPanel,
  type GitStateSnapshot,
} from "@/lib/git/primary-git-action";
import {
  describeGitActionOrigin,
  describeGitActionToast,
  describeGitRequestFailureToast,
  type GitActionToast,
  type GitActionVerb,
} from "./git-action-report";
import {
  extractGitPanelErrorMessage,
  summarizeGitFailure,
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
  const { t } = useI18n();
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
  const [commitMessage, setCommitMessage] = useState("");
  // Checkboxes start selected, so it is the *de*selection that has to persist.
  // The changed-file list is re-polled every few seconds; holding the selection
  // instead would make every poll fight over files that had just appeared.
  const [deselectedPaths, setDeselectedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /**
   * The Git action in flight against each working directory, if any.
   *
   * Not one slot for the whole panel: the panel is a single component pointed at
   * whichever session is active, while this state outlives a switch, so a shared
   * slot gets it wrong whichever way it is read — shared, a commit still running
   * when the user moves on spins a pending label on a session that ran nothing;
   * cleared on switch, moving away and back re-enables the button over the
   * action already running.
   *
   * Keyed by working directory rather than by session because that is what
   * actually contends. Several sessions can share one (`docs/design/git-delivery.md`
   * §5, and §11 refreshes all of them after an action), and `git commit` holds
   * `index.lock` for the whole of a pre-commit hook — so a second commit into
   * the same tree fails on the lock rather than doing anything useful. Sessions
   * on genuinely separate worktrees stay parallel, which is what they are.
   *
   * This is a courtesy, not a mutex: another browser tab or the user's own
   * terminal was always free to run Git underneath us, and ADR 0007 declines
   * orchestration. It stops the panel from being the thing that causes it.
   */
  const [pendingActions, setPendingActions] = useState<
    Readonly<Record<string, GitActionVerb>>
  >(() => ({}));
  /**
   * Null while Git state is unknown — no action can be started from that frame.
   * Read off the store rather than `panelData`, which is assembled further down;
   * the merge there leaves the working directory alone.
   */
  const pendingWorkDir = data?.workDir ?? null;
  const pendingHere = (pendingWorkDir ? pendingActions[pendingWorkDir] : null) ?? null;

  const markPending = useCallback(
    (workDir: string, verb: GitActionVerb | null): void => {
      setPendingActions((current) => {
        const next = { ...current };
        if (verb) next[workDir] = verb;
        else delete next[workDir];
        return next;
      });
    },
    [],
  );
  const [generatingMessage, setGeneratingMessage] = useState(false);
  // A generation failure stays here rather than in a toast: it belongs to the
  // generate button, and committing is still available (`docs/design/git-delivery.md` §6).
  const [generateMessageError, setGenerateMessageError] = useState<string | null>(
    null,
  );
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
    // A commit draft belongs to the session it was typed in, and so does the
    // selection under it — neither survives a switch.
    setCommitMessage("");
    setDeselectedPaths(new Set<string>());
    setGenerateMessageError(null);

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

  // A path that left the change set must not stay deselected: if the same file
  // changes again it is a new choice, and it should arrive checked like the
  // rest.
  useEffect(() => {
    const files = panelData?.changedFiles;
    if (!files) return;

    setDeselectedPaths((current) => {
      if (current.size === 0) return current;
      const live = new Set(files.map((file) => file.path));
      const next = new Set([...current].filter((path) => live.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [panelData]);

  const commitFiles = useMemo<GitChangedFile[]>(
    () =>
      (panelData?.changedFiles ?? []).filter(
        (file) => !deselectedPaths.has(file.path),
      ),
    [deselectedPaths, panelData],
  );

  // Counts the commit itself would produce, not the worktree's — the summary
  // above still reports the whole tree.
  const commitTotals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const file of commitFiles) {
      added += file.diffStats?.added ?? 0;
      removed += file.diffStats?.removed ?? 0;
    }
    return { files: commitFiles.length, added, removed };
  }, [commitFiles]);

  const isSelectedForCommit = useCallback(
    (path: string) => !deselectedPaths.has(path),
    [deselectedPaths],
  );

  const toggleCommitFile = useCallback((path: string) => {
    setDeselectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const changeCommitMessage = useCallback((value: string) => {
    setCommitMessage(value);
    // Typing over the field answers the failure; keeping it visible would leave
    // a complaint about text the user has already replaced.
    setGenerateMessageError(null);
  }, []);

  const generateCommitMessage = useCallback(async () => {
    // The button is disabled without a selection, and a poll can empty one out
    // from under a click that is already on its way.
    if (!sessionId || commitFiles.length === 0 || generatingMessage || pendingHere) {
      return;
    }

    const files = commitFiles.map((file) => file.path);
    setGeneratingMessage(true);
    setGenerateMessageError(null);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/commit-message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files }),
        },
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          extractGitPanelErrorMessage(
            payload,
            t("gitPanel.commit.generateFailed"),
          ),
        );
      }

      const message = (payload as { message?: unknown }).message;
      if (typeof message !== "string" || !message.trim()) {
        throw new Error(t("gitPanel.commit.generateFailed"));
      }

      setCommitMessage(message);
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "generate_commit_message",
        target: "commit_message",
        result: "success",
        // `changed_file_count` rather than the commit path's `file_count`:
        // `sanitizeTelemetryProperties` only forwards registered keys, and this
        // is the registered one for a count of changed files.
        changed_file_count: files.length,
      });
    } catch (nextError) {
      // Stays on the button. A failure here must not disturb the commit path.
      setGenerateMessageError(
        summarizeGitFailure(
          nextError instanceof Error
            ? nextError.message
            : t("gitPanel.commit.generateFailed"),
        ),
      );
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "generate_commit_message",
        target: "commit_message",
        result: "failed",
        changed_file_count: files.length,
      });
    } finally {
      setGeneratingMessage(false);
    }
  }, [commitFiles, generatingMessage, pendingHere, sessionId, t]);

  // Which of the parallel sessions a toast is about. Held here rather than
  // inside the action so the callback depends on the name, not on every panel
  // refresh that leaves the name unchanged.
  const commitOrigin = describeGitActionOrigin(panelData);

  /**
   * `null` while this session's Git state is not known — which is a rung of the
   * ladder, not an absence of one. Anything short of loaded state counts:
   * a panel still loading, a panel that failed to load, a session with no data
   * yet. Folding those into "clean tree" is what would make the button flash
   * through Publish Branch on every session switch (ADR 0007).
   */
  const stateSnapshot = useMemo<GitStateSnapshot | null>(
    () => (loading || error ? null : gitStateSnapshotFromPanel(panelData)),
    [error, loading, panelData],
  );

  const primaryAction = useMemo(
    () => derivePrimaryGitAction(stateSnapshot),
    [stateSnapshot],
  );

  // A toast is raised the same way whichever layer refused, and the draft
  // survives every failure so the same button is itself the retry.
  const reportAction = useCallback((toastReport: GitActionToast): void => {
    const rendered = t(toastReport.messageKey, toastReport.params);
    if (toastReport.tone === "success") toast.success(rendered);
    else toast.error(rendered);

    if (!toastReport.clearsDraft) return;
    setCommitMessage("");
    setDeselectedPaths(new Set<string>());
    // The draft is gone, so a stale generation failure would be complaining
    // about text that no longer exists (#232).
    setGenerateMessageError(null);
  }, [t]);

  const commitSelectedFiles = useCallback(async () => {
    const message = commitMessage.trim();
    // The button is disabled without these. This is the second guard the design
    // asks for, and it also catches a click that lands after the selection
    // emptied underneath it.
    if (
      !sessionId
      || !pendingWorkDir
      || !message
      || commitFiles.length === 0
      || pendingHere
    ) return;

    const files = commitFiles.map((file) => file.path);
    const report = reportAction;
    // Captured, so the entry cleared below is the one this action opened even if
    // the panel has moved to another session by then.
    const workDir = pendingWorkDir;

    markPending(workDir, "commit");
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "commit", message, files }),
        },
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          extractGitPanelErrorMessage(payload, "Failed to commit."),
        );
      }

      const result = payload as GitActionResult;
      report(describeGitActionToast(result, commitOrigin, "commit"));
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "commit",
        target: "commit",
        result: result.ok ? "success" : "failed",
        ...(result.ok ? {} : { failure_kind: result.failure.kind }),
        file_count: files.length,
      });
      // The route triggers the state refresh and broadcasts it; the client
      // never asks for one (docs/design/git-delivery.md §11).
    } catch (nextError) {
      report(
        describeGitRequestFailureToast(
          nextError instanceof Error ? nextError.message : "Failed to commit.",
          commitOrigin,
          "commit",
        ),
      );
    } finally {
      markPending(workDir, null);
    }
  }, [
    commitFiles,
    commitMessage,
    commitOrigin,
    markPending,
    pendingHere,
    pendingWorkDir,
    reportAction,
    sessionId,
  ]);

  /**
   * Push, and Publish Branch, which is the same request — what the button said
   * before is the only difference, and what actually happened is read back off
   * the result rather than assumed from the label (§7).
   */
  const pushBranch = useCallback(async () => {
    if (!sessionId || !pendingWorkDir || pendingHere) return;

    const workDir = pendingWorkDir;
    markPending(workDir, "push");
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "push" }),
        },
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, "Failed to push."));
      }

      const result = payload as GitActionResult;
      reportAction(describeGitActionToast(result, commitOrigin, "push"));
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "push",
        target: "branch",
        result: result.ok ? "success" : "failed",
        ...(result.ok ? {} : { failure_kind: result.failure.kind }),
      });
    } catch (nextError) {
      reportAction(
        describeGitRequestFailureToast(
          nextError instanceof Error ? nextError.message : "Failed to push.",
          commitOrigin,
          "push",
        ),
      );
    } finally {
      markPending(workDir, null);
    }
  }, [
    commitOrigin,
    markPending,
    pendingHere,
    pendingWorkDir,
    reportAction,
    sessionId,
  ]);

  /**
   * The last step of delivery, on the same button as the rest of it (§3). The
   * request carries nothing: which branch, which repository and which base are
   * all read where the action runs.
   */
  const createPullRequest = useCallback(async () => {
    if (!sessionId || !pendingWorkDir || pendingHere) return;

    const workDir = pendingWorkDir;
    markPending(workDir, "create_pr");
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create_pr" }),
        },
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          extractGitPanelErrorMessage(payload, "Failed to create the pull request."),
        );
      }

      const result = payload as GitActionResult;
      reportAction(describeGitActionToast(result, commitOrigin, "create_pr"));
      void captureTelemetryEvent("git_action_triggered", {
        source: "git_panel",
        action: "create_pr",
        target: "pull_request",
        result: result.ok ? "success" : "failed",
        ...(result.ok ? {} : { failure_kind: result.failure.kind }),
      });
    } catch (nextError) {
      reportAction(
        describeGitRequestFailureToast(
          nextError instanceof Error
            ? nextError.message
            : "Failed to create the pull request.",
          commitOrigin,
          "create_pr",
        ),
      );
    } finally {
      markPending(workDir, null);
    }
  }, [
    commitOrigin,
    markPending,
    pendingHere,
    pendingWorkDir,
    reportAction,
    sessionId,
  ]);

  /** The one button. Which verb it runs is the ladder's answer, not the user's. */
  const runPrimaryAction = useCallback(() => {
    if (!primaryAction.enabled) return;
    if (primaryAction.action === "push") return pushBranch();
    if (primaryAction.action === "create_pr") return createPullRequest();
    return commitSelectedFiles();
  }, [commitSelectedFiles, createPullRequest, primaryAction, pushBranch]);

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
    commitMessage,
    commitTotals,
    // The commit form disables its own inputs while its action runs; a push
    // leaves them alone, since it is not what they feed.
    committing: pendingHere === "commit",
    copyBranch,
    copyFilePath,
    copyWorktreePath,
    data: panelData,
    diffData,
    diffError,
    diffLoading,
    error,
    generateCommitMessage,
    generateMessageError,
    generatingMessage,
    isSelectedForCommit,
    loading,
    moveSelection,
    openExternal,
    primaryAction,
    actionPending: pendingHere !== null,
    runPrimaryAction,
    selectedFile,
    selectedFileIndex,
    selectedPath,
    setCommitMessage: changeCommitMessage,
    setSelectedPath,
    toggleCommitFile,
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
