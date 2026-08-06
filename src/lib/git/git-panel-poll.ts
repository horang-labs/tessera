/**
 * The Git panel's background refresh: the same read the panel does on mount
 * (`git-panel-read.ts`), repeated for as long as the panel is on screen.
 *
 * It is a module rather than a `useEffect` body because what it does wrong is
 * invisible from the component — the panel that only polled its change set
 * looked entirely alive, refreshing files and diff totals on the cycle while
 * the branch and the ahead/behind counts underneath it stayed at whatever they
 * were when it mounted (#239). Here the cycle can be run against a clock the
 * test holds, and what a single tick carries can be asserted.
 */

import { readGitPanelState } from "./git-panel-read";
import type { GitPanelData } from "@/types/git";

export const GIT_PANEL_POLL_INTERVAL_MS = 5000;
/**
 * Upper bound and slow-scan multiplier for adaptive polling: after a slow scan
 * (e.g. a huge repo) we wait roughly `elapsed * BACKOFF` before the next tick so
 * we never re-poll on top of an unfinished scan, capped at MAX.
 */
export const GIT_PANEL_POLL_MAX_INTERVAL_MS = 60_000;
export const GIT_PANEL_POLL_SLOW_BACKOFF = 3;

export type GitPanelPollTimerHandle = unknown;

/** The clock, injectable so a poll cycle is a step rather than a wait. */
export interface GitPanelPollTimers {
  setTimer: (run: () => void, delayMs: number) => GitPanelPollTimerHandle;
  clearTimer: (handle: GitPanelPollTimerHandle) => void;
  now: () => number;
}

export interface GitPanelPollOptions {
  sessionId: string;
  /** Where a fresh panel state goes — the store, in the panel's case. */
  apply: (data: GitPanelData) => void;
  /**
   * False while the panel's document is hidden. A hidden tab is not read, but
   * the loop keeps ticking so it resumes without waiting to be restarted.
   */
  isVisible: () => boolean;
  fetchImpl?: typeof fetch;
  timers?: GitPanelPollTimers;
}

const defaultTimers: GitPanelPollTimers = {
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
};

/**
 * Starts the loop and answers with the way to stop it. A tick that is still in
 * flight when the caller stops applies nothing: the panel it would have written
 * to has moved to another session by then.
 */
export function startGitPanelPolling(options: GitPanelPollOptions): () => void {
  const { sessionId, apply, isVisible, fetchImpl } = options;
  const timers = options.timers ?? defaultTimers;

  let stopped = false;
  let handle: GitPanelPollTimerHandle | null = null;
  let inFlight = false;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    handle = timers.setTimer(runTick, delayMs);
  };

  const runTick = (): void => {
    if (stopped) return;
    // A read already running is the reason to skip, not to shorten the wait: a
    // scan slow enough to overlap is exactly the one not to start twice.
    if (!isVisible() || inFlight) {
      schedule(GIT_PANEL_POLL_INTERVAL_MS);
      return;
    }

    inFlight = true;
    const startedAt = timers.now();
    void (async () => {
      try {
        const result = await readGitPanelState(sessionId, { fetchImpl });
        // A failed poll leaves the panel showing what it already had. The error
        // belongs to the read the user asked for, not to a background one.
        if (!stopped && result.kind === "loaded") apply(result.data);
      } finally {
        inFlight = false;
        schedule(nextGitPanelPollDelay(timers.now() - startedAt));
      }
    })();
  };

  schedule(GIT_PANEL_POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (handle !== null) timers.clearTimer(handle);
    handle = null;
  };
}

/** How long to wait after a read that took `elapsedMs`. */
export function nextGitPanelPollDelay(elapsedMs: number): number {
  return Math.min(
    GIT_PANEL_POLL_MAX_INTERVAL_MS,
    Math.max(
      GIT_PANEL_POLL_INTERVAL_MS,
      Math.round(elapsedMs * GIT_PANEL_POLL_SLOW_BACKOFF),
    ),
  );
}
