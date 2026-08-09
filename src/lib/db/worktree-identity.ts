import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWslDisplayPathAgainstWindowsHostedPath } from '@/lib/filesystem/path-environment';

export interface CanonicalWorktreePath {
  filesystemPath: string;
  canonicalPathKey: string;
}

export function generatePublicWorktreeId(): string {
  return `wt_${randomUUID().replaceAll('-', '')}`;
}

export function canonicalizeWorktreePath(
  filesystemPath: string,
  referenceFilesystemPath?: string,
): CanonicalWorktreePath | null {
  const reportedPath = filesystemPath.trim();
  const trimmed = referenceFilesystemPath
    ? resolveWslDisplayPathAgainstWindowsHostedPath(
        reportedPath,
        referenceFilesystemPath,
      ) ?? reportedPath
    : reportedPath;
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
  const directories = resolveWorktreeGitDirectories(filesystemPath);
  if (!directories) return null;
  try {
    const pathModule = isWindowsStylePath(directories.gitDir) ? path.win32 : path;
    const head = fs.readFileSync(pathModule.join(directories.gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : null;
  } catch {
    return null;
  }
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function resolveGitPointerPath(filesystemPath: string, pointerPath: string): string {
  if (pointerPath.startsWith('/')) {
    const bridgedPath = resolveWslDisplayPathAgainstWindowsHostedPath(
      pointerPath,
      filesystemPath,
    );
    if (bridgedPath) return bridgedPath;
  }
  const pathModule = isWindowsStylePath(filesystemPath) ? path.win32 : path;
  return pathModule.resolve(filesystemPath, pointerPath);
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
      gitDir = resolveGitPointerPath(identity.filesystemPath, match[1]);
    }
    const pathModule = isWindowsStylePath(gitDir) ? path.win32 : path;
    const commonDirPath = pathModule.join(gitDir, 'commondir');
    const commonGitDir = fs.existsSync(commonDirPath)
      ? pathModule.resolve(gitDir, fs.readFileSync(commonDirPath, 'utf8').trim())
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
): { previousBranch: string; currentBranch: string; eventId: string } | undefined {
  const directories = resolveWorktreeGitDirectories(filesystemPath);
  if (!directories) return undefined;
  const pathModule = isWindowsStylePath(directories.commonGitDir) ? path.win32 : path;
  const branchParts = currentBranch.split('/');
  if (branchParts.some((part) => !part || part === '.' || part === '..')) return undefined;
  const reflogPath = pathModule.join(
    directories.commonGitDir,
    'logs',
    'refs',
    'heads',
    ...currentBranch.split('/'),
  );
  try {
    const renamePrefix = 'Branch: renamed refs/heads/';
    const separator = ' to refs/heads/';
    const lines = fs.readFileSync(reflogPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const objectId = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
    const reflogHeader = new RegExp(
      `^${objectId} ${objectId} .+ <[^>]*> \\d+ [+-]\\d{4}$`,
    );
    if (lines.some((line) => {
      const tabIndex = line.indexOf('\t');
      return tabIndex <= 0 || !reflogHeader.test(line.slice(0, tabIndex));
    })) return undefined;
    const entries = lines.map((line) => ({
      line,
      message: line.slice(line.indexOf('\t') + 1),
    }));
    const messages = entries.map(({ message }) => message);
    const hasCompleteStart = messages[0]?.startsWith('commit (initial):')
      || messages[0]?.startsWith('branch: Created from ')
      || messages[0]?.startsWith('clone: from ');
    if (!hasCompleteStart) return undefined;
    const renameEntries = entries.filter(({ message }) => message.startsWith(renamePrefix));
    if (renameEntries.length !== 1) return undefined;
    const names = renameEntries[0].message.slice(renamePrefix.length).split(separator);
    const rename = names.length === 2 && names[0] && names[1]
      ? {
          previousBranch: names[0],
          currentBranch: names[1],
          eventId: createHash('sha256').update(renameEntries[0].line).digest('hex').slice(0, 16),
        }
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
