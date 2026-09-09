import type { GitRunner } from './git-runner';
import { listWorktreeBaseRefs } from './base-refs';

export type WorktreeBranchSwitchErrorCode = 'branch_required' | 'branch_not_found';

export class WorktreeBranchSwitchError extends Error {
  constructor(
    readonly code: WorktreeBranchSwitchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeBranchSwitchError';
  }
}

/** Switch an existing checkout to an exact local branch selected from Git refs. */
export async function switchWorktreeBranch(options: {
  workDir: string;
  branch: string;
  runGit: GitRunner;
}): Promise<string> {
  const { workDir, runGit } = options;
  const branch = options.branch;
  if (!branch.trim()) {
    throw new WorktreeBranchSwitchError('branch_required', 'Branch is required.');
  }
  // The picker submits exact ref names. Do not normalize a value at this trust
  // boundary: whitespace or option-like input must never select another ref.
  if (branch !== branch.trim() || branch.startsWith('-')) {
    throw new WorktreeBranchSwitchError(
      'branch_not_found',
      `Local branch '${branch}' does not exist.`,
    );
  }

  const refs = await listWorktreeBaseRefs(workDir, runGit);
  const target = refs.find((ref) => ref.kind === 'local' && ref.name === branch);
  if (!target) {
    throw new WorktreeBranchSwitchError(
      'branch_not_found',
      `Local branch '${branch}' does not exist.`,
    );
  }
  if (target.current) return branch;

  await runGit(['-C', workDir, 'switch', '--no-guess', branch]);
  return branch;
}
