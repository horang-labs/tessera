import * as fs from 'node:fs/promises';
import { workspaceFileWatchManager } from './workspace-file-watch-manager';
import { walkWorkspaceFiles } from './workspace-file-scan';

export interface WorkspaceRootFiles {
  directories: string[];
  files: string[];
  symlinks: string[];
  truncated: boolean;
  reason?: 'not-a-directory' | 'unreadable' | 'walk-failed';
  workDir: string;
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
