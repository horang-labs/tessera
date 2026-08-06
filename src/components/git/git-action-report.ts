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
import type {
  GitActionResult,
  GitPullOutcome,
  GitPushOutcome,
} from "@/types/git";
import {
  summarizeGitFailure,
  summarizeHookRejection,
  summarizeMergeFailure,
} from "./git-panel-shared";

export type GitActionToastKey =
  | "gitPanel.commit.successToast"
  | "gitPanel.commit.failureToast"
  | "gitPanel.commit.hookRejectedToast"
  | "gitPanel.commit.hookRejectedNoDetailToast"
  | "gitPanel.push.successToast"
  | "gitPanel.push.successNoUpstreamToast"
  | "gitPanel.push.publishedToast"
  | "gitPanel.push.failureToast"
  | "gitPanel.push.hookRejectedToast"
  | "gitPanel.push.hookRejectedNoDetailToast"
  | "gitPanel.pull.successToast"
  | "gitPanel.pull.failureToast"
  | "gitPanel.pull.hookRejectedToast"
  | "gitPanel.pull.hookRejectedNoDetailToast";

/**
 * Which action was attempted. A failure carries no verb of its own — the same
 * `command_failed` arrives from a commit and from a push — so the caller, which
 * is the only party that knows what it pressed, says.
 */
export type GitActionVerb = "commit" | "push" | "pull";

export interface GitActionToast {
  tone: "success" | "error";
  messageKey: GitActionToastKey;
  /**
   * `reason` is absent when there is nothing worth quoting, `remoteBranch` when
   * the action was not a push or Git would not say which branch it wrote.
   */
  params: { origin: string; reason?: string; remoteBranch?: string };
  /**
   * Only a completed commit clears the message and the file selection. A
   * failure leaves both in place, which is what makes the same button a retry,
   * and a push never owned the draft to begin with.
   */
  clearsDraft: boolean;
}

/** The four things a failing action can be told to say, per verb. */
const FAILURE_KEYS: Record<
  GitActionVerb,
  {
    failure: GitActionToastKey;
    hookRejected: GitActionToastKey;
    hookRejectedNoDetail: GitActionToastKey;
  }
> = {
  commit: {
    failure: "gitPanel.commit.failureToast",
    hookRejected: "gitPanel.commit.hookRejectedToast",
    hookRejectedNoDetail: "gitPanel.commit.hookRejectedNoDetailToast",
  },
  push: {
    failure: "gitPanel.push.failureToast",
    hookRejected: "gitPanel.push.hookRejectedToast",
    hookRejectedNoDetail: "gitPanel.push.hookRejectedNoDetailToast",
  },
  // A pull runs the merge hooks, so it can be refused by one the same way.
  pull: {
    failure: "gitPanel.pull.failureToast",
    hookRejected: "gitPanel.pull.hookRejectedToast",
    hookRejectedNoDetail: "gitPanel.pull.hookRejectedNoDetailToast",
  },
};

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
  attempted: GitActionVerb = "commit",
): GitActionToast {
  if (result.ok) {
    if (result.outcome.action === "push") {
      return describePushOutcome(result.outcome, origin);
    }
    if (result.outcome.action === "pull") {
      return describePullOutcome(result.outcome, origin);
    }
    return {
      tone: "success",
      messageKey: "gitPanel.commit.successToast",
      params: { origin },
      clearsDraft: true,
    };
  }

  const keys = FAILURE_KEYS[attempted];
  const { kind, message, stderr, stdout } = result.failure;
  if (kind === "hook_rejected") {
    // A hook can refuse without printing anything, and then the only message
    // there is comes from the runner ("git exited with code 1"). Quoting that
    // would replace "your code was refused" with Git plumbing.
    return stderr.trim()
      ? {
        tone: "error",
        messageKey: keys.hookRejected,
        params: { origin, reason: summarizeHookRejection(message) },
        clearsDraft: false,
      }
      : {
        tone: "error",
        messageKey: keys.hookRejectedNoDetail,
        params: { origin },
        clearsDraft: false,
      };
  }

  return {
    tone: "error",
    messageKey: keys.failure,
    params: {
      origin,
      // A pull is the one verb that can fail mid-merge, and a merge says what
      // it did before it says that it could not finish — on the other stream.
      reason: attempted === "pull"
        ? summarizeMergeFailure(stdout, message)
        : summarizeGitFailure(message),
    },
    clearsDraft: false,
  };
}

/**
 * §7: a push says whether it set an upstream and which remote branch it wrote,
 * so a first push is explained after the fact as well as before it. Without the
 * upstream — a read-back that stumbled after the push already landed — the
 * report drops to what is still certainly true.
 */
function describePushOutcome(
  outcome: GitPushOutcome,
  origin: string,
): GitActionToast {
  if (!outcome.remoteBranch) {
    return {
      tone: "success",
      messageKey: "gitPanel.push.successNoUpstreamToast",
      params: { origin },
      clearsDraft: false,
    };
  }

  return {
    tone: "success",
    messageKey: outcome.setUpstream
      ? "gitPanel.push.publishedToast"
      : "gitPanel.push.successToast",
    params: { origin, remoteBranch: outcome.remoteBranch },
    clearsDraft: false,
  };
}

/**
 * A pull names the tracking branch it caught up with, for the same reason a push
 * names the one it wrote: several sessions move at once, and "Pulled" alone does
 * not say which worktree took what from where (§7).
 */
function describePullOutcome(
  outcome: GitPullOutcome,
  origin: string,
): GitActionToast {
  return {
    tone: "success",
    messageKey: "gitPanel.pull.successToast",
    params: { origin, remoteBranch: outcome.upstream },
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
  attempted: GitActionVerb = "commit",
): GitActionToast {
  return {
    tone: "error",
    messageKey: FAILURE_KEYS[attempted].failure,
    params: { origin, reason: summarizeGitFailure(message) },
    clearsDraft: false,
  };
}
