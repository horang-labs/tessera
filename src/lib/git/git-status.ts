/**
 * `git status --porcelain=v1 -z` parsing, kept apart from the panel so the Git
 * action execution module can read a change set without importing anything that
 * resolves sessions (`docs/design/git-delivery.md` §10).
 */
import type { GitChangedFile, GitFileState } from "@/types/git";

function inferFileState(
  indexStatus: string,
  workTreeStatus: string,
): GitFileState {
  const pair = `${indexStatus}${workTreeStatus}`;
  if (pair === "??") return "untracked";
  if (pair.includes("U") || pair === "AA" || pair === "DD") return "conflicted";
  if (indexStatus === "R" || workTreeStatus === "R") return "renamed";
  if (indexStatus === "C" || workTreeStatus === "C") return "copied";
  if (indexStatus === "A" || workTreeStatus === "A") return "added";
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "T" || workTreeStatus === "T") return "typechange";
  if (indexStatus === "M" || workTreeStatus === "M") return "modified";
  return "unknown";
}

export function parseGitStatus(stdout: string): GitChangedFile[] {
  const tokens = stdout.split("\0").filter(Boolean);
  const files: GitChangedFile[] = [];
  let index = tokens[0]?.startsWith("## ") ? 1 : 0;

  while (index < tokens.length) {
    const entry = tokens[index];
    if (!entry || entry.length < 3) {
      index += 1;
      continue;
    }

    const indexStatus = entry[0] ?? " ";
    const workTreeStatus = entry[1] ?? " ";
    const pathValue = entry.slice(3);
    let previousPath: string | undefined;

    if (
      indexStatus === "R" ||
      workTreeStatus === "R" ||
      indexStatus === "C" ||
      workTreeStatus === "C"
    ) {
      previousPath = tokens[index + 1] || undefined;
      index += 1;
    }

    const state = inferFileState(indexStatus, workTreeStatus);
    const displayStatus = `${indexStatus}${workTreeStatus}`.trim() || "??";

    files.push({
      path: pathValue,
      ...(previousPath ? { previousPath } : {}),
      indexStatus,
      workTreeStatus,
      state,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: workTreeStatus !== " ",
      displayStatus,
    });

    index += 1;
  }

  return files;
}
