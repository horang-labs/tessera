import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { SettingsManager } from '@/lib/settings/manager';
import { createGitRunner } from '@/lib/worktrees/git-runner';
import { listWorktreeBaseRefs } from '@/lib/worktrees/base-refs';
import { checkManagedWorktreePreflight } from '@/lib/worktrees/preflight';

export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) {
    return auth.response;
  }
  const { userId } = auth;

  const projectDir = req.nextUrl.searchParams.get('projectDir');
  if (!projectDir) {
    return NextResponse.json({ error: 'projectDir is required' }, { status: 400 });
  }

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

  try {
    const refs = await listWorktreeBaseRefs(projectDir, runGit);
    return NextResponse.json({ refs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ projectDir, error: message }, 'Failed to list worktree base refs');
    return NextResponse.json(
      { error: `Failed to list worktree base refs: ${message}` },
      { status: 500 },
    );
  }
}

function isAbsoluteFilesystemPath(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}
