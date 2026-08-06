/**
 * What the Git panel says once an action finishes
 * (`docs/design/git-delivery.md` §7).
 *
 * Kept apart from the controller because the decisions here are the reportable
 * ones: which of the parallel sessions moved, whether the user's code was
 * refused or the tool broke, and whether the commit draft survives so pressing
 * the same button again re-runs the action (ADR 0005 — there is no retry
 * control). The controller only renders what this returns.
 */
import type { GitActionResult } from "@/types/git";
import { summarizeGitFailure } from "./git-panel-shared";

export type GitActionToastKey =
  | "gitPanel.commit.successToast"
  | "gitPanel.commit.failureToast"
  | "gitPanel.commit.hookRejectedToast"
  | "gitPanel.commit.hookRejectedNoDetailToast";

export interface GitActionToast {
  tone: "success" | "error";
  messageKey: GitActionToastKey;
  /** `reason` is absent when there is nothing worth quoting. */
  params: { origin: string; reason?: string };
  /**
   * Only a completed action clears the message and the file selection. A
   * failure leaves both in place, which is what makes the same button a retry.
   */
  clearsDraft: boolean;
}

/** Named for a session with neither a branch nor a worktree to point at. */
const UNATTRIBUTED_ORIGIN = "worktree";

/**
 * Tessera runs many sessions at once, so a bare "Committed" says nothing about
 * which worktree moved. The branch is the name the user is working under; the
 * worktree covers a detached HEAD, where there is no branch to report.
 */
export function describeGitActionOrigin(
  panel: { branch?: string | null; worktreeName?: string | null } | null | undefined,
): string {
  return panel?.branch || panel?.worktreeName || UNATTRIBUTED_ORIGIN;
}

export function describeGitActionToast(
  result: GitActionResult,
  origin: string,
): GitActionToast {
  if (result.ok) {
    return {
      tone: "success",
      messageKey: "gitPanel.commit.successToast",
      params: { origin },
      clearsDraft: true,
    };
  }

  const { kind, message, stderr } = result.failure;
  if (kind === "hook_rejected") {
    // A hook can refuse without printing anything, and then the only message
    // there is comes from the runner ("git exited with code 1"). Quoting that
    // would replace "your code was refused" with Git plumbing.
    return stderr.trim()
      ? {
        tone: "error",
        messageKey: "gitPanel.commit.hookRejectedToast",
        params: { origin, reason: summarizeGitFailure(message) },
        clearsDraft: false,
      }
      : {
        tone: "error",
        messageKey: "gitPanel.commit.hookRejectedNoDetailToast",
        params: { origin },
        clearsDraft: false,
      };
  }

  return {
    tone: "error",
    messageKey: "gitPanel.commit.failureToast",
    params: { origin, reason: summarizeGitFailure(message) },
    clearsDraft: false,
  };
}

/**
 * A failure that never reached the execution layer — the request was refused,
 * the session went away, the fetch itself broke. There is no classified kind to
 * report, but the toast still says which session it came from.
 */
export function describeGitRequestFailureToast(
  message: string,
  origin: string,
): GitActionToast {
  return {
    tone: "error",
    messageKey: "gitPanel.commit.failureToast",
    params: { origin, reason: summarizeGitFailure(message) },
    clearsDraft: false,
  };
}
