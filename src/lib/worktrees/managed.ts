import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import {
  buildManagedWorktreeName,
  buildManagedWorktreeRelativePath,
  buildManagedWorktreeSlug,
  normalizeManagedWorktreeSlug,
} from './naming';
import { getTesseraDataPath } from '../tessera-data-dir';
import {
  getWindowsHostedWslRootFilesystemPath,
  isWindowsHostedWslFilesystemPath,
} from '../filesystem/path-environment';
import type { AgentEnvironment } from '../settings/types';
import { createGitRunner, type GitRunner } from './git-runner';

export const MANAGED_WORKTREE_ROOT = getTesseraDataPath('worktrees');

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
  options: { allowCollisionSuffix?: boolean; rootDir?: string; runGit?: GitRunner } = {}
): Promise<ManagedWorktreeAllocation> {
  const rootDir = options.rootDir ?? MANAGED_WORKTREE_ROOT;
  const pathModule = getPathModule(rootDir);
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });

  const now = new Date();
  const baseSlug = normalizeManagedWorktreeSlug(branchSlug) || buildManagedWorktreeSlug(now);
  const maxAttempts = options.allowCollisionSuffix === false ? 1 : 20;

  let firstCollision: ManagedWorktreeAllocation | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const branchName = buildManagedWorktreeName(projectDir, attempt, now, branchPrefix, baseSlug);
    const worktreePath = pathModule.join(
      rootDir,
      ...buildManagedWorktreeRelativePath(projectDir, branchName).split('/')
    );

    const branchExists = await localBranchExists(projectDir, branchName, options.runGit);
    const worktreePathExists = await pathExists(worktreePath);
    if (branchExists || worktreePathExists) {
      firstCollision ??= { branchName, worktreePath };
      continue;
    }

    await fs.mkdir(pathModule.dirname(worktreePath), { recursive: true, mode: 0o700 });
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
  return getManagedWorktreeRelativeDisplayPath(candidate) !== null;
}

export function getManagedWorktreeRelativeDisplayPath(candidate: string): string | null {
  const defaultRelative = getRelativePathIfInside(MANAGED_WORKTREE_ROOT, candidate);
  if (defaultRelative) return defaultRelative.replace(/[\\/]+/g, '/');

  const wslHomeRoot = resolveWslHomeManagedWorktreeRoot(candidate);
  if (wslHomeRoot) {
    const wslRelative = getRelativePathIfInside(wslHomeRoot, candidate);
    if (wslRelative) return wslRelative.replace(/[\\/]+/g, '/');
  }

  const wslFallbackRoot = resolveWslFallbackManagedWorktreeRoot(candidate);
  if (!wslFallbackRoot) return null;

  const wslFallbackRelative = getRelativePathIfInside(wslFallbackRoot, candidate);
  return wslFallbackRelative ? wslFallbackRelative.replace(/[\\/]+/g, '/') : null;
}

export function resolveManagedWorktreeRoot(
  projectDir: string,
  agentEnvironment: AgentEnvironment,
): string {
  if (agentEnvironment === 'wsl') {
    return (
      resolveWslHomeManagedWorktreeRoot(projectDir)
      ?? resolveWslFallbackManagedWorktreeRoot(projectDir)
      ?? MANAGED_WORKTREE_ROOT
    );
  }

  return MANAGED_WORKTREE_ROOT;
}

export async function removeManagedWorktree(
  projectDir: string,
  worktreePath: string,
  runGit: GitRunner = createGitRunner(inferManagedGitEnvironment(projectDir, worktreePath)),
): Promise<void> {
  await runGit(
    ['-C', projectDir, 'worktree', 'remove', '--force', worktreePath],
  );

  await fs.rm(worktreePath, { recursive: true, force: true });
}

async function localBranchExists(
  projectDir: string,
  branchName: string,
  runGit: GitRunner = runGitCommand,
): Promise<boolean> {
  try {
    await runGit(['-C', projectDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function runGitCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
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

function resolveWslHomeManagedWorktreeRoot(candidate: string): string | null {
  const normalized = candidate.replace(/\//g, '\\');
  const match = normalized.match(/^(\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+)\\home\\([^\\]+)(?:\\|$)/i);
  if (!match) return null;

  return path.win32.join(match[1], 'home', match[2], '.tessera', 'worktrees');
}

function resolveWslFallbackManagedWorktreeRoot(candidate: string): string | null {
  const rootFilesystemPath = getWindowsHostedWslRootFilesystemPath(candidate);
  if (!rootFilesystemPath) return null;

  return path.win32.join(rootFilesystemPath, 'var', 'tmp', 'tessera-worktrees');
}

function inferManagedGitEnvironment(
  projectDir: string,
  worktreePath: string,
): AgentEnvironment {
  return isWindowsHostedWslFilesystemPath(projectDir) || isWindowsHostedWslFilesystemPath(worktreePath)
    ? 'wsl'
    : 'native';
}

function getRelativePathIfInside(rootDir: string, candidate: string): string | null {
  if (isWindowsStylePath(rootDir) !== isWindowsStylePath(candidate)) {
    return null;
  }

  const pathModule = getPathModule(rootDir);
  const resolvedRoot = pathModule.resolve(rootDir);
  const resolvedCandidate = pathModule.resolve(candidate);
  const relative = pathModule.relative(resolvedRoot, resolvedCandidate);

  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
    return null;
  }

  return relative;
}

function getPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) ? path.win32 : path.posix;
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}
