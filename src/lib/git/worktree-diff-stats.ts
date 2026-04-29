import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import logger from '@/lib/logger';
import type {
  WorktreeDiffStats,
  WorktreeFileDiffStats,
} from '@/types/worktree-diff-stats';

const execFileAsync = promisify(execFile);
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const UNTRACKED_MAX_BYTES = 512 * 1024;

async function runGit(workDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workDir,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}

async function isGitWorkTree(workDir: string): Promise<boolean> {
  const out = await runGit(workDir, ['rev-parse', '--is-inside-work-tree']);
  return out !== null && out.trim() === 'true';
}

async function countFileNewlinesCapped(filePath: string): Promise<number | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES) {
    return null;
  }

  return await new Promise<number | null>((resolve) => {
    let count = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) count++;
      }
    });
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(count));
  });
}

interface NumstatAggregate {
  added: number;
  removed: number;
  changedFiles: number;
  deletedFiles: number;
  files: Map<string, WorktreeFileDiffStats>;
}

async function collectNumstat(workDir: string): Promise<NumstatAggregate | null> {
  const stdout = await runGit(workDir, ['diff', '--numstat', 'HEAD', '--']);
  if (stdout === null) return null;

  let added = 0;
  let removed = 0;
  let changedFiles = 0;
  let deletedFiles = 0;
  const files = new Map<string, WorktreeFileDiffStats>();

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, remStr] = parts;
    const relPath = parts.slice(2).join('\t');

    // Binary files emit "-\t-\t<path>"; count them as changed but not line deltas.
    changedFiles += 1;
    let fileAdded = 0;
    let fileRemoved = 0;
    if (addStr !== '-') {
      const addNum = Number.parseInt(addStr, 10);
      if (Number.isFinite(addNum)) {
        added += addNum;
        fileAdded = addNum;
      }
    }
    if (remStr !== '-') {
      const remNum = Number.parseInt(remStr, 10);
      if (Number.isFinite(remNum)) {
        removed += remNum;
        fileRemoved = remNum;
      }
    }
    files.set(relPath, { added: fileAdded, removed: fileRemoved });

    // Detect deletion: deletions with zero additions on a path that no longer
    // exists. We use removal count against the working tree by checking
    // `git diff --name-status HEAD` later would be cleaner, but numstat already
    // gives us the line counts. We'll classify deletions via `name-status`.
  }

  return { added, removed, changedFiles, deletedFiles, files };
}

async function collectNameStatus(workDir: string): Promise<{ deletedFiles: number } | null> {
  const stdout = await runGit(workDir, ['diff', '--name-status', 'HEAD', '--']);
  if (stdout === null) return null;

  let deletedFiles = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    // Format: "<status>\t<path>" or "<status>\t<old>\t<new>" for R/C
    const status = line.charAt(0);
    if (status === 'D') deletedFiles += 1;
  }
  return { deletedFiles };
}

async function collectUntracked(workDir: string): Promise<{ paths: string[] } | null> {
  const stdout = await runGit(workDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (stdout === null) return null;

  const paths: string[] = [];
  for (const entry of stdout.split('\0')) {
    if (entry) paths.push(entry);
  }
  return { paths };
}

/**
 * Compute worktree diff stats for the given absolute work directory.
 *
 * Baseline: uncommitted delta vs HEAD. Untracked (new) file lines are read
 * directly and folded into `added`, so creating a 500-line file shows as +500.
 *
 * Returns `null` when the path is not a git worktree, is missing, or git
 * invocation fails.
 */
export async function computeWorktreeDiffStats(
  workDir: string,
): Promise<WorktreeDiffStats | null> {
  try {
    const resolved = path.resolve(workDir);
    if (!(await isGitWorkTree(resolved))) return null;

    const [numstat, nameStatus, untracked] = await Promise.all([
      collectNumstat(resolved),
      collectNameStatus(resolved),
      collectUntracked(resolved),
    ]);

    if (!numstat || !nameStatus || !untracked) return null;

    let added = numstat.added;
    const removed = numstat.removed;
    let changedFiles = numstat.changedFiles;
    const deletedFiles = nameStatus.deletedFiles;

    const untrackedCounts = await Promise.all(
      untracked.paths.map((relPath) =>
        countFileNewlinesCapped(path.join(resolved, relPath)),
      ),
    );

    let newFiles = 0;
    for (const count of untrackedCounts) {
      newFiles += 1;
      changedFiles += 1;
      if (count !== null) {
        added += count;
      }
    }

    return {
      added,
      removed,
      changedFiles,
      newFiles,
      deletedFiles,
      computedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn({ error, workDir }, 'computeWorktreeDiffStats failed');
    return null;
  }
}

export async function computeWorktreeFileDiffStats(
  workDir: string,
): Promise<Map<string, WorktreeFileDiffStats> | null> {
  try {
    const resolved = path.resolve(workDir);
    if (!(await isGitWorkTree(resolved))) return null;

    const [numstat, untracked] = await Promise.all([
      collectNumstat(resolved),
      collectUntracked(resolved),
    ]);

    if (!numstat || !untracked) return null;

    const files = new Map(numstat.files);
    const untrackedCounts = await Promise.all(
      untracked.paths.map(async (relPath) => ({
        relPath,
        count: await countFileNewlinesCapped(path.join(resolved, relPath)),
      })),
    );

    for (const { relPath, count } of untrackedCounts) {
      files.set(relPath, { added: count ?? 0, removed: 0 });
    }

    return files;
  } catch (error) {
    logger.warn({ error, workDir }, 'computeWorktreeFileDiffStats failed');
    return null;
  }
}
