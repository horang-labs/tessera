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
  GitActionFailure,
  GitActionResult,
  GitConflictOperation,
  GitCreatePullRequestOutcome,
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
  | "gitPanel.pull.hookRejectedNoDetailToast"
  | "gitPanel.pr.createdToast"
  | "gitPanel.pr.createdNoDetailToast"
  | "gitPanel.pr.failureToast"
  | "gitPanel.conflict.mergeAbortedToast"
  | "gitPanel.conflict.rebaseAbortedToast"
  | "gitPanel.conflict.cherryPickAbortedToast"
  | "gitPanel.conflict.abortFailureToast";

/**
 * Which action was attempted. A failure carries no verb of its own — the same
 * `command_failed` arrives from a commit and from a push — so the caller, which
 * is the only party that knows what it pressed, says.
 */
export type GitActionVerb = "commit" | "push" | "pull" | "create_pr" | "abort";

export interface GitActionToast {
  tone: "success" | "error";
  messageKey: GitActionToastKey;
  /**
   * `reason` is absent when there is nothing worth quoting, `remoteBranch` when
   * the action was not a push or Git would not say which branch it wrote, and
   * `number` / `baseBranch` when the pull request could not be read back.
   */
  params: {
    origin: string;
    reason?: string;
    remoteBranch?: string;
    number?: number;
    baseBranch?: string;
  };
  /**
   * Only a completed commit clears the message and the file selection. A
   * failure leaves both in place, which is what makes the same button a retry,
   * and a push never owned the draft to begin with.
   */
  clearsDraft: boolean;
}

/**
 * What a failing action can be told to say, per verb. The hook keys are optional
 * because a hook is something Git runs: `gh` opening a pull request has none to
 * be refused by, and giving that verb hook wording would invent a rejection.
 */
const FAILURE_KEYS: Record<
  GitActionVerb,
  {
    failure: GitActionToastKey;
    hookRejected?: GitActionToastKey;
    hookRejectedNoDetail?: GitActionToastKey;
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
  create_pr: {
    failure: "gitPanel.pr.failureToast",
  },
  // An abort runs no hook, so there is no rejection for it to be given wording
  // for. What it can hit is a worktree Git will not unwind, which is a failure.
  abort: {
    failure: "gitPanel.conflict.abortFailureToast",
  },
};

/**
 * §9's escape, reported by the operation that was actually unwound rather than
 * by the one the menu was labelled for — the two can differ, because the action
 * re-reads the worktree before it picks a command.
 */
const ABORT_SUCCESS_KEY: Record<GitConflictOperation, GitActionToastKey> = {
  merge: "gitPanel.conflict.mergeAbortedToast",
  rebase: "gitPanel.conflict.rebaseAbortedToast",
  cherry_pick: "gitPanel.conflict.cherryPickAbortedToast",
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
    if (result.outcome.action === "create_pr") {
      return describeCreatePullRequestOutcome(result.outcome, origin);
    }
    if (result.outcome.action === "abort") {
      return {
        tone: "success",
        messageKey: ABORT_SUCCESS_KEY[result.outcome.operation],
        params: { origin },
        // The commit path was blocked while the operation ran, so there is no
        // draft this could have cleared — and the tree the abort restored is
        // the one the user may now want to commit.
        clearsDraft: false,
      };
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
  if (kind === "hook_rejected" && keys.hookRejected && keys.hookRejectedNoDetail) {
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
 * §7: the report says which pull request opened and where it went, because the
 * base is GitHub's answer rather than the panel's — the user has not been shown
 * it before this point. Without the read-back the report drops to what is still
 * certainly true: a pull request now exists for this branch.
 */
function describeCreatePullRequestOutcome(
  outcome: GitCreatePullRequestOutcome,
  origin: string,
): GitActionToast {
  if (outcome.number === null || !outcome.baseBranch) {
    return {
      tone: "success",
      messageKey: "gitPanel.pr.createdNoDetailToast",
      params: { origin },
      clearsDraft: false,
    };
  }

  return {
    tone: "success",
    messageKey: "gitPanel.pr.createdToast",
    params: { origin, number: outcome.number, baseBranch: outcome.baseBranch },
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

/**
 * The same failure, kept where it can be read (#248).
 *
 * A toast is one truncated line that leaves on a timer, and the reason a Git
 * action failed is regularly neither — an upstream Git will not resolve, a hook
 * that printed pages. So the panel keeps the failure until the user is done with
 * it, and carries the raw output the summary was cut from.
 */
export interface GitActionFailureReport {
  /** Which action failed. A failure carries no verb, so the caller says. */
  verb: GitActionVerb;
  /**
   * The house one-liner — the same text the toast shows — or null when the kind
   * is one this build has no wording for, in which case `message` is what the
   * banner shows instead.
   */
  summary: GitActionToast | null;
  /** What the server said, verbatim and untruncated. */
  message: string;
  /** What Git wrote. Both empty when the request never reached it. */
  stderr: string;
  stdout: string;
  /** Null when the process never ran, or was killed before it could exit. */
  exitCode: number | null;
}

export type GitActionFailureTitleKey =
  | "gitPanel.failure.commitTitle"
  | "gitPanel.failure.pushTitle"
  | "gitPanel.failure.pullTitle"
  | "gitPanel.failure.createPrTitle"
  | "gitPanel.failure.abortTitle";

/**
 * Which action failed, for the banner's heading. The summary under it leads
 * with the same verb, but it is the thing that can be replaced by a verbatim
 * server message — so the heading is what always names what was pressed.
 */
export const GIT_FAILURE_TITLE_KEY: Record<GitActionVerb, GitActionFailureTitleKey> = {
  commit: "gitPanel.failure.commitTitle",
  push: "gitPanel.failure.pushTitle",
  pull: "gitPanel.failure.pullTitle",
  create_pr: "gitPanel.failure.createPrTitle",
  abort: "gitPanel.failure.abortTitle",
};

/**
 * The kinds this build knows how to word, listed rather than derived from
 * `GitFailureKind`: the point is to notice a kind the server started sending
 * that the renderer was never taught, and a compile-time union cannot notice
 * that at runtime. An unrecognised kind is reported by quoting the server
 * verbatim — wording it as a plain `command_failed` would put the panel's own
 * sentence in front of the one fact it does not have.
 */
const REPORTABLE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "authentication",
  "not_found",
  "hook_rejected",
  "timeout",
  "spawn_failed",
  "command_failed",
]);

export function describeGitActionFailure(
  failure: GitActionFailure,
  origin: string,
  attempted: GitActionVerb = "commit",
): GitActionFailureReport {
  return {
    verb: attempted,
    summary: REPORTABLE_FAILURE_KINDS.has(failure.kind)
      ? describeGitActionToast({ ok: false, failure }, origin, attempted)
      : null,
    message: failure.message,
    stderr: failure.stderr,
    stdout: failure.stdout,
    exitCode: failure.exitCode,
  };
}

/**
 * A failure that never reached Git, banner-side. There is no command output to
 * expand — the request itself is the whole account — but the panel still holds
 * it, because a dropped request is exactly the case a vanishing toast loses.
 */
export function describeGitRequestFailure(
  message: string,
  origin: string,
  attempted: GitActionVerb = "commit",
): GitActionFailureReport {
  return {
    verb: attempted,
    summary: describeGitRequestFailureToast(message, origin, attempted),
    message,
    stderr: "",
    stdout: "",
    exitCode: null,
  };
}
