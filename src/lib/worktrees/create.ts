import type { GitRunner } from './git-runner';

export type WorktreeCreationSource =
  | {
      mode: 'branch-off';
      baseRef: string | null;
    }
  | {
      mode: 'checkout-branch';
      /** Local branch name, or the explicitly selected remote-tracking ref. */
      branch: string;
    };

export class WorktreeCreationError extends Error {
  constructor(
    readonly code: 'branch_not_found' | 'branch_already_checked_out',
    message: string,
    readonly branchName?: string,
    readonly holderWorktreePath?: string,
  ) {
    super(message);
    this.name = 'WorktreeCreationError';
  }
}

export interface WorktreeCreationResult {
  /** Whether this invocation created the local branch as well as the Worktree. */
  createdBranch: boolean;
}

export async function createGitWorktree(options: {
  projectDir: string;
  worktreePath: string;
  branchName: string;
  source: WorktreeCreationSource;
  runGit: GitRunner;
}): Promise<WorktreeCreationResult> {
  const { projectDir, worktreePath, branchName, source, runGit } = options;
  if (source.mode === 'checkout-branch') {
    return checkoutExistingBranch({
      projectDir,
      worktreePath,
      branchName,
      selectedBranch: source.branch,
      runGit,
    });
  }

  const gitBaseRef = await resolveGitBaseRef(projectDir, source.baseRef, runGit);

  await runGit(buildBranchOffArgs(projectDir, worktreePath, branchName, gitBaseRef));
  await recordWorktreeBaseRef(
    projectDir,
    branchName,
    source.baseRef ?? 'HEAD',
    runGit,
  );
  return { createdBranch: true };
}

async function checkoutExistingBranch(options: {
  projectDir: string;
  worktreePath: string;
  branchName: string;
  selectedBranch: string;
  runGit: GitRunner;
}): Promise<WorktreeCreationResult> {
  const { projectDir, worktreePath, branchName, selectedBranch, runGit } = options;
  const holderPath = await findWorktreeHoldingBranch(projectDir, branchName, runGit);
  if (holderPath) {
    throw new WorktreeCreationError(
      'branch_already_checked_out',
      `Branch '${branchName}' is already checked out in Worktree '${holderPath}'.`,
      branchName,
      holderPath,
    );
  }

  if (await refExists(projectDir, `refs/heads/${branchName}`, runGit)) {
    await runGit([
      '-C', projectDir, 'worktree', 'add', worktreePath, branchName,
    ]);
    return { createdBranch: false };
  }

  const remoteRef = `refs/remotes/${selectedBranch}`;
  if (
    selectedBranch === branchName
    || !await refExists(projectDir, remoteRef, runGit)
  ) {
    throw new WorktreeCreationError(
      'branch_not_found',
      `Branch '${selectedBranch}' does not exist.`,
      selectedBranch,
    );
  }

  await runGit([
    '-C', projectDir, 'worktree', 'add', worktreePath,
    '-b', branchName, '--track', selectedBranch,
  ]);
  return { createdBranch: true };
}

async function findWorktreeHoldingBranch(
  projectDir: string,
  branchName: string,
  runGit: GitRunner,
): Promise<string | null> {
  const result = await runGit([
    '-C', projectDir, 'worktree', 'list', '--porcelain', '-z',
  ]);
  const branchRef = `refs/heads/${branchName}`;
  let worktreePath: string | null = null;

  for (const field of result.stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      worktreePath = field.slice('worktree '.length);
    } else if (field === `branch ${branchRef}` && worktreePath) {
      return worktreePath;
    } else if (!field) {
      worktreePath = null;
    }
  }

  return null;
}

async function refExists(
  projectDir: string,
  ref: string,
  runGit: GitRunner,
): Promise<boolean> {
  try {
    await runGit([
      '-C', projectDir, 'show-ref', '--verify', '--quiet', ref,
    ]);
    return true;
  } catch {
    return false;
  }
}

function buildBranchOffArgs(
  projectDir: string,
  worktreePath: string,
  branchName: string,
  baseRef: string | null,
): string[] {
  // The base is a start point, never an upstream. Without `--no-track`, Git's
  // branch.autoSetupMerge may adopt a remote-tracking base as this new branch's
  // upstream even though the branch has not been published there.
  const args = [
    '-C', projectDir, 'worktree', 'add', '--no-track', worktreePath, '-b', branchName,
  ];
  if (baseRef) args.push(baseRef);
  return args;
}

async function resolveGitBaseRef(
  projectDir: string,
  baseRef: string | null,
  runGit: GitRunner,
): Promise<string | null> {
  if (!baseRef?.startsWith('-')) return baseRef;

  // `git worktree add` forwards a dash-prefixed start point to its internal
  // branch command as an option. The control path accepts such exact ref names,
  // so use the already-verifiable commit only for the creation invocation.
  const result = await runGit([
    '-C', projectDir, 'rev-parse', '--verify', '--quiet', '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  return result.stdout.trim();
}

/** Record where this Worktree was cut from for later Git-panel and PR reads. */
async function recordWorktreeBaseRef(
  projectDir: string,
  branch: string,
  startPoint: string,
  runGit: GitRunner,
): Promise<void> {
  let baseRef: string;
  try {
    const result = await runGit([
      '-C', projectDir, 'rev-parse', '--verify', '--quiet',
      '--symbolic-full-name', '--end-of-options', startPoint,
    ]);
    baseRef = result.stdout.trim();
  } catch {
    return;
  }

  // A start point given as a commit has no symbolic lineage worth recording.
  if (!baseRef.startsWith('refs/')) return;

  await runGit([
    '-C', projectDir, 'config', '--local', '--replace-all',
    `branch.${branch}.base`, baseRef,
  ]).catch(() => undefined);
}
