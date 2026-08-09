import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CanonicalWorktreePath {
  filesystemPath: string;
  canonicalPathKey: string;
}

export function generatePublicWorktreeId(): string {
  return `wt_${randomUUID().replaceAll('-', '')}`;
}

export function canonicalizeWorktreePath(
  filesystemPath: string,
): CanonicalWorktreePath | null {
  const trimmed = filesystemPath.trim();
  if (!trimmed) return null;
  const pathModule = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
    ? path.win32
    : path;
  let resolved = pathModule.resolve(trimmed);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A pending or externally missing checkout retains a stable normalized key.
  }
  const normalized = pathModule.normalize(resolved);
  return {
    filesystemPath: normalized,
    canonicalPathKey: pathModule === path.win32 ? normalized.toLowerCase() : normalized,
  };
}

export function isGitCheckoutPath(filesystemPath: string): boolean {
  const identity = canonicalizeWorktreePath(filesystemPath);
  return Boolean(identity && fs.existsSync(path.join(identity.filesystemPath, '.git')));
}

export function readWorktreeCurrentBranch(filesystemPath: string): string | null {
  const identity = canonicalizeWorktreePath(filesystemPath);
  if (!identity) return null;
  const dotGitPath = path.join(identity.filesystemPath, '.git');
  let gitDir = dotGitPath;
  try {
    if (fs.statSync(dotGitPath).isFile()) {
      const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      gitDir = path.resolve(identity.filesystemPath, match[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : null;
  } catch {
    return null;
  }
}

function resolveWorktreeGitDirectories(filesystemPath: string): {
  gitDir: string;
  commonGitDir: string;
} | null {
  const identity = canonicalizeWorktreePath(filesystemPath);
  if (!identity) return null;
  const dotGitPath = path.join(identity.filesystemPath, '.git');
  try {
    let gitDir = dotGitPath;
    if (fs.statSync(dotGitPath).isFile()) {
      const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      gitDir = path.resolve(identity.filesystemPath, match[1]);
    }
    const commonDirPath = path.join(gitDir, 'commondir');
    const commonGitDir = fs.existsSync(commonDirPath)
      ? path.resolve(gitDir, fs.readFileSync(commonDirPath, 'utf8').trim())
      : gitDir;
    return { gitDir, commonGitDir };
  } catch {
    return null;
  }
}

/**
 * Read the exact rename recorded in the current local branch reflog.
 *
 * A renamed ref carries its previous reflog forward, so two consecutive branch
 * renames produce two rename records in the current log. Requiring exactly one
 * record deliberately rejects that multi-hop history as well as malformed or
 * unavailable logs. This is an explanatory hint only, never a migration seam.
 */
export function readExactOneHopBranchRename(
  filesystemPath: string,
  currentBranch: string,
): { previousBranch: string; currentBranch: string } | undefined {
  const directories = resolveWorktreeGitDirectories(filesystemPath);
  if (!directories) return undefined;
  const reflogPath = path.join(
    directories.commonGitDir,
    'logs',
    'refs',
    'heads',
    ...currentBranch.split('/'),
  );
  try {
    const renamePrefix = 'Branch: renamed refs/heads/';
    const separator = ' to refs/heads/';
    const renameMessages = fs.readFileSync(reflogPath, 'utf8')
      .split('\n')
      .map((line) => line.slice(line.indexOf('\t') + 1))
      .filter((message) => message.startsWith(renamePrefix));
    if (renameMessages.length !== 1) return undefined;
    const names = renameMessages[0].slice(renamePrefix.length).split(separator);
    const rename = names.length === 2 && names[0] && names[1]
      ? { previousBranch: names[0], currentBranch: names[1] }
      : undefined;
    return rename?.currentBranch === currentBranch
      ? rename
      : undefined;
  } catch {
    return undefined;
  }
}

/** Temporary compatibility policy for parents that have not stored a path yet. */
export const LEGACY_WORKTREE_PATH_FROM_CHILD_SQL = `(
  SELECT s.work_dir
  FROM sessions s
  WHERE s.task_id = tasks.id
    AND s.deleted = 0
    AND s.work_dir IS NOT NULL
    AND TRIM(s.work_dir) <> ''
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT 1
)`;

/** Parent-owned checkout path, with a temporary fallback for incomplete migrations. */
export const PARENT_FIRST_WORKTREE_PATH_SQL = `CASE
  WHEN tasks.worktree_path IS NOT NULL AND TRIM(tasks.worktree_path) <> ''
    THEN tasks.worktree_path
  ELSE ${LEGACY_WORKTREE_PATH_FROM_CHILD_SQL}
END`;

export function resolveEffectiveWorktreeCheckout(checkout: {
  worktree_path: string | null;
  worktree_branch: string | null;
} | undefined): { path: string | undefined; branch: string | undefined } {
  return {
    path: checkout?.worktree_path && checkout.worktree_path.trim() !== ''
      ? checkout.worktree_path
      : undefined,
    branch: checkout?.worktree_branch && checkout.worktree_branch.trim() !== ''
      ? checkout.worktree_branch
      : undefined,
  };
}
