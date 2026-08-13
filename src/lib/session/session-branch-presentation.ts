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
  if (scopeBranch) {
    const current = liveBranch ?? null;
    return {
      branch: scopeBranch,
      labelKind: 'scope',
      liveBranch: current,
      mismatch: current !== null && current !== scopeBranch,
    };
  }
  if (!worktreeBranch) return null;
  return {
    branch: worktreeBranch,
    labelKind: 'branch',
    liveBranch: null,
    mismatch: false,
  };
}
