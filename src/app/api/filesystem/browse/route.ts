import { NextRequest, NextResponse } from 'next/server';
import { readdir, stat, access, constants } from 'fs/promises';
import path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  formatBrowsePathForDisplay,
  getBrowseParentPath,
  normalizeFilesystemBrowseEnvironment,
  resolveBrowsePath,
} from '@/lib/filesystem/path-environment';
import { validateProjectEnvironment } from '@/lib/projects/environment-policy';
import { SettingsManager } from '@/lib/settings/manager';

interface DirectoryEntry {
  name: string;
  path: string;
  filesystemPath: string;
  isGitRepo: boolean;
}

interface BrowseResponse {
  currentPath: string;
  filesystemPath: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
  isGitRepo: boolean;
}

/**
 * GET /api/filesystem/browse?path=/some/path
 *
 * Returns directory listing for folder browser dialog.
 * Only returns directories (not files) for project folder selection.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const searchParams = request.nextUrl.searchParams;
  const rawPath = searchParams.get('path');
  const showHidden = searchParams.get('showHidden') === 'true';
  const environment = normalizeFilesystemBrowseEnvironment(searchParams.get('environment'));

  try {
    const settings = await SettingsManager.load(auth.userId);
    if (environment !== settings.agentEnvironment) {
      const expected = settings.agentEnvironment === 'wsl' ? 'WSL' : 'Windows Native';
      return NextResponse.json(
        {
          code: 'PROJECT_ENVIRONMENT_MISMATCH',
          error: `Current Agent Environment is ${expected}. Switch Agent Environment to browse this filesystem.`,
        },
        { status: 400 },
      );
    }

    const resolvedPath = await resolveBrowsePath(rawPath, environment);
    const targetPath = resolvedPath.filesystemPath;
    const environmentValidation = validateProjectEnvironment(
      targetPath,
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

    // Verify directory exists and is accessible
    await access(targetPath, constants.R_OK);
    const targetStat = await stat(targetPath);
    if (!targetStat.isDirectory()) {
      return NextResponse.json(
        { error: 'Path is not a directory' },
        { status: 400 }
      );
    }

    // Read directory entries
    const dirEntries = await readdir(targetPath, { withFileTypes: true });

    // Filter to directories only, exclude hidden dirs (except common ones)
    const entries: DirectoryEntry[] = [];

    await Promise.all(
      dirEntries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          // Hide hidden directories (starting with .) unless showHidden is enabled
          if (!showHidden && entry.name.startsWith('.') && entry.name !== '.claude') return false;
          // Hide node_modules and other common non-project dirs
          if (entry.name === 'node_modules' || entry.name === '__pycache__') return false;
          return true;
        })
        .map(async (entry) => {
          const entryPath = path.resolve(targetPath, entry.name);
          // Check if directory contains .git (is a git repo)
          let isGitRepo = false;
          try {
            await access(path.resolve(entryPath, '.git'), constants.F_OK);
            isGitRepo = true;
          } catch {
            // Not a git repo
          }
          entries.push({
            name: entry.name,
            path: await formatBrowsePathForDisplay(entryPath, environment),
            filesystemPath: entryPath,
            isGitRepo,
          });
        })
    );

    // Sort: git repos first, then alphabetically
    entries.sort((a, b) => {
      if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Check if current directory is a git repo
    let isGitRepo = false;
    try {
      await access(path.resolve(targetPath, '.git'), constants.F_OK);
      isGitRepo = true;
    } catch {
      // Not a git repo
    }

    // Parent path (null if at root)
    const parentPath = getBrowseParentPath(resolvedPath.displayPath, targetPath, environment);

    const response: BrowseResponse = {
      currentPath: resolvedPath.displayPath,
      filesystemPath: targetPath,
      parentPath,
      entries,
      isGitRepo,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to browse directory';
    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}
