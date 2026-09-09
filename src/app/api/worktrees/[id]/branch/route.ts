import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { GitPanelError, resolveWorktreeGitTarget } from '@/lib/git/git-panel';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';
import { createGitRunner, GitCommandError } from '@/lib/worktrees/git-runner';
import { listWorktreeBaseRefs } from '@/lib/worktrees/base-refs';
import {
  switchWorktreeBranch,
  WorktreeBranchSwitchError,
} from '@/lib/worktrees/switch-branch';

interface SwitchBranchBody {
  branch?: unknown;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) return auth.response;

    const target = await resolveWorktreeGitTarget(id, auth.userId);
    const refs = await listWorktreeBaseRefs(
      target.workDir,
      createGitRunner(target.agentEnvironment),
    );
    return NextResponse.json({ refs });
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    if (error instanceof GitCommandError) {
      return jsonError('refs_failed', error.stderr || error.message, 500);
    }
    logger.error({ error, worktreeId: id }, 'Failed to list Worktree branches');
    return jsonError('internal_error', 'Failed to list branches', 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    if ('response' in auth) return auth.response;

    const body = await request.json().catch(() => null) as SwitchBranchBody | null;
    if (typeof body?.branch !== 'string') {
      return jsonError('invalid_request', 'branch must be a string', 400);
    }

    const target = await resolveWorktreeGitTarget(id, auth.userId);
    const runGit = createGitRunner(target.agentEnvironment);
    const currentBranch = await switchWorktreeBranch({
      workDir: target.workDir,
      branch: body.branch,
      runGit,
    });
    try {
      const refs = await listWorktreeBaseRefs(target.workDir, runGit);
      return NextResponse.json({ ok: true, currentBranch, refs });
    } catch (error) {
      // The checkout already changed. Preserve that successful result and let
      // the client update its current marker even if a read-only refresh fails.
      logger.warn({ error, worktreeId: id }, 'Switched Worktree branch but could not refresh refs');
      return NextResponse.json({ ok: true, currentBranch });
    }
  } catch (error) {
    if (error instanceof WorktreeBranchSwitchError) {
      return jsonError(error.code, error.message, 400);
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    if (error instanceof GitCommandError) {
      return jsonError('checkout_failed', error.stderr || error.message, 409);
    }
    logger.error({ error, worktreeId: id }, 'Failed to switch Worktree branch');
    return jsonError('internal_error', 'Failed to switch branch', 500);
  }
}
