import type { GitRunner } from './git-runner';

export type WorktreeBaseRefKind = 'local' | 'remote' | 'detached';

export interface WorktreeBaseRef {
  name: string;
  label: string;
  kind: WorktreeBaseRefKind;
  current: boolean;
}

interface ParsedRef {
  name: string;
  kind: Exclude<WorktreeBaseRefKind, 'detached'>;
}

export async function listWorktreeBaseRefs(
  projectDir: string,
  runGit: GitRunner,
): Promise<WorktreeBaseRef[]> {
  const currentBranch = await readCurrentBranch(projectDir, runGit);
  const refs = parseRefList(
    (await runGit([
      '-C',
      projectDir,
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
      'refs/remotes',
    ])).stdout,
  );

  const items = refs.map((ref) => ({
    name: ref.name,
    label: ref.name,
    kind: ref.kind,
    current: ref.kind === 'local' && currentBranch === ref.name,
  }));

  if (!items.some((item) => item.current) && currentBranch) {
    items.unshift({
      name: currentBranch,
      label: currentBranch,
      kind: 'local',
      current: true,
    });
  }

  return dedupeBaseRefs(items);
}

export async function validateWorktreeBaseRef(
  projectDir: string,
  baseRef: string,
  availableRefs: WorktreeBaseRef[],
  runGit: GitRunner,
): Promise<boolean> {
  const trimmed = baseRef.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;
  if (!availableRefs.some((ref) => ref.name === trimmed)) return false;

  try {
    await runGit([
      '-C',
      projectDir,
      'rev-parse',
      '--verify',
      '--quiet',
      `${trimmed}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where this worktree was cut from, written to the key Orca already uses in
 * these repositories (`branch.<name>.base`) so both apps read one answer.
 *
 * Git records nothing about a branch's lineage: `worktree add -b` leaves the
 * start point nowhere, and once the command returns the only remaining trace is
 * the commit itself, which no longer says which ref it came from. Anything that
 * later wants to name the base has this or nothing.
 *
 * Both worktree-creating paths call this — the HTTP route the app uses and the
 * control creator the CLI uses — because a base recorded on only one of them is
 * a panel row that appears or not depending on which surface made the worktree.
 *
 * Best-effort throughout. A worktree that exists with no base recorded is a
 * worktree whose panel says less; one that fails to be created because a config
 * write failed is a worktree the user does not have.
 */
export async function recordWorktreeBaseRef(
  projectDir: string,
  branch: string,
  startPoint: string,
  runGit: GitRunner,
): Promise<void> {
  let baseRef: string;
  try {
    // `--verify` is what keeps this to one answer: without it `rev-parse` echoes
    // every argument it was given, `--end-of-options` included, and the marker
    // itself lands in the output.
    const result = await runGit([
      '-C', projectDir, 'rev-parse', '--verify', '--quiet',
      '--symbolic-full-name', '--end-of-options', startPoint,
    ]);
    baseRef = result.stdout.trim();
  } catch {
    return;
  }

  // A start point given as a commit resolves to no symbolic name, and a base
  // naming no ref is worse than an absent one: consumers rebase onto this.
  if (!baseRef.startsWith('refs/')) return;

  await runGit([
    '-C', projectDir, 'config', '--local', '--replace-all',
    `branch.${branch}.base`, baseRef,
  ]).catch(() => undefined);
}

export function buildGitWorktreeAddArgs(
  cwd: string,
  worktreePath: string,
  branchName: string,
  baseRef: string | null,
): string[] {
  const args = ['-C', cwd, 'worktree', 'add', worktreePath, '-b', branchName];
  if (baseRef) {
    args.push(baseRef);
  }
  return args;
}

async function readCurrentBranch(
  projectDir: string,
  runGit: GitRunner,
): Promise<string | null> {
  try {
    const result = await runGit([
      '-C',
      projectDir,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseRefList(stdout: string): ParsedRef[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((refName): ParsedRef[] => {
      if (refName.startsWith('refs/heads/')) {
        return [{ name: refName.slice('refs/heads/'.length), kind: 'local' }];
      }
      if (refName.startsWith('refs/remotes/')) {
        const name = refName.slice('refs/remotes/'.length);
        if (name.endsWith('/HEAD')) return [];
        return [{ name, kind: 'remote' }];
      }
      return [];
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function dedupeBaseRefs(refs: WorktreeBaseRef[]): WorktreeBaseRef[] {
  const seen = new Set<string>();
  const result: WorktreeBaseRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    result.push(ref);
  }
  return result;
}
