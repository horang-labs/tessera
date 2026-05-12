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
