import * as fs from 'node:fs/promises';
import { getFilesystemPathModule, isAbsoluteFilesystemPath } from '@/lib/filesystem/host-path';
import { workspaceFileWatchManager } from './workspace-file-watch-manager';
import { isInsideWorkspacePath } from './workspace-file-read-target';
import {
  normalizeWorkspaceRelativePath,
  scanWorkspaceDirectory,
  walkWorkspaceFiles,
} from './workspace-file-scan';

export interface WorkspaceRootFiles {
  directories: string[];
  files: string[];
  symlinks: string[];
  truncated: boolean;
  reason?: 'not-a-directory' | 'unreadable' | 'walk-failed';
  workDir: string;
}

export interface WorkspaceDirectoryFiles extends WorkspaceRootFiles {
  /** Workspace-relative directory whose immediate children were read. */
  directory: string;
  missing: boolean;
}

function parseWorkspaceDirectoryPath(rawPath: string): string | null {
  if (rawPath.includes('\0') || isAbsoluteFilesystemPath(rawPath)) return null;
  const parts = rawPath.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) return null;
  return normalizeWorkspaceRelativePath(rawPath);
}

/**
 * Read exactly one level for the explorer. This deliberately bypasses the
 * recursive watch snapshot: rendering the root of the Files tab must not wait
 * for an index of every descendant on a bridged Windows/WSL filesystem.
 */
export async function readWorkspaceDirectoryFiles(
  root: string,
  requestedDirectory: string,
): Promise<WorkspaceDirectoryFiles> {
  const directory = parseWorkspaceDirectoryPath(requestedDirectory);
  if (directory === null) {
    return {
      directory: '',
      directories: [],
      files: [],
      symlinks: [],
      truncated: false,
      missing: true,
      reason: 'unreadable',
      workDir: root,
    };
  }

  const pathModule = getFilesystemPathModule(root);
  try {
    const rootRealPath = await fs.realpath(root);
    const candidatePath = directory
      ? pathModule.join(rootRealPath, ...directory.split('/'))
      : rootRealPath;
    const candidateStat = await fs.lstat(candidatePath);
    // Directory links are intentionally absent from the explorer scan. Do not
    // let a hand-crafted request use one to traverse outside the workspace.
    if (candidateStat.isSymbolicLink()) throw new Error('linked directory');
    const targetRealPath = await fs.realpath(candidatePath);
    if (
      !candidateStat.isDirectory()
      || !isInsideWorkspacePath(rootRealPath, targetRealPath, pathModule)
    ) {
      throw new Error('not a workspace directory');
    }

    const result = await scanWorkspaceDirectory(rootRealPath, directory, {
      recursive: false,
    });
    return {
      directory,
      directories: result.directories,
      files: result.files,
      symlinks: result.symlinks,
      truncated: result.truncated,
      missing: result.missing,
      workDir: root,
    };
  } catch {
    return {
      directory,
      directories: [],
      files: [],
      symlinks: [],
      truncated: false,
      missing: true,
      reason: 'unreadable',
      workDir: root,
    };
  }
}

export async function readWorkspaceRootFiles(root: string): Promise<WorkspaceRootFiles> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return { directories: [], files: [], symlinks: [], truncated: false, reason: 'not-a-directory', workDir: root };
    }
  } catch {
    return { directories: [], files: [], symlinks: [], truncated: false, reason: 'unreadable', workDir: root };
  }

  try {
    const result = await workspaceFileWatchManager.ensureSnapshotForRoot(root)
      ?? await walkWorkspaceFiles(root);
    return {
      directories: result.directories,
      files: result.files,
      symlinks: result.symlinks,
      truncated: result.truncated,
      workDir: root,
    };
  } catch {
    return { directories: [], files: [], symlinks: [], truncated: false, reason: 'walk-failed', workDir: root };
  }
}
