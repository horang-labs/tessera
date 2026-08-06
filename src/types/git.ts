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
  taskId?: string;
  workDir: string;
  repoRoot: string;
  repoName: string;
  worktreeName: string;
  worktreePath: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
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

export type GitActionOutcome = GitCommitOutcome;

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
