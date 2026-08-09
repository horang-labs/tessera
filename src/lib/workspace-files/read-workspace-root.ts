import * as fs from 'node:fs/promises';
import { workspaceFileWatchManager } from './workspace-file-watch-manager';
import { walkWorkspaceFiles } from './workspace-file-scan';

export interface WorkspaceRootFiles {
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
      return { files: [], symlinks: [], truncated: false, reason: 'not-a-directory', workDir: root };
    }
  } catch {
    return { files: [], symlinks: [], truncated: false, reason: 'unreadable', workDir: root };
  }

  try {
    const result = await workspaceFileWatchManager.ensureSnapshotForRoot(root)
      ?? await walkWorkspaceFiles(root);
    return {
      files: result.files,
      symlinks: result.symlinks,
      truncated: result.truncated,
      workDir: root,
    };
  } catch {
    return { files: [], symlinks: [], truncated: false, reason: 'walk-failed', workDir: root };
  }
}
