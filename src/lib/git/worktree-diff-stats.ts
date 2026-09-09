import * as fs from 'fs';
import * as path from 'path';
import logger from '@/lib/logger';
import { resolvePathForHostFilesystem } from '@/lib/filesystem/host-path';
import { createGitRunner, createGitShellRunner } from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  WorktreeDiffStats,
  WorktreeFileDiffStats,
} from '@/types/worktree-diff-stats';

const UNTRACKED_MAX_BYTES = 512 * 1024;

// Beyond this many untracked files (e.g. an accidentally-unignored `.venv` or
// `node_modules`), skip the per-file line-count I/O entirely. Reading every file
// to count newlines would otherwise open thousands of descriptors at once and
// stall the event loop (or hit EMFILE). We still report the count of new files.
const UNTRACKED_LINECOUNT_MAX_FILES = 1000;
// Cap concurrent file reads so even a large-but-under-limit untracked set can't
// exhaust file descriptors.
const NEWLINE_COUNT_CONCURRENCY = 16;
const DIFF_STATS_BATCH_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface DiffStatsGitBatchOutput {
  insideWorkTree: string | null;
  numstat: string | null;
  nameStatus: string | null;
  untracked: string | null;
}

/**
 * Four Git reads behind one shell keeps a Windows-hosted WSL agent to one
 * wsl.exe/conhost lifecycle per worktree. Files are used between Git and
 * base64 because shell variables cannot preserve the NUL-delimited ls-files
 * output.
 */
export function buildWorktreeDiffStatsBatchScript(): string {
  return [
    'batch_dir=$(mktemp -d "${TMPDIR:-/tmp}/tessera-diff-stats.XXXXXX") || exit 70',
    'trap \'rm -rf -- "$batch_dir"\' EXIT HUP INT TERM',
    'run_git_probe() {',
    '  probe_key=$1',
    '  shift',
    '  probe_output="$batch_dir/$probe_key"',
    '  git "$@" >"$probe_output" 2>/dev/null',
    '  probe_status=$?',
    '  printf "%s\\t%s\\tb64:" "$probe_key" "$probe_status"',
    '  base64 <"$probe_output" | tr -d "\\r\\n"',
    '  printf "\\n"',
    '}',
    'run_git_probe insideWorkTree rev-parse --is-inside-work-tree',
    'run_git_probe numstat diff --numstat HEAD --',
    'run_git_probe nameStatus diff --name-status HEAD --',
    'run_git_probe untracked ls-files --others --exclude-standard -z',
  ].join('\n');
}

export function parseWorktreeDiffStatsBatchOutput(raw: string): DiffStatsGitBatchOutput | null {
  const outputs = new Map<string, string | null>();
  const expectedKeys = new Set(['insideWorkTree', 'numstat', 'nameStatus', 'untracked']);

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [key, statusRaw, encodedField, ...extra] = line.split('\t');
    if (
      extra.length > 0
      || !key
      || !expectedKeys.has(key)
      || outputs.has(key)
      || !/^\d+$/.test(statusRaw ?? '')
      || !encodedField?.startsWith('b64:')
    ) {
      return null;
    }
    const status = Number.parseInt(statusRaw, 10);
    outputs.set(
      key,
      status === 0
        ? Buffer.from(encodedField.slice(4), 'base64').toString('utf8').trimEnd()
        : null,
    );
  }

  if (outputs.size !== expectedKeys.size) return null;
  return {
    insideWorkTree: outputs.get('insideWorkTree') ?? null,
    numstat: outputs.get('numstat') ?? null,
    nameStatus: outputs.get('nameStatus') ?? null,
    untracked: outputs.get('untracked') ?? null,
  };
}

async function collectDiffStatsGitBatch(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<DiffStatsGitBatchOutput | null> {
  try {
    const runGitShell = createGitShellRunner(agentEnvironment, {
      timeoutMs: 10_000,
      maxOutputBytes: DIFF_STATS_BATCH_MAX_OUTPUT_BYTES,
    });
    const result = await runGitShell(buildWorktreeDiffStatsBatchScript(), { cwd: workDir });
    if (result.truncated) return null;
    return parseWorktreeDiffStatsBatchOutput(result.stdout);
  } catch {
    return null;
  }
}

// Map over items with a bounded number of in-flight async calls.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function runGit(
  workDir: string,
  args: string[],
  agentEnvironment: AgentEnvironment,
): Promise<string | null> {
  try {
    const runGitCommand = createGitRunner(agentEnvironment, { timeoutMs: 10_000 });
    const { stdout } = await runGitCommand(['-C', workDir, ...args]);
    return stdout;
  } catch {
    return null;
  }
}

async function isGitWorkTree(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<boolean> {
  const out = await runGit(workDir, ['rev-parse', '--is-inside-work-tree'], agentEnvironment);
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

function parseNumstat(stdout: string): NumstatAggregate {
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

async function collectNumstat(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<NumstatAggregate | null> {
  const stdout = await runGit(workDir, ['diff', '--numstat', 'HEAD', '--'], agentEnvironment);
  return stdout === null ? null : parseNumstat(stdout);
}

async function collectNameStatus(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<{ deletedFiles: number } | null> {
  const stdout = await runGit(workDir, ['diff', '--name-status', 'HEAD', '--'], agentEnvironment);
  return stdout === null ? null : parseNameStatus(stdout);
}

function parseNameStatus(stdout: string): { deletedFiles: number } {
  let deletedFiles = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    // Format: "<status>\t<path>" or "<status>\t<old>\t<new>" for R/C
    const status = line.charAt(0);
    if (status === 'D') deletedFiles += 1;
  }
  return { deletedFiles };
}

async function collectUntracked(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<{ paths: string[] } | null> {
  const stdout = await runGit(workDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ], agentEnvironment);
  if (stdout === null) return null;

  return { paths: parseUntrackedPaths(stdout) };
}

function parseUntrackedPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const entry of stdout.split('\0')) {
    if (entry) paths.push(entry);
  }
  return paths;
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
  agentEnvironment: AgentEnvironment,
): Promise<WorktreeDiffStats | null> {
  try {
    const resolved = await resolveFilesystemPath(workDir);
    const pathModule = getPathModule(resolved);
    let numstat: NumstatAggregate | null;
    let nameStatus: { deletedFiles: number } | null;
    let untracked: { paths: string[] } | null;

    if (agentEnvironment === 'wsl') {
      const batch = await collectDiffStatsGitBatch(resolved, agentEnvironment);
      if (!batch || batch.insideWorkTree?.trim() !== 'true') return null;
      numstat = batch.numstat === null ? null : parseNumstat(batch.numstat);
      nameStatus = batch.nameStatus === null ? null : parseNameStatus(batch.nameStatus);
      untracked = batch.untracked === null
        ? null
        : { paths: parseUntrackedPaths(batch.untracked) };
    } else {
      if (!(await isGitWorkTree(resolved, agentEnvironment))) return null;
      [numstat, nameStatus, untracked] = await Promise.all([
        collectNumstat(resolved, agentEnvironment),
        collectNameStatus(resolved, agentEnvironment),
        collectUntracked(resolved, agentEnvironment),
      ]);
    }

    if (!numstat || !nameStatus || !untracked) return null;

    let added = numstat.added;
    const removed = numstat.removed;
    let changedFiles = numstat.changedFiles;
    const deletedFiles = nameStatus.deletedFiles;

    let newFiles = 0;
    if (untracked.paths.length > UNTRACKED_LINECOUNT_MAX_FILES) {
      // Too many untracked files to read individually — count them without
      // folding their line totals into `added`.
      newFiles = untracked.paths.length;
      changedFiles += untracked.paths.length;
    } else {
      const untrackedCounts = await mapWithConcurrency(
        untracked.paths,
        NEWLINE_COUNT_CONCURRENCY,
        (relPath) => countFileNewlinesCapped(pathModule.join(resolved, relPath)),
      );
      for (const count of untrackedCounts) {
        newFiles += 1;
        changedFiles += 1;
        if (count !== null) {
          added += count;
        }
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
  agentEnvironment: AgentEnvironment,
): Promise<Map<string, WorktreeFileDiffStats> | null> {
  try {
    const resolved = await resolveFilesystemPath(workDir);
    if (!(await isGitWorkTree(resolved, agentEnvironment))) return null;

    const [numstat, untracked] = await Promise.all([
      collectNumstat(resolved, agentEnvironment),
      collectUntracked(resolved, agentEnvironment),
    ]);

    if (!numstat || !untracked) return null;

    return buildWorktreeFileDiffStats(resolved, numstat, untracked.paths);
  } catch (error) {
    logger.warn({ error, workDir }, 'computeWorktreeFileDiffStats failed');
    return null;
  }
}

/**
 * Build the per-file stats from outputs already collected by a batched git
 * probe. This lets Windows-hosted WSL callers keep the entire snapshot behind
 * one wsl.exe bridge instead of spawning more bridge processes for numstat and
 * untracked files.
 */
export async function computeWorktreeFileDiffStatsFromRaw(
  workDir: string,
  numstatRaw: string | null,
  untrackedRaw: string | null,
): Promise<Map<string, WorktreeFileDiffStats> | null> {
  if (numstatRaw === null || untrackedRaw === null) return null;

  try {
    const resolved = await resolveFilesystemPath(workDir);
    return buildWorktreeFileDiffStats(
      resolved,
      parseNumstat(numstatRaw),
      parseUntrackedPaths(untrackedRaw),
    );
  } catch (error) {
    logger.warn({ error, workDir }, 'computeWorktreeFileDiffStatsFromRaw failed');
    return null;
  }
}

async function buildWorktreeFileDiffStats(
  resolvedWorkDir: string,
  numstat: NumstatAggregate,
  untrackedPaths: string[],
): Promise<Map<string, WorktreeFileDiffStats>> {
  const pathModule = getPathModule(resolvedWorkDir);

  const files = new Map(numstat.files);
  if (untrackedPaths.length > UNTRACKED_LINECOUNT_MAX_FILES) {
    // Too many untracked files to read individually — record them with an
    // unknown (zero) added count rather than opening every file.
    for (const relPath of untrackedPaths) {
      files.set(relPath, { added: 0, removed: 0 });
    }
    return files;
  }

  const untrackedCounts = await mapWithConcurrency(
    untrackedPaths,
    NEWLINE_COUNT_CONCURRENCY,
    async (relPath) => ({
      relPath,
      count: await countFileNewlinesCapped(pathModule.join(resolvedWorkDir, relPath)),
    }),
  );

  for (const { relPath, count } of untrackedCounts) {
    files.set(relPath, { added: count ?? 0, removed: 0 });
  }

  return files;
}

async function resolveFilesystemPath(filesystemPath: string): Promise<string> {
  return resolvePathForHostFilesystem(filesystemPath);
}

function getPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) ? path.win32 : path.posix;
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}
