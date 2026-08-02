import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import logger from '@/lib/logger';
import { scanIgnoredFiles } from '@/lib/projects/ignored-file-scan';
import { SettingsManager } from '@/lib/settings/manager';
import { createGitRunner } from '@/lib/worktrees/git-runner';

/** A read-only query, so a wedged repository does not hold the panel open. */
const SCAN_TIMEOUT_MS = 30_000;

/**
 * GET /api/projects/ignored-files?projectId=...
 *
 * The files git ignores in a project's original checkout, collapsed at
 * directory level — the candidates for copying into each new worktree.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;
  const { userId } = auth;

  const projectId = req.nextUrl.searchParams.get('projectId')?.trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  // git is only ever pointed at the directory the project row holds, so a
  // caller cannot have it read somewhere Tessera does not already know about.
  const project = dbProjects.getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  try {
    const settings = await SettingsManager.load(userId);
    const runGit = createGitRunner(settings.agentEnvironment, { timeoutMs: SCAN_TIMEOUT_MS });
    const scan = await scanIgnoredFiles(project.decoded_path, runGit);
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, projectId }, 'Failed to scan ignored files');
    return NextResponse.json({ error: 'Failed to scan ignored files' }, { status: 500 });
  }
}
