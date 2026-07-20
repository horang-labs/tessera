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
