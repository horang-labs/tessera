import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  buildManagedWorktreeName,
  buildManagedWorktreeRelativePath,
  buildManagedWorktreeSlug,
  normalizeManagedWorktreeSlug,
} from './naming';

export const MANAGED_WORKTREE_ROOT = path.join(os.homedir(), '.tessera', 'worktrees');

interface ManagedWorktreeAllocation {
  branchName: string;
  worktreePath: string;
}

export class ManagedWorktreeAllocationError extends Error {
  constructor(
    readonly code: 'name_unavailable' | 'allocation_failed',
    message: string,
    readonly branchName?: string,
    readonly worktreePath?: string
  ) {
    super(message);
  }
}

export async function allocateManagedWorktree(
  projectDir: string,
  branchPrefix?: string | null,
  branchSlug?: string | null,
  options: { allowCollisionSuffix?: boolean } = {}
): Promise<ManagedWorktreeAllocation> {
  await fs.mkdir(MANAGED_WORKTREE_ROOT, { recursive: true, mode: 0o700 });

  const now = new Date();
  const baseSlug = normalizeManagedWorktreeSlug(branchSlug) || buildManagedWorktreeSlug(now);
  const maxAttempts = options.allowCollisionSuffix === false ? 1 : 20;

  let firstCollision: ManagedWorktreeAllocation | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const branchName = buildManagedWorktreeName(projectDir, attempt, now, branchPrefix, baseSlug);
    const worktreePath = path.join(
      MANAGED_WORKTREE_ROOT,
      ...buildManagedWorktreeRelativePath(projectDir, branchName).split('/')
    );

    const branchExists = await localBranchExists(projectDir, branchName);
    const worktreePathExists = await pathExists(worktreePath);
    if (branchExists || worktreePathExists) {
      firstCollision ??= { branchName, worktreePath };
      continue;
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
    return { branchName, worktreePath };
  }

  if (options.allowCollisionSuffix === false && firstCollision) {
    throw new ManagedWorktreeAllocationError(
      'name_unavailable',
      `Branch or worktree path already exists: ${firstCollision.branchName}`,
      firstCollision.branchName,
      firstCollision.worktreePath
    );
  }

  throw new ManagedWorktreeAllocationError(
    'allocation_failed',
    'Failed to allocate managed worktree name'
  );
}

export function isManagedWorktreePath(candidate: string): boolean {
  const root = path.resolve(MANAGED_WORKTREE_ROOT);
  const resolved = path.resolve(candidate);
  return resolved.startsWith(`${root}${path.sep}`);
}

export async function removeManagedWorktree(projectDir: string, worktreePath: string): Promise<void> {
  await runGitCommand(
    ['-C', projectDir, 'worktree', 'remove', '--force', worktreePath],
    'git worktree remove'
  );

  await fs.rm(worktreePath, { recursive: true, force: true });
}

async function localBranchExists(projectDir: string, branchName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', projectDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function runGitCommand(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new Error(stderr || `${label} exited with code ${code}`));
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}
