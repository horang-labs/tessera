import {
  FileCode2,
  GitPullRequest,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import type {
  GitChangedFile,
  GitFileState,
  GitPanelData,
} from "@/types/git";

export type GitTab = "diff" | "pr" | "context";
export type ActiveGitAction = "commit" | "merge" | "create-pr" | "merge-pr" | null;

export interface GitFooterButtonStates {
  showMergePr: boolean;
  commitDisabled: boolean;
  pushDisabled: boolean;
  pullDisabled: boolean;
  syncDisabled: boolean;
  createPrDisabled: boolean;
  mergePrDisabled: boolean;
}

export function computeGitFooterButtonStates(
  data: GitPanelData,
  isSessionBusy: boolean,
  activeAction: ActiveGitAction,
): GitFooterButtonStates {
  const availableBranches = (data.branches ?? []).filter(
    (branch) => branch !== data.branch,
  );
  const prState = data.prStatus?.state;
  const hasChangedFiles = data.changedFiles.length > 0;
  const hasUnpushedCommits = (data.ahead ?? 0) > 0;

  // After a PR is merged/closed, HEAD diverging from the PR's recorded head
  // commit means the user has new commits beyond what the PR captured —
  // i.e. there is fresh work that warrants a new PR.
  const headSha = data.headSha ?? null;
  const prHeadOid = data.prStatus?.headRefOid ?? null;
  const hasPostPrCommits =
    (prState === "merged" || prState === "closed")
    && headSha !== null
    && prHeadOid !== null
    && headSha !== prHeadOid;

  const hasPrContent =
    hasChangedFiles || hasUnpushedCommits || hasPostPrCommits;

  const branchStillOnRemote = data.remoteBranchExists !== false;
  const hasMergeablePr = prState === "open" && branchStillOnRemote;

  return {
    showMergePr: hasMergeablePr,
    commitDisabled:
      isSessionBusy || activeAction !== null || !hasChangedFiles,
    pushDisabled:
      isSessionBusy
      || activeAction !== null
      || (!hasUnpushedCommits && !!data.upstream),
    pullDisabled:
      isSessionBusy || activeAction !== null || (data.behind ?? 0) === 0,
    syncDisabled:
      isSessionBusy || activeAction !== null || availableBranches.length === 0,
    createPrDisabled:
      isSessionBusy
      || activeAction !== null
      || data.prUnsupported === true
      || data.github.available === false
      || !hasPrContent,
    mergePrDisabled: isSessionBusy || activeAction !== null,
  };
}

export const GIT_PANEL_TABS: Array<{
  id: GitTab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "diff", label: "Diff", icon: FileCode2 },
  { id: "pr", label: "PR", icon: GitPullRequest },
  { id: "context", label: "Context", icon: ScrollText },
];

export const FILE_STATE_META: Record<
  GitFileState,
  { label: string; className: string; statusClassName: string }
> = {
  modified: {
    label: "Modified",
    className: "border-[#db8b2b]/25 bg-transparent text-[#db8b2b]",
    statusClassName: "text-[#db8b2b]",
  },
  added: {
    label: "Added",
    className: "border-[#2f8753]/25 bg-transparent text-[#2f8753]",
    statusClassName: "text-[#2f8753]",
  },
  deleted: {
    label: "Deleted",
    className: "border-[#c94c4c]/25 bg-transparent text-[#c94c4c]",
    statusClassName: "text-[#c94c4c]",
  },
  renamed: {
    label: "Renamed",
    className: "border-[#4a8cd6]/25 bg-transparent text-[#4a8cd6]",
    statusClassName: "text-[#4a8cd6]",
  },
  copied: {
    label: "Copied",
    className: "border-[#4a8cd6]/25 bg-transparent text-[#4a8cd6]",
    statusClassName: "text-[#4a8cd6]",
  },
  untracked: {
    label: "Untracked",
    className: "border-[#2f8753]/25 bg-transparent text-[#2f8753]",
    statusClassName: "text-[#2f8753]",
  },
  conflicted: {
    label: "Conflict",
    className: "border-[#b54b7f]/25 bg-transparent text-[#b54b7f]",
    statusClassName: "text-[#b54b7f]",
  },
  typechange: {
    label: "Type",
    className: "border-[#6d7a8a]/25 bg-transparent text-[#6d7a8a]",
    statusClassName: "text-[#6d7a8a]",
  },
  unknown: {
    label: "Changed",
    className:
      "border-(--divider) bg-transparent text-(--text-secondary)",
    statusClassName: "text-(--text-secondary)",
  },
};

export function extractGitPanelErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const error =
    "error" in payload ? (payload as { error?: unknown }).error : undefined;
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
}

export function getFileScopeLabel(file: GitChangedFile | null): string | null {
  if (!file) return null;
  if (file.state === "untracked") return "Working tree";
  if (file.staged && file.unstaged) return "Staged + working tree";
  if (file.staged) return "Staged";
  if (file.unstaged) return "Working tree";
  return null;
}

export function getGitHubActionBlockReason(
  github: GitPanelData["github"],
): string | null {
  if (github.available) return null;
  if (github.reason) return github.reason;

  switch (github.reasonCode) {
    case "gh_missing":
      return "Install GitHub CLI to create and merge pull requests.";
    case "gh_unauthenticated":
      return "Run `gh auth login`, then refresh.";
    case "not_github_remote":
      return "Add a GitHub origin remote to create pull requests.";
    default:
      return "GitHub pull request actions are unavailable.";
  }
}
