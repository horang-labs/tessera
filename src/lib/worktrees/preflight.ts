import { spawn } from 'child_process';
import type { GitRunner, GitRunResult } from './git-runner';

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

export async function checkManagedWorktreePreflight(
  projectDir: string,
  runGit: GitRunner = runGitCommand,
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

function runGitCommand(args: string[]): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `git exited with code ${code}`));
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}
