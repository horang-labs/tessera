export interface SessionBranchPresentation {
  branch: string;
}

export function resolveSessionBranchPresentation({
  worktreeBranch,
  scopeBranch,
}: {
  worktreeBranch?: string;
  scopeBranch?: string;
}): SessionBranchPresentation | null {
  // A task-owned Worktree has its own checkout branch. Newer records also
  // carry scopeBranch for Project-view placement, but that internal scope must
  // not replace the Worktree's actual branch in the Session header.
  if (worktreeBranch) {
    return {
      branch: worktreeBranch,
    };
  }
  if (scopeBranch) {
    return {
      branch: scopeBranch,
    };
  }
  return null;
}
