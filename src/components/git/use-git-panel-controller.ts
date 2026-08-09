"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitWorktreeKey,
  provisionalGitWorktreeKey,
  useGitPanelStore,
  type GitPendingVerb,
} from "@/stores/git-panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionPrStore } from "@/stores/session-pr-store";
import { useTaskStore } from "@/stores/task-store";
import { useGitStore } from "@/stores/git-store";
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
  describeDefaultBranchPushConfirmation,
  type GitDefaultBranchConfirmation,
} from "@/lib/git/default-branch-confirmation";
import {
  deriveGitActionMenu,
  type GitMenuActionId,
} from "@/lib/git/git-action-menu";
import { startGitPanelPolling } from "@/lib/git/git-panel-poll";
import { readGitPanelState } from "@/lib/git/git-panel-read";
import {
  describeGitActionFailure,
  describeGitActionOrigin,
  describeGitActionToast,
  describeGitRequestFailure,
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

/** Every verb whose whole request is the verb — no parameters, no draft. */
type GitBranchActionVerb = "push" | "pull" | "create_pr" | "abort";

/**
 * What is running in a working directory. The menu's compound is one entry
 * rather than the two requests it makes, because what the panel has to disable
 * is the whole press, not each half as it goes by.
 */
export type { GitPendingVerb } from "@/stores/git-panel-store";

/**
 * What a branch action says when the request never came back with anything of
 * its own — a network that dropped, a route that answered nothing readable.
 */
const BRANCH_ACTION_FALLBACK: Record<GitBranchActionVerb, string> = {
  push: "Failed to push.",
  pull: "Failed to pull.",
  create_pr: "Failed to create the pull request.",
  abort: "Failed to abort.",
};

/**
 * What each of them acts on, for telemetry. A pull request is not the branch —
 * it is a thing opened about the branch — and the registered target says so.
 */
const BRANCH_ACTION_TELEMETRY_TARGET: Record<GitBranchActionVerb, string> = {
  push: "branch",
  pull: "branch",
  create_pr: "pull_request",
  // Not the branch: what an abort unwinds is the operation the worktree is in,
  // and the branch is only where it lands afterwards.
  abort: "conflict",
};

const PANEL_CACHE_LIMIT = 20;
const gitPanelSessionCache = new Map<string, GitPanelSessionCacheEntry>();
const EMPTY_DESELECTED_PATHS: ReadonlySet<string> = new Set<string>();

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
  // The unknown-state frame already permits typing before `data` exists. Keep
  // that input under a provisional key, then follow the snapshot's canonical
  // owner once Git resolves it; the store migrates the provisional draft.
  const worktreeKey = data
    ? gitWorktreeKey(data)
    : sessionId
      ? provisionalGitWorktreeKey(sessionId)
      : null;
  const delivery = useGitPanelStore((state) =>
    worktreeKey ? state.deliveryByWorktree[worktreeKey] : undefined,
  );
  const setWorktreeCommitMessage = useGitPanelStore(
    (state) => state.setCommitMessage,
  );
  const toggleWorktreeCommitFile = useGitPanelStore(
    (state) => state.toggleCommitFile,
  );
  const clearWorktreeDraft = useGitPanelStore((state) => state.clearDraft);
  const markWorktreePending = useGitPanelStore((state) => state.markPending);
  const setWorktreeActionFailure = useGitPanelStore(
    (state) => state.setActionFailure,
  );
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
  const commitMessage = delivery?.commitMessage ?? "";
  // Checkboxes start selected, so it is the *de*selection that has to persist.
  // The changed-file list is re-polled every few seconds; holding the selection
  // instead would make every poll fight over files that had just appeared.
  const deselectedPaths = delivery?.deselectedPaths ?? EMPTY_DESELECTED_PATHS;
  /**
   * The Git action in flight against this canonical worktree, if any.
   *
   * Not one slot for the whole panel: the panel is a single component pointed at
   * whichever session is active, while this state outlives a switch, so a shared
   * slot gets it wrong whichever way it is read — shared, a commit still running
   * when the user moves on spins a pending label on a session that ran nothing;
   * cleared on switch, moving away and back re-enables the button over the
   * action already running.
   *
   * Keyed by Git's worktree root rather than by session because that is what
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
  const pendingHere = delivery?.pendingVerb ?? null;

  /**
   * The question standing between a press and a push to the default branch, or
   * null when there is nothing to ask (§8). It is also the dialog's open state:
   * there is only ever one push to confirm, the one just pressed.
   *
   * `intent` rides along because the menu can raise this too, and the compound
   * it raises it for has to run both of its halves on the way back — the copy
   * alone would not say which.
   */
  const [pushConfirmation, setPushConfirmation] = useState<
    (GitDefaultBranchConfirmation & {
      intent: "push" | "publish" | "commit_push";
    }) | null
  >(null);
  const [generatingMessage, setGeneratingMessage] = useState(false);
  // A generation failure stays here rather than in a toast: it belongs to the
  // generate button, and committing is still available (`docs/design/git-delivery.md` §6).
  const [generateMessageError, setGenerateMessageError] = useState<string | null>(
    null,
  );
  /**
   * The last Git action that failed here, for the same reason a generation
   * failure stays above: it belongs to the button that was pressed, and the
   * toast it also raises is one truncated line that leaves on a timer (#248).
   *
   * Separate from `error`, which says the panel could not be read at all — a
   * push that Git refused leaves the panel perfectly readable.
   */
  const actionFailure = delivery?.actionFailure ?? null;
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
      // The same read the poll makes (#239). Anything the panel can show on
      // mount, it can therefore show without one.
      const result = await readGitPanelState(sessionId);

      // Race: optimistic session id resolved on the client before the DB row is
      // visible. Stay quiet — the next sessionId change (or a retry via
      // visibilitychange) will pick up the real state.
      if (result.kind === "session_missing") return;

      if (result.kind === "failed") {
        if (!silent) setError(result.message);
        return;
      }

      applyGitPanelData(sessionId, result.data);
      setError(null);
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
    // Generation progress and confirmations belong to this mounted surface.
    // The draft and retained action failure live in the worktree owner and are
    // selected above, so switching between sessions cannot erase either.
    setGenerateMessageError(null);
    // The question was asked about the branch the panel was showing a moment
    // ago; answering it here would push a different session's branch.
    setPushConfirmation(null);

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

  /**
   * The background refresh (#239). It reads the whole panel state rather than
   * the change set alone: the branch and the ahead/behind counts are what the
   * primary-action ladder is derived from (§3), and a poll that left them at
   * their mount values made the panel look alive while silently mis-deciding
   * the push confirmation (§8), the pull rung and the pull-request rung.
   */
  useEffect(() => {
    if (!sessionId || isTransientSessionId(sessionId)) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;

    return startGitPanelPolling({
      sessionId,
      apply: (data) => applyGitPanelData(sessionId, data),
      isVisible: () => document.visibilityState === "visible",
    });
  }, [applyGitPanelData, sessionId]);

  const panelData = useMemo<GitPanelData | null>(() => {
    if (!data) return null;

    const storeDiffStats =
      taskSnapshot?.diffStats !== undefined
        ? taskSnapshot.diffStats
        : sessionSnapshot?.diffStats;

    const livePr = taskSnapshot
      ? {
          prStatus: taskSnapshot.prStatus,
          prStatusKnown: taskSnapshot.prStatusKnown,
          prUnsupported: taskSnapshot.prUnsupported,
          remoteBranchExists: taskSnapshot.remoteBranchExists,
        }
      : (livePrStatus ?? liveSessionPr);

    return {
      ...data,
      diffStats: storeDiffStats !== undefined ? storeDiffStats : data.diffStats,
      // The presence of a live entry is authoritative even when its PR is
      // undefined: that is the WebSocket representation of confirmed none.
      prStatus: livePr ? livePr.prStatus : data.prStatus,
      prStatusKnown: livePr ? livePr.prStatusKnown : data.prStatusKnown,
      prUnsupported: livePr ? livePr.prUnsupported : data.prUnsupported,
      remoteBranchExists:
        livePr ? livePr.remoteBranchExists : data.remoteBranchExists,
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
    if (!worktreeKey) return;
    toggleWorktreeCommitFile(worktreeKey, path);
  }, [toggleWorktreeCommitFile, worktreeKey]);

  const changeCommitMessage = useCallback((value: string) => {
    if (!worktreeKey) return;
    setWorktreeCommitMessage(worktreeKey, value);
    // Typing over the field answers the failure; keeping it visible would leave
    // a complaint about text the user has already replaced.
    setGenerateMessageError(null);
  }, [setWorktreeCommitMessage, worktreeKey]);

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

      if (worktreeKey) setWorktreeCommitMessage(worktreeKey, message);
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
  }, [
    commitFiles,
    generatingMessage,
    pendingHere,
    sessionId,
    setWorktreeCommitMessage,
    t,
    worktreeKey,
  ]);

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
  const pullRequestUrl =
    panelData?.prStatus?.url ?? panelData?.github.pullRequest?.url ?? null;
  const viewPullRequest = useCallback(() => {
    if (!pullRequestUrl || typeof window === "undefined") return;
    void captureTelemetryEvent("git_action_triggered", {
      source: "git_panel",
      action: "open_external",
      target: "pull_request",
      has_worktree: Boolean(data?.worktreePath),
      has_changes: Boolean(panelData?.changedFiles.length),
      has_pr: true,
    });
    window.open(pullRequestUrl, "_blank", "noopener,noreferrer");
  }, [data?.worktreePath, panelData?.changedFiles.length, pullRequestUrl]);

  // A toast is raised the same way whichever layer refused, and the draft
  // survives every failure so the same button is itself the retry.
  const reportAction = useCallback((toastReport: GitActionToast): void => {
    const rendered = t(toastReport.messageKey, toastReport.params);
    if (toastReport.tone === "success") toast.success(rendered);
    else toast.error(rendered);

    if (!toastReport.clearsDraft) return;
    if (worktreeKey) clearWorktreeDraft(worktreeKey);
    // The draft is gone, so a stale generation failure would be complaining
    // about text that no longer exists (#232).
    setGenerateMessageError(null);
  }, [clearWorktreeDraft, t, worktreeKey]);

  /**
   * One commit request, reported. It owns no pending slot, because the compound
   * in the menu runs this and then a push under a single one — a slot released
   * between the two halves would re-enable the button over an action that is
   * still going.
   *
   * Answers whether the commit landed, which is what tells the compound whether
   * there is anything to push.
   */
  const requestCommit = useCallback(async (): Promise<boolean> => {
    const message = commitMessage.trim();
    // The button is disabled without these. This is the second guard the design
    // asks for, and it also catches a click that lands after the selection
    // emptied underneath it.
    if (!sessionId || !message || commitFiles.length === 0) return false;

    const files = commitFiles.map((file) => file.path);

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
      reportAction(describeGitActionToast(result, commitOrigin, "commit"));
      // The toast says the first line and then leaves; the banner keeps the
      // whole of what Git said until the user is done with it (#248).
      if (!result.ok) {
        if (worktreeKey) {
          setWorktreeActionFailure(
            worktreeKey,
            describeGitActionFailure(result.failure, commitOrigin, "commit"),
          );
        }
      }
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
      return result.ok;
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : "Failed to commit.";
      reportAction(
        describeGitRequestFailureToast(message, commitOrigin, "commit"),
      );
      if (worktreeKey) {
        setWorktreeActionFailure(
          worktreeKey,
          describeGitRequestFailure(message, commitOrigin, "commit"),
        );
      }
      return false;
    }
  }, [
    commitFiles,
    commitMessage,
    commitOrigin,
    reportAction,
    sessionId,
    setWorktreeActionFailure,
    worktreeKey,
  ]);

  const commitSelectedFiles = useCallback(async () => {
    if (!worktreeKey || pendingHere) return false;
    // Captured, so the entry cleared below is the one this action opened even if
    // the panel has moved to another session by then.
    const ownerKey = worktreeKey;

    markWorktreePending(ownerKey, "commit");
    try {
      return await requestCommit();
    } finally {
      markWorktreePending(ownerKey, null);
    }
  }, [markWorktreePending, pendingHere, requestCommit, worktreeKey]);

  /**
   * The actions whose whole request is the verb: Push, Publish Branch — the same
   * request, differing only in what the button said before it — Pull, and Create
   * PR. None of them takes a parameter, because which branch moves to or from
   * where — and for a pull request, which repository and which base — is read
   * where the action runs, and what actually happened is read back off the
   * result rather than assumed from the label (§7).
   */
  const requestBranchAction = useCallback(
    async (verb: GitBranchActionVerb): Promise<void> => {
      if (!sessionId) return;

      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/git/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: verb }),
          },
        );
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            extractGitPanelErrorMessage(payload, BRANCH_ACTION_FALLBACK[verb]),
          );
        }

        const result = payload as GitActionResult;
        reportAction(describeGitActionToast(result, commitOrigin, verb));
        if (!result.ok) {
          if (worktreeKey) {
            setWorktreeActionFailure(
              worktreeKey,
              describeGitActionFailure(result.failure, commitOrigin, verb),
            );
          }
        }
        void captureTelemetryEvent("git_action_triggered", {
          source: "git_panel",
          action: verb,
          target: BRANCH_ACTION_TELEMETRY_TARGET[verb],
          result: result.ok ? "success" : "failed",
          ...(result.ok ? {} : { failure_kind: result.failure.kind }),
        });
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : BRANCH_ACTION_FALLBACK[verb];
        reportAction(describeGitRequestFailureToast(message, commitOrigin, verb));
        if (worktreeKey) {
          setWorktreeActionFailure(
            worktreeKey,
            describeGitRequestFailure(message, commitOrigin, verb),
          );
        }
      }
    },
    [
      commitOrigin,
      reportAction,
      sessionId,
      setWorktreeActionFailure,
      worktreeKey,
    ],
  );

  const runBranchAction = useCallback(async (
    verb: GitBranchActionVerb,
    pendingVerb: GitPendingVerb = verb,
  ) => {
    if (!worktreeKey || pendingHere) return;

    const ownerKey = worktreeKey;
    markWorktreePending(ownerKey, pendingVerb);
    try {
      await requestBranchAction(verb);
    } finally {
      markWorktreePending(ownerKey, null);
    }
  }, [markWorktreePending, pendingHere, requestBranchAction, worktreeKey]);

  /**
   * The menu's one compound (§2): the commit selection goes in, and the branch
   * is pushed, on one press.
   *
   * Sequenced here rather than in the execution layer, and deliberately: ADR
   * 0007 declines the phase contract a server-side compound would need to say
   * which half died. Two ordinary requests report two ordinary toasts, so a
   * commit that landed and a push that did not are both said out loud — and the
   * push is skipped outright when the commit was refused, since there would be
   * nothing new to send.
   */
  const runCommitAndPush = useCallback(async () => {
    if (!worktreeKey || pendingHere) return;

    const ownerKey = worktreeKey;
    markWorktreePending(ownerKey, "commit_push");
    try {
      if (await requestCommit()) await requestBranchAction("push");
    } finally {
      markWorktreePending(ownerKey, null);
    }
  }, [
    markWorktreePending,
    pendingHere,
    requestBranchAction,
    requestCommit,
    worktreeKey,
  ]);

  /** The one button. Which verb it runs is the ladder's answer, not the user's. */
  const runPrimaryAction = useCallback(() => {
    if (!primaryAction.enabled) return;
    if (primaryAction.action === "commit") return commitSelectedFiles();
    if (primaryAction.action === "view_pr") return viewPullRequest();
    if (!primaryAction.action) return;
    // §8: a push at the default branch is asked about before anything runs,
    // and the panel is left exactly as it was until the answer comes back.
    // Returns null for anything that is not a push, so pull and create_pr pass
    // straight through.
    const confirmation = describeDefaultBranchPushConfirmation(
      primaryAction,
      stateSnapshot,
    );
    if (confirmation) {
      setPushConfirmation({
        ...confirmation,
        intent: primaryAction.kind === "publish" ? "publish" : "push",
      });
      return;
    }
    return runBranchAction(
      primaryAction.action,
      primaryAction.kind === "publish" ? "publish" : primaryAction.action,
    );
  }, [commitSelectedFiles, primaryAction, runBranchAction, stateSnapshot, viewPullRequest]);

  /**
   * The menu, derived independently of the ladder over the same snapshot (§4).
   * Every action is listed on every rung; what changes is which of them can run
   * and what the rest say about why they cannot.
   */
  const menuActions = useMemo(
    () => deriveGitActionMenu(stateSnapshot),
    [stateSnapshot],
  );

  /**
   * What the ladder cannot see, and neither can the menu: a message still to be
   * written, a selection the user emptied. It refuses the two entries that
   * commit, the same way the commit button's own guard refuses it (§5).
   */
  const commitDraftBlocked =
    commitMessage.trim().length === 0 || commitFiles.length === 0;

  const runMenuAction = useCallback((id: GitMenuActionId) => {
    const chosen = menuActions.find((action) => action.id === id);
    if (!chosen?.enabled) return;
    if ((id === "commit" || id === "commit_push") && commitDraftBlocked) return;

    // §9's escape is not a delivery step and only exists during recovery.
    if (id === "abort") return runBranchAction("abort");

    if (id === "commit") return commitSelectedFiles();
    if (id === "open_source_control") {
      return useGitStore.getState().openTab("git");
    }
    if (chosen.kind === "view_pr") return viewPullRequest();

    // §8 stands in front of the menu exactly as it stands in front of the
    // button. Null for everything that does not push.
    const confirmation = describeDefaultBranchPushConfirmation(
      chosen,
      stateSnapshot,
    );
    if (confirmation) {
      setPushConfirmation({
        ...confirmation,
        intent: id === "commit_push"
          ? "commit_push"
          : chosen.kind === "publish"
            ? "publish"
            : "push",
      });
      return;
    }

    if (id === "commit_push") return runCommitAndPush();
    return runBranchAction(id, chosen.kind === "publish" ? "publish" : id);
  }, [
    commitDraftBlocked,
    commitSelectedFiles,
    menuActions,
    runBranchAction,
    runCommitAndPush,
    stateSnapshot,
    viewPullRequest,
  ]);

  /** Answering yes runs the action the confirmation was raised for, and nothing else. */
  const confirmPrimaryAction = useCallback(() => {
    const intent = pushConfirmation?.intent ?? "push";
    setPushConfirmation(null);
    // The dialog closes rather than holding a spinner of its own: progress
    // belongs at the button (§7), which is where the pending label already is.
    // The intent is read off the confirmation rather than off the ladder or the
    // menu, both of which may have moved while the dialog was open.
    if (intent === "commit_push") return runCommitAndPush();
    return runBranchAction("push", intent);
  }, [pushConfirmation, runBranchAction, runCommitAndPush]);

  const cancelPrimaryAction = useCallback(() => setPushConfirmation(null), []);

  const dismissActionFailure = useCallback(() => {
    if (worktreeKey) setWorktreeActionFailure(worktreeKey, null);
  }, [setWorktreeActionFailure, worktreeKey]);

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
    hasActiveSession: Boolean(sessionId),
    changedFileCount,
    commitMessage,
    commitTotals,
    /**
     * Whatever is running against this working directory, or null. Every
     * surface that has to say what is happening reads this one value rather
     * than a boolean of its own: the menu can start an action the button did
     * not, so "something is running" and "this is what is running" are
     * different questions and §7 needs the second one answered.
     */
    pendingVerb: pendingHere,
    /**
     * The last Git action that failed here, still on screen. Null once it is
     * dismissed or another action starts. A session switch onto the same
     * worktree deliberately keeps it visible.
     */
    actionFailure,
    dismissActionFailure,
    commitDraftBlocked,
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
    menuActions,
    runMenuAction,
    runPrimaryAction,
    pushConfirmation,
    confirmPrimaryAction,
    cancelPrimaryAction,
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
