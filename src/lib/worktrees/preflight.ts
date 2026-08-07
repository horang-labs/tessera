import type { GitRunner } from './git-runner';

export type ManagedWorktreePreflightCode =
  | 'GIT_NOT_INSTALLED'
  | 'PROJECT_NOT_GIT_REPOSITORY';

export interface ManagedWorktreePreflightFailure {
  ok: false;
  code: ManagedWorktreePreflightCode;
  error: string;
  status: number;
  installUrl?: string;
}

export interface ManagedWorktreePreflightSuccess {
  ok: true;
}

export type ManagedWorktreePreflightResult =
  | ManagedWorktreePreflightSuccess
  | ManagedWorktreePreflightFailure;

export const GIT_INSTALL_URL = 'https://git-scm.com/downloads';

/** `runGit` is required: Git only ever runs through the one runner (ADR 0006). */
export async function checkManagedWorktreePreflight(
  projectDir: string,
  runGit: GitRunner,
): Promise<ManagedWorktreePreflightResult> {
  const version = await runSafely(runGit, ['--version']);
  if (!version.ok && isGitMissingError(version.error)) {
    return {
      ok: false,
      code: 'GIT_NOT_INSTALLED',
      status: 424,
      error: 'Git is required to create a managed worktree. Install Git, then try again.',
      installUrl: GIT_INSTALL_URL,
    };
  }

  const isRepo = await runSafely(runGit, [
    '-C',
    projectDir,
    'rev-parse',
    '--is-inside-work-tree',
  ]);

  if (!isRepo.ok || isRepo.stdout.trim() !== 'true') {
    return {
      ok: false,
      code: 'PROJECT_NOT_GIT_REPOSITORY',
      status: 422,
      error: 'This project directory is not a Git repository.',
    };
  }

  return { ok: true };
}

async function runSafely(
  runGit: GitRunner,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: unknown; stdout: string }> {
  try {
    const result = await runGit(args);
    return { ok: true, stdout: result.stdout };
  } catch (error: unknown) {
    return { ok: false, error, stdout: '' };
  }
}

function isGitMissingError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'code' in error) {
    return (error as { code?: unknown }).code === 'ENOENT';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENOENT') || message.includes('spawn git');
}
