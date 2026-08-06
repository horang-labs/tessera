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

/** How much of a Git failure a toast carries before it stops being readable. */
const FAILURE_TOAST_LIMIT = 180;

/**
 * Git failures arrive as raw stderr, which for a rejecting hook can be pages of
 * it. A toast gets the first line that says something, truncated.
 */
export function summarizeGitFailure(message: string): string {
  const firstMeaningfulLine =
    message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? message.trim();

  return truncateForToast(firstMeaningfulLine);
}

/**
 * A hook reads the other way round. Git leads with what went wrong, but a hook
 * runner narrates its way there — "Preparing lint-staged…" first, the verdict
 * last — and Git relays the whole of it. Taking the first line would quote the
 * hook starting up rather than the hook refusing.
 */
export function summarizeHookRejection(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  return truncateForToast(lines[lines.length - 1] ?? message.trim());
}

/**
 * How Git prefixes a line it wrote as a diagnostic. Restated here rather than
 * imported from the runner, which is a server module and would drag `spawn-cli`
 * into the renderer bundle.
 */
const GIT_DIAGNOSTIC_PREFIXES = ["fatal:", "error:", "warning:", "hint:"];

/**
 * A pull is two commands wearing one name, and each writes somewhere else: the
 * fetch reports on stderr ("From origin", then the refs it moved) and the merge
 * on stdout ("Auto-merging f.txt", the CONFLICT lines, "Automatic merge failed…"
 * last). Reading only `gitSaid` therefore quotes a ref that moved successfully
 * as though it were the reason the pull failed.
 *
 * So: Git's own voice wins wherever it appears — it leads with `fatal:` and
 * trails hints, and the top of that is what happened. Failing that, the merge
 * narrated its way to a verdict and the bottom of `stdout` is it.
 */
export function summarizeMergeFailure(stdout: string, gitSaid: string): string {
  if (!hasGitDiagnosticLine(gitSaid)) {
    const merge = lastMeaningfulLine(stdout);
    if (merge) return truncateForToast(merge);
  }

  return summarizeGitFailure(gitSaid);
}

function hasGitDiagnosticLine(text: string): boolean {
  return text.split("\n").some((line) => {
    const normalized = line.trim().toLowerCase();
    return GIT_DIAGNOSTIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

function lastMeaningfulLine(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

function truncateForToast(line: string): string {
  return line.length > FAILURE_TOAST_LIMIT
    ? `${line.slice(0, FAILURE_TOAST_LIMIT)}…`
    : line;
}

export function getFileScopeLabel(file: GitChangedFile | null): string | null {
  if (!file) return null;
  if (file.state === "untracked") return "Working tree";
  if (file.staged && file.unstaged) return "Staged + working tree";
  if (file.staged) return "Staged";
  if (file.unstaged) return "Working tree";
  return null;
}
