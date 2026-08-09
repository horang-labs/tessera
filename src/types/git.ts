// src/types/git.ts

import type { GitFailureKind } from '@/lib/worktrees/git-runner';
import type { TaskPrStatus } from './task-pr-status';
import type {
  WorktreeDiffStats,
  WorktreeFileDiffStats,
} from './worktree-diff-stats';

export type GitFileState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "typechange"
  | "unknown";

export interface GitChangedFile {
  path: string;
  previousPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  state: GitFileState;
  staged: boolean;
  unstaged: boolean;
  displayStatus: string;
  diffStats?: WorktreeFileDiffStats | null;
}

/**
 * The Git operation a worktree stopped in the middle of
 * (`docs/design/git-delivery.md` §9). Null is the ordinary state, not a fourth
 * kind: there is nothing in progress and nothing to abort.
 */
export type GitConflictOperation = "merge" | "rebase" | "cherry_pick";

export interface GitCommitSummary {
  oidShort: string;
  subject: string;
  relativeDate: string;
}

export interface GitChecksSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface GitPullRequestSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  reviewDecision: string | null;
  headRefName: string;
  baseRefName: string;
  checks: GitChecksSummary;
}

export interface GitHubPanelState {
  available: boolean;
  reasonCode:
    | "gh_missing"
    | "gh_unauthenticated"
    | "not_github_remote"
    | "no_pull_request"
    | "unknown"
    | null;
  reason: string | null;
  pullRequest: GitPullRequestSummary | null;
}

export interface GitPanelData {
  sessionId: string;
  /** Present when the panel read targeted a canonical Worktree directly. */
  worktreeId?: string;
  taskId?: string;
  workDir: string;
  repoRoot: string;
  repoName: string;
  worktreeName: string;
  worktreePath: string;
  /** For display. A detached HEAD is spelled `detached@<sha>`; see `detached`. */
  branch: string;
  /** True when HEAD is detached, so `branch` names no branch Git would push. */
  detached: boolean;
  /**
   * The branch this one tracks. Resolved from `branch.<name>.remote` +
   * `branch.<name>.merge` when `@{upstream}` will not answer, which it refuses
   * to do for any branch this clone's fetch refspec does not map — published or
   * not (`src/lib/git/upstream-config.ts`).
   */
  upstream: string | null;
  /**
   * Commits on each side of the upstream, and `null` when there is no local way
   * to count them: no remote-tracking ref exists, so there is nothing here to
   * compare HEAD against. Distinct from `0`, which is a branch known to be in
   * sync — reporting the two the same way is what made every divergence look
   * like "nothing to do".
   */
  ahead: number | null;
  behind: number | null;
  /** `origin` only. A repository can have a remote without this being set. */
  remoteUrl: string | null;
  /** True when the repository has any remote at all, whatever it is named. */
  hasRemote: boolean;
  repoUrl: string | null;
  defaultBranch: string | null;
  /**
   * The fully-qualified ref this branch was cut from, recorded when the
   * worktree was created. Null for a branch created outside Tessera, or one
   * cut from a bare commit — Git itself remembers neither.
   */
  baseRef: string | null;
  branches: string[];
  changedFiles: GitChangedFile[];
  /** Total number of changed files before capping to `changedFiles`. */
  changedFilesTotal?: number;
  /** True when `changedFiles` was capped and omits some entries. */
  changedFilesTruncated?: boolean;
  recentCommits: GitCommitSummary[];
  github: GitHubPanelState;
  diffStats?: WorktreeDiffStats | null;
  prStatus?: TaskPrStatus;
  prUnsupported?: boolean;
  remoteBranchExists?: boolean;
  /** Current HEAD commit SHA (full). `null` when detached/unresolvable. */
  headSha?: string | null;
  /**
   * The merge, rebase or cherry-pick this worktree is stopped part-way through,
   * or null. It rides on the panel state rather than being asked for separately
   * because it is a filesystem probe, not a Git command, and costs a normal
   * panel read nothing (`docs/design/git-delivery.md` §9).
   */
  conflictOperation?: GitConflictOperation | null;
}

export interface GitDiffData {
  sessionId: string;
  workDir?: string | null;
  path: string;
  diff: string;
  truncated: boolean;
}

/**
 * What a Git action answers with. A failure is a value rather than an error
 * shape because ADR 0005 requires the classified kind, the raw stderr and the
 * change set to survive all the way to the client.
 */
export interface GitActionFailure {
  kind: GitFailureKind;
  message: string;
  stderr: string;
  /**
   * What the command wrote on stdout. Kept alongside stderr because a Git
   * command can split its account across both: `git pull` reports the fetch on
   * stderr and the merge — "CONFLICT (content): …", "Automatic merge failed" —
   * on stdout, so a failure holding only stderr says a ref moved and never that
   * the merge could not be finished.
   */
  stdout: string;
  exitCode: number | null;
  changedFiles: GitChangedFile[];
}

export interface GitCommitOutcome {
  action: "commit";
  sha: string;
  subject: string;
  branch: string | null;
  /** The paths the commit actually named, in selection order. */
  files: string[];
}

export interface GitPushOutcome {
  action: "push";
  branch: string;
  /**
   * Where the branch tracks now that the push has landed, e.g. `origin/main`.
   * Null when Git would not say — the push still happened.
   */
  remoteBranch: string | null;
  /** True when this push is what created the tracking link. */
  setUpstream: boolean;
}

export interface GitPullOutcome {
  action: "pull";
  branch: string;
  /** The tracking branch the commits came from, e.g. `origin/main`. */
  upstream: string;
}

export interface GitCreatePullRequestOutcome {
  action: "create_pr";
  /** The branch the pull request was opened from. */
  branch: string;
  /**
   * Null when neither `gh pr create` nor the read-back after it named the pull
   * request — which does not make the pull request any less created.
   */
  url: string | null;
  /** Null when the pull request was created but could not be read back. */
  number: number | null;
  /**
   * What GitHub actually opened it against. Read back rather than assembled —
   * the repository's default base is GitHub's answer, not ours — and null when
   * that read stumbled after the pull request already existed.
   */
  baseBranch: string | null;
}

/**
 * The way out of an unfinished merge, rebase or cherry-pick
 * (`docs/design/git-delivery.md` §9).
 */
export interface GitAbortOutcome {
  action: "abort";
  /**
   * What was actually aborted. Read from the worktree immediately before the
   * command ran rather than taken from the request, so the report names the
   * operation Git was in and not the one the menu was drawn for.
   */
  operation: GitConflictOperation;
  /**
   * The branch the worktree is back on. Read *after* the abort: a rebase runs on
   * a detached HEAD, and the branch only exists again once the abort is done.
   * Null when the abort restored a detached HEAD, which a cherry-pick can.
   */
  branch: string | null;
}

export type GitActionOutcome =
  | GitCommitOutcome
  | GitPushOutcome
  | GitPullOutcome
  | GitCreatePullRequestOutcome
  | GitAbortOutcome;

export type GitActionResult =
  | { ok: true; outcome: GitActionOutcome }
  | { ok: false; failure: GitActionFailure };

export interface GitChangedFilesData {
  sessionId: string;
  changedFiles: GitChangedFile[];
  /** Total number of changed files before capping to `changedFiles`. */
  changedFilesTotal?: number;
  /** True when `changedFiles` was capped and omits some entries. */
  changedFilesTruncated?: boolean;
}
