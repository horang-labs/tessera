import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { SettingsManager } from '@/lib/settings/manager';
import { allocateManagedWorktree, ManagedWorktreeAllocationError } from '@/lib/worktrees/managed';
import { checkManagedWorktreePreflight } from '@/lib/worktrees/preflight';

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
 * 2. Allocates a managed temp branch/path pair under ~/.tessera/worktrees
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
  if (!path.isAbsolute(projectDir) || projectDir.includes('..')) {
    return NextResponse.json({ error: 'Invalid projectDir' }, { status: 400 });
  }

  const preflight = await checkManagedWorktreePreflight(projectDir);
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

  const settings = await SettingsManager.load(userId);
  let branchName: string;
  let worktreePath: string;
  try {
    const allocation = await allocateManagedWorktree(
      projectDir,
      branchPrefix ?? settings.gitConfig.branchPrefix,
      branchSlug,
      { allowCollisionSuffix: allowBranchSlugSuffix !== false }
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

  logger.info({ branchName, projectDir, worktreePath }, 'Creating git worktree');

  // --- Run git worktree add ---
  try {
    await runGitWorktreeAdd(projectDir, worktreePath, branchName);
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
  branchName: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-C', cwd, 'worktree', 'add', worktreePath, '-b', branchName];

    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(stderr || `git exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
