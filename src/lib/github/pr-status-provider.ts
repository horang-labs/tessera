/**
 * Queries GitHub for the latest PR state of a given task branch.
 *
 * Uses `gh pr list --head <branch> --state all` scoped to the task's workDir.
 * Returns null when the branch has no PR. Returns { unsupported: true } when
 * the remote is not GitHub or the `gh` CLI is unavailable in this environment
 * — callers should mark the task accordingly so the UI stops asking for sync.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '@/lib/logger';
import type { TaskPrState, TaskPrStatus } from '@/types/task-pr-status';

const execFileAsync = promisify(execFile);
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

type ProbeUnsupportedReason =
  | 'workdir_missing'
  | 'branch_missing'
  | 'not_git_repo'
  | 'no_origin'
  | 'origin_not_github'
  | 'gh_missing'
  | 'gh_unauthenticated';

export type PrProbeResult =
  | { kind: 'unsupported'; reason: ProbeUnsupportedReason }
  | {
      kind: 'ok';
      prStatus: TaskPrStatus | null;
      remoteBranchExists: boolean;
      /**
       * Current HEAD branch of the worktree at probe time. Callers can use
       * this to keep `tasks.worktree_branch` in sync with reality. `null`
       * when HEAD is detached or unresolvable.
       */
      resolvedBranch: string | null;
    };

let ghAvailableCache: boolean | null = null;

async function execInDir(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { stdout, stderr };
  } catch (err: any) {
    return null;
  }
}

async function execInDirCapturingStderr(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    const stdout = String(err?.stdout ?? '');
    const stderr = String(err?.stderr ?? err?.message ?? '');
    return { ok: false, stdout, stderr };
  }
}

export async function isGhCliAvailable(): Promise<boolean> {
  if (ghAvailableCache !== null) return ghAvailableCache;
  try {
    await execFileAsync('gh', ['--version'], { encoding: 'utf8' });
    ghAvailableCache = true;
  } catch {
    ghAvailableCache = false;
  }
  return ghAvailableCache;
}

/** Exposed for tests / dev: reset the gh detection cache. */
export function resetGhAvailabilityCache(): void {
  ghAvailableCache = null;
}

function normalizeGithubOwnerRepo(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];
  return null;
}

function mapGithubStateToTaskPrState(
  rawState: string,
  mergedAt: string | null,
): TaskPrState {
  const state = rawState.toUpperCase();
  if (state === 'MERGED' || mergedAt) return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

interface GhPrListItem {
  number: number;
  state: string;
  url: string;
  mergedAt: string | null;
  updatedAt?: string;
  headRefName?: string;
  headRefOid?: string;
}

/**
 * Probe a task's GitHub PR state. Safe to call on any task — returns
 * "unsupported" when the environment cannot answer the question.
 */
export async function probeTaskPrStatus(params: {
  workDir: string;
  branch: string;
}): Promise<PrProbeResult> {
  const { workDir, branch } = params;

  if (!workDir) return { kind: 'unsupported', reason: 'workdir_missing' };
  if (!branch) return { kind: 'unsupported', reason: 'branch_missing' };

  const isRepo = await execInDir('git', ['rev-parse', '--is-inside-work-tree'], workDir);
  if (!isRepo || isRepo.stdout.trim() !== 'true') {
    return { kind: 'unsupported', reason: 'not_git_repo' };
  }

  const remote = await execInDir('git', ['remote', 'get-url', 'origin'], workDir);
  const ownerRepo = normalizeGithubOwnerRepo(remote?.stdout ?? null);
  if (!remote) return { kind: 'unsupported', reason: 'no_origin' };
  if (!ownerRepo) return { kind: 'unsupported', reason: 'origin_not_github' };

  if (!(await isGhCliAvailable())) {
    return { kind: 'unsupported', reason: 'gh_missing' };
  }

  // Prefer the worktree's current HEAD branch over the DB-stored one. Users
  // often iterate with `git checkout -b <new>` after the initial task branch
  // is merged (e.g. follow-up bug fixes pushed to a fresh branch), so the
  // probe needs to track wherever HEAD actually points — matching the Git
  // panel's behavior. Falls back to the caller-provided `branch` when HEAD
  // is detached or we can't resolve it.
  const headBranchResult = await execInDir(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    workDir,
  );
  const headBranch = headBranchResult?.stdout.trim();
  const resolvedBranch =
    headBranch && headBranch !== 'HEAD' ? headBranch : null;
  const probeBranch = resolvedBranch ?? branch;

  const lsRemote = await execInDir(
    'git',
    ['ls-remote', '--heads', 'origin', probeBranch],
    workDir,
  );
  const remoteBranchExists = !!lsRemote && lsRemote.stdout.trim().length > 0;

  const run = await execInDirCapturingStderr(
    'gh',
    [
      'pr', 'list',
      '--repo', ownerRepo,
      '--head', probeBranch,
      '--state', 'all',
      '--json', 'number,state,url,mergedAt,updatedAt,headRefName,headRefOid',
      '--limit', '5',
    ],
    workDir,
  );

  if (!run.ok) {
    const stderr = run.stderr.toLowerCase();
    if (stderr.includes('gh auth login') || stderr.includes('authentication token')) {
      return { kind: 'unsupported', reason: 'gh_unauthenticated' };
    }
    logger.warn({ branch: probeBranch, ownerRepo, stderr: run.stderr.slice(0, 300) }, 'gh pr list failed');
    // Transient failure — don't mark unsupported, just report no update.
    return { kind: 'ok', prStatus: null, remoteBranchExists, resolvedBranch };
  }

  let payload: GhPrListItem[] = [];
  try {
    payload = JSON.parse(run.stdout) as GhPrListItem[];
  } catch {
    return { kind: 'ok', prStatus: null, remoteBranchExists, resolvedBranch };
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return { kind: 'ok', prStatus: null, remoteBranchExists, resolvedBranch };
  }

  // Pick the most recently updated PR for this branch (gh already orders
  // newest-first, but we double-sort for safety).
  const sorted = [...payload].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return tb - ta;
  });
  const top = sorted[0];
  const mappedState = mapGithubStateToTaskPrState(top.state, top.mergedAt ?? null);

  const prStatus: TaskPrStatus = {
    number: top.number,
    url: top.url,
    state: mappedState,
    mergedAt: top.mergedAt ?? undefined,
    lastSynced: new Date().toISOString(),
    headRefOid: top.headRefOid ?? undefined,
  };

  return { kind: 'ok', prStatus, remoteBranchExists, resolvedBranch };
}
