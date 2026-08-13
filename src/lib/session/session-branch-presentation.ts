export interface SessionBranchPresentation {
  branch: string;
  labelKind: 'branch' | 'scope';
  liveBranch: string | null;
  mismatch: boolean;
}

export function resolveSessionBranchPresentation({
  worktreeBranch,
  scopeBranch,
  liveBranch,
}: {
  worktreeBranch?: string;
  scopeBranch?: string;
  liveBranch?: string | null;
}): SessionBranchPresentation | null {
  // A task-owned Worktree has its own checkout branch. Newer records also
  // carry scopeBranch for Project-view placement, but that internal scope must
  // not replace the Worktree's actual branch in the Session header.
  if (worktreeBranch) {
    return {
      branch: worktreeBranch,
      labelKind: 'branch',
      liveBranch: null,
      mismatch: false,
    };
  }
  if (scopeBranch) {
    const current = liveBranch ?? null;
    return {
      branch: scopeBranch,
      labelKind: 'scope',
      liveBranch: current,
      mismatch: current !== null && current !== scopeBranch,
    };
  }
  return null;
}
