import { NextRequest, NextResponse } from 'next/server';
import { readdir, stat, access, constants } from 'fs/promises';
import { resolve, dirname, basename } from 'path';
import { homedir } from 'os';

interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseResponse {
  currentPath: string;
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
  const searchParams = request.nextUrl.searchParams;
  const rawPath = searchParams.get('path') || homedir();
  const showHidden = searchParams.get('showHidden') === 'true';

  try {
    const targetPath = resolve(rawPath);

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
          const entryPath = resolve(targetPath, entry.name);
          // Check if directory contains .git (is a git repo)
          let isGitRepo = false;
          try {
            await access(resolve(entryPath, '.git'), constants.F_OK);
            isGitRepo = true;
          } catch {
            // Not a git repo
          }
          entries.push({
            name: entry.name,
            path: entryPath,
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
      await access(resolve(targetPath, '.git'), constants.F_OK);
      isGitRepo = true;
    } catch {
      // Not a git repo
    }

    // Parent path (null if at root)
    const parentPath = targetPath === '/' ? null : dirname(targetPath);

    const response: BrowseResponse = {
      currentPath: targetPath,
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
