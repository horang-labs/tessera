import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import {
  getFilesystemPathBasename,
  resolveNativeFilesystemPath,
} from '@/lib/filesystem/path-environment';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { SettingsManager } from '@/lib/settings/manager';

/**
 * POST /api/projects — Register a project directory (no session creation).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const body = await req.json();
  const { folderPath } = body as { folderPath?: string };

  if (!folderPath || typeof folderPath !== 'string') {
    return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
  }

  const resolvedPath = resolveNativeFilesystemPath(folderPath);
  const settings = await SettingsManager.load(auth.userId);
  const environmentValidation = validateProjectEnvironment(
    resolvedPath,
    settings.agentEnvironment,
  );
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

  if (!fs.existsSync(resolvedPath)) {
    return NextResponse.json({ error: 'Directory does not exist' }, { status: 400 });
  }

  const displayName = getFilesystemPathBasename(resolvedPath);
  dbProjects.registerProject(resolvedPath, resolvedPath, displayName);

  return NextResponse.json({ ok: true, projectId: resolvedPath, displayName });
}
