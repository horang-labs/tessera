import * as fs from 'fs';
import * as path from 'path';
import logger from '@/lib/logger';
import { resolvePathForHostFilesystem } from '@/lib/filesystem/host-path';
import { isLikelyBinary } from '@/lib/workspace-files/workspace-file-io';
import { createGitRunner, supportsGitShellBatch } from '@/lib/worktrees/git-runner';
import { buildGitBatchScript, parseGitBatchOutput, runGitQueryBatch } from '@/lib/worktrees/git-query-batch';
import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  WorktreeDiffStats,
  WorktreeFileDiffStats,
} from '@/types/worktree-diff-stats';

const UNTRACKED_MAX_BYTES = 512 * 1024;

// Line counting is a best-effort enhancement over Git's exact file counts.
// Bound the resource that actually causes load rather than changing behavior at
// an arbitrary file count: many tiny source files are cheap, while an unignored
// `.venv` or `node_modules` tree must not monopolize the server.
const UNTRACKED_LINECOUNT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const UNTRACKED_LINECOUNT_MAX_DURATION_MS = 1_500;
// Cap concurrent file reads so even a large-but-under-limit untracked set can't
// exhaust file descriptors.
const NEWLINE_COUNT_CONCURRENCY = 16;
// Enough for the entire visible Git list plus a second large worktree, while
// keeping path strings and filesystem identities in a fixed-size memory bound.
const UNTRACKED_LINECOUNT_CACHE_MAX_ENTRIES = 2_048;
const DIFF_STATS_BATCH_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface CachedUntrackedLineCount {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  count: number | null;
}

interface InFlightUntrackedLineCount extends CachedUntrackedLineCount {
  promise: Promise<number | null>;
}

interface UntrackedLineCountCacheState {
  entries: Map<string, CachedUntrackedLineCount>;
  inFlight: Map<string, InFlightUntrackedLineCount>;
}

const UNTRACKED_LINECOUNT_CACHE_KEY = Symbol.for('tessera.untrackedLineCountCache');
const cacheGlobal = globalThis as unknown as {
  [UNTRACKED_LINECOUNT_CACHE_KEY]?: UntrackedLineCountCacheState;
};

function getUntrackedLineCountCacheState(): UntrackedLineCountCacheState {
  if (!cacheGlobal[UNTRACKED_LINECOUNT_CACHE_KEY]) {
    cacheGlobal[UNTRACKED_LINECOUNT_CACHE_KEY] = {
      entries: new Map(),
      inFlight: new Map(),
    };
  }
  return cacheGlobal[UNTRACKED_LINECOUNT_CACHE_KEY]!;
}

interface DiffStatsGitBatchOutput {
  insideWorkTree: string | null;
  numstat: string | null;
  nameStatus: string | null;
  untracked: string | null;
}

const DIFF_STATS_COMMANDS = [
  { key: 'insideWorkTree', args: ['rev-parse', '--is-inside-work-tree'] },
  {
    key: 'numstat',
    args: ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD', '--'],
  },
  { key: 'nameStatus', args: ['diff', '--name-status', 'HEAD', '--'] },
  { key: 'untracked', args: ['ls-files', '--others', '--exclude-standard', '-z'] },
];

export function buildWorktreeDiffStatsBatchScript(): string {
  return buildGitBatchScript(DIFF_STATS_COMMANDS);
}

function diffStatsBatchOutput(
  results: ReturnType<typeof parseGitBatchOutput>,
): DiffStatsGitBatchOutput {
  const output = (key: string) => {
    const result = results.get(key);
    return result?.exitCode === 0 ? result.stdout : null;
  };
  return {
    insideWorkTree: output('insideWorkTree'),
    numstat: output('numstat'),
    nameStatus: output('nameStatus'),
    untracked: output('untracked'),
  };
}

export function parseWorktreeDiffStatsBatchOutput(raw: string): DiffStatsGitBatchOutput | null {
  try {
    return diffStatsBatchOutput(parseGitBatchOutput(raw, DIFF_STATS_COMMANDS));
  } catch {
    return null;
  }
}

async function collectDiffStatsGitBatch(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<DiffStatsGitBatchOutput | null> {
  try {
    return diffStatsBatchOutput(await runGitQueryBatch(
      DIFF_STATS_COMMANDS, workDir, agentEnvironment,
      { timeoutMs: 10_000, maxOutputBytes: DIFF_STATS_BATCH_MAX_OUTPUT_BYTES },
    ));
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

function sameFilesystemIdentity(
  value: Pick<CachedUntrackedLineCount, 'size' | 'mtimeMs' | 'ctimeMs'>,
  stat: fs.Stats,
): boolean {
  return value.size === stat.size
    && value.mtimeMs === stat.mtimeMs
    && value.ctimeMs === stat.ctimeMs;
}

function rememberUntrackedLineCount(
  filePath: string,
  stat: fs.Stats,
  count: number | null,
): number | null {
  const entries = getUntrackedLineCountCacheState().entries;
  entries.delete(filePath);
  entries.set(filePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    count,
  });
  while (entries.size > UNTRACKED_LINECOUNT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return count;
}

function readFileNewlineCount(filePath: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let count = 0;
    let sampledBytes = 0;
    let settled = false;
    const stream = fs.createReadStream(filePath);
    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (sampledBytes < 8_000) {
        const sample = buf.subarray(0, 8_000 - sampledBytes);
        sampledBytes += sample.byteLength;
        if (isLikelyBinary(sample)) {
          stream.destroy();
          finish(0);
          return;
        }
      }
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) count++;
      }
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => finish(count));
  });
}

async function countFileNewlinesCapped(
  filePath: string,
  reserveBytes: (bytes: number) => boolean,
): Promise<number | null> {
  const state = getUntrackedLineCountCacheState();
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    state.entries.delete(filePath);
    return null;
  }

  const cached = state.entries.get(filePath);
  if (cached && sameFilesystemIdentity(cached, stat)) {
    // Refresh insertion order so the bounded Map behaves as an LRU cache.
    state.entries.delete(filePath);
    state.entries.set(filePath, cached);
    return cached.count;
  }
  if (cached) state.entries.delete(filePath);

  const inFlight = state.inFlight.get(filePath);
  if (inFlight && sameFilesystemIdentity(inFlight, stat)) {
    return inFlight.promise;
  }

  if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES) {
    return rememberUntrackedLineCount(filePath, stat, null);
  }
  if (!reserveBytes(stat.size)) return null;

  const promise = readFileNewlineCount(filePath).then((count) => (
    count === null ? null : rememberUntrackedLineCount(filePath, stat, count)
  ));
  const pending: InFlightUntrackedLineCount = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    count: null,
    promise,
  };
  state.inFlight.set(filePath, pending);
  try {
    return await promise;
  } finally {
    if (state.inFlight.get(filePath) === pending) {
      state.inFlight.delete(filePath);
    }
  }
}

export interface UntrackedLineCountBudget {
  maxBytes: number;
  maxDurationMs: number;
}

export interface UntrackedLineCounts {
  byPath: Map<string, number>;
  incomplete: boolean;
}

/**
 * Count as many untracked-file lines as fit inside a real I/O budget.
 *
 * The old file-count cutoff made 1000 one-line files exact and 1001 identical
 * files contribute zero lines. A byte/time budget keeps inexpensive sets exact
 * regardless of file count while still bounding accidental dependency trees.
 */
export async function collectUntrackedLineCounts(
  resolvedWorkDir: string,
  untrackedPaths: readonly string[],
  budget: UntrackedLineCountBudget = {
    maxBytes: UNTRACKED_LINECOUNT_MAX_TOTAL_BYTES,
    maxDurationMs: UNTRACKED_LINECOUNT_MAX_DURATION_MS,
  },
): Promise<UntrackedLineCounts> {
  const pathModule = getPathModule(resolvedWorkDir);
  const deadline = Date.now() + Math.max(0, budget.maxDurationMs);
  let remainingBytes = Math.max(0, budget.maxBytes);
  let budgetExhausted = false;

  const results = await mapWithConcurrency(
    untrackedPaths,
    NEWLINE_COUNT_CONCURRENCY,
    async (relPath) => {
      if (budgetExhausted || Date.now() >= deadline) {
        budgetExhausted = true;
        return { relPath, count: null };
      }

      const count = await countFileNewlinesCapped(
        pathModule.join(resolvedWorkDir, relPath),
        (bytes) => {
          if (budgetExhausted || Date.now() >= deadline || bytes > remainingBytes) {
            budgetExhausted = true;
            return false;
          }
          remainingBytes -= bytes;
          return true;
        },
      );
      return { relPath, count };
    },
  );

  const byPath = new Map<string, number>();
  let incomplete = false;
  for (const { relPath, count } of results) {
    if (count === null) {
      incomplete = true;
    } else {
      byPath.set(relPath, count);
    }
  }
  return { byPath, incomplete };
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
  const stdout = await runGit(workDir, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--numstat',
    'HEAD',
    '--',
  ], agentEnvironment);
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
    let numstat: NumstatAggregate | null;
    let nameStatus: { deletedFiles: number } | null;
    let untracked: { paths: string[] } | null;

    if (supportsGitShellBatch(agentEnvironment)) {
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
    let addedLinesIncomplete = false;
    const removed = numstat.removed;
    let changedFiles = numstat.changedFiles;
    const deletedFiles = nameStatus.deletedFiles;

    const newFiles = untracked.paths.length;
    changedFiles += newFiles;
    const untrackedCounts = await collectUntrackedLineCounts(resolved, untracked.paths);
    for (const count of untrackedCounts.byPath.values()) added += count;
    addedLinesIncomplete = untrackedCounts.incomplete;

    return {
      added,
      ...(addedLinesIncomplete ? { addedLinesIncomplete: true } : {}),
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
  const files = new Map(numstat.files);
  const untrackedCounts = await collectUntrackedLineCounts(resolvedWorkDir, untrackedPaths);
  for (const [relPath, count] of untrackedCounts.byPath) {
    files.set(relPath, { added: count, removed: 0 });
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
