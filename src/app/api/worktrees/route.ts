import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { SettingsManager } from '@/lib/settings/manager';
import {
  allocateManagedWorktree,
  ManagedWorktreeAllocationError,
  resolveManagedWorktreeRoot,
} from '@/lib/worktrees/managed';
import { checkManagedWorktreePreflight } from '@/lib/worktrees/preflight';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';

/**
 * POST /api/worktrees
 *
 * Creates a git worktree for a given session.
 *
 * Request body:
 *   { projectDir: string, branchPrefix?: string, branchSlug?: string, allowBranchSlugSuffix?: boolean }
 *
 * Response (200):
 *   { worktreePath: string, branchName: string }
 *
 * Security:
 * - projectDir must be an absolute path with no ".." components
 * - Shell arguments are passed as separate argv items (no shell=true)
 *
 * This endpoint:
 * 1. Validates all inputs
 * 2. Allocates a managed temp branch/path pair under the active tool filesystem
 * 3. Runs: git -C projectDir worktree add <worktreePath> -b <branchName>
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { projectDir, branchPrefix, branchSlug, allowBranchSlugSuffix } = body as {
    projectDir?: unknown;
    branchPrefix?: unknown;
    branchSlug?: unknown;
    allowBranchSlugSuffix?: unknown;
  };

  // --- Input validation ---

  if (typeof projectDir !== 'string' || !projectDir) {
    return NextResponse.json({ error: 'projectDir is required' }, { status: 400 });
  }

  if (branchPrefix !== undefined && typeof branchPrefix !== 'string') {
    return NextResponse.json({ error: 'branchPrefix must be a string' }, { status: 400 });
  }

  if (branchSlug !== undefined && typeof branchSlug !== 'string') {
    return NextResponse.json({ error: 'branchSlug must be a string' }, { status: 400 });
  }

  if (allowBranchSlugSuffix !== undefined && typeof allowBranchSlugSuffix !== 'boolean') {
    return NextResponse.json({ error: 'allowBranchSlugSuffix must be a boolean' }, { status: 400 });
  }

  // Ensure projectDir is absolute and has no path traversal
  if (!isAbsoluteFilesystemPath(projectDir) || projectDir.includes('..')) {
    return NextResponse.json({ error: 'Invalid projectDir' }, { status: 400 });
  }

  const settings = await SettingsManager.load(userId);
  const environmentValidation = validateProjectEnvironment(projectDir, settings.agentEnvironment);
  if (!environmentValidation.ok) {
    return NextResponse.json(
      {
        code: 'PROJECT_ENVIRONMENT_MISMATCH',
        error: environmentValidation.error,
        filesystemKind: environmentValidation.filesystemKind,
        agentEnvironment: settings.agentEnvironment,
      },
      { status: 400 },
    );
  }

  const runGit = createGitRunner(settings.agentEnvironment);
  const worktreeRoot = resolveManagedWorktreeRoot(projectDir, settings.agentEnvironment);
  const preflight = await checkManagedWorktreePreflight(projectDir, runGit);
  if (!preflight.ok) {
    return NextResponse.json(
      {
        code: preflight.code,
        error: preflight.error,
        ...(preflight.installUrl ? { installUrl: preflight.installUrl } : {}),
      },
      { status: preflight.status },
    );
  }

  let branchName: string;
  let worktreePath: string;
  try {
    const allocation = await allocateManagedWorktree(
      projectDir,
      branchPrefix ?? settings.gitConfig.branchPrefix,
      branchSlug,
      {
        allowCollisionSuffix: allowBranchSlugSuffix !== false,
        rootDir: worktreeRoot,
        runGit,
      }
    );
    branchName = allocation.branchName;
    worktreePath = allocation.worktreePath;
  } catch (error) {
    if (error instanceof ManagedWorktreeAllocationError) {
      const status = error.code === 'name_unavailable' ? 409 : 500;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          branchName: error.branchName,
          worktreePath: error.worktreePath,
        },
        { status }
      );
    }
    throw error;
  }

  logger.info({ branchName, projectDir, worktreePath, worktreeRoot }, 'Creating git worktree');

  // --- Run git worktree add ---
  try {
    await runGitWorktreeAdd(projectDir, worktreePath, branchName, runGit);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ branchName, projectDir, error: msg }, 'git worktree add failed');

    // Distinguish common git errors for better client messages
    if (msg.includes('already exists')) {
      return NextResponse.json(
        { error: `Worktree path already exists: ${worktreePath}` },
        { status: 409 }
      );
    }
    if (msg.includes('is not a git repository')) {
      return NextResponse.json(
        { error: 'The project directory is not a git repository.' },
        { status: 422 }
      );
    }
    if (msg.includes('already checked out')) {
      return NextResponse.json(
        { error: `Branch '${branchName}' is already checked out.` },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Failed to create worktree: ${msg}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ worktreePath, branchName });
}

/**
 * Run `git -C <cwd> worktree add <worktreePath> -b <branchName>` safely.
 *
 * Arguments are passed as a plain argv array (no shell interpolation).
 * Rejects if the process exits non-zero.
 */
function runGitWorktreeAdd(
  cwd: string,
  worktreePath: string,
  branchName: string,
  runGit: GitRunner,
): Promise<void> {
  return runGit(['-C', cwd, 'worktree', 'add', worktreePath, '-b', branchName])
    .then(() => undefined);
}

function isAbsoluteFilesystemPath(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}
