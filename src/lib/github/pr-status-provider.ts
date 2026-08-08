/**
 * Queries GitHub for the representative PR state of a given task branch.
 *
 * Uses `gh pr list --head <branch> --state all` scoped to the task's workDir.
 * Returns null when the branch has no PR. Returns { unsupported: true } when
 * the remote is not GitHub or the `gh` CLI is unavailable in this environment
 * — callers should mark the task accordingly so the UI stops asking for sync.
 */

import logger from '@/lib/logger';
import { createGitRunner, GitCommandError } from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { TaskPrStatus } from '@/types/task-pr-status';
import { createGhRunner } from './gh-cli';
import {
  parsePullRequestCandidates,
  selectRepresentativePullRequest,
  type HeadContainment,
} from './pr-status-selection';

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
    }
  | {
      kind: 'transient_error';
      stderr: string;
      resolvedBranch: string | null;
    };

const ghAvailableCache = new Map<AgentEnvironment, boolean>();

async function execGitInDir(
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const runGit = createGitRunner(agentEnvironment);
    const { stdout, stderr } = await runGit(['-C', cwd, ...args]);
    return { stdout, stderr };
  } catch {
    return null;
  }
}

async function execGhInDir(
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await createGhRunner(agentEnvironment)(args, { cwd });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function isGhCliAvailable(
  agentEnvironment: AgentEnvironment,
): Promise<boolean> {
  const cached = ghAvailableCache.get(agentEnvironment);
  if (cached !== undefined) return cached;

  try {
    const result = await createGhRunner(agentEnvironment)(['--version']);
    ghAvailableCache.set(agentEnvironment, result.exitCode === 0);
  } catch {
    ghAvailableCache.set(agentEnvironment, false);
  }
  return ghAvailableCache.get(agentEnvironment) ?? false;
}

/** Exposed for tests / dev: reset the gh detection cache. */
export function resetGhAvailabilityCache(): void {
  ghAvailableCache.clear();
}

/**
 * Resolve the worktree's current HEAD branch, or null if HEAD is detached
 * or git fails. Used by callers that don't have a stored branch (bare
 * sessions) but still want to drive `probeTaskPrStatus`.
 */
export async function resolveCurrentBranch(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<string | null> {
  if (!workDir) return null;
  const result = await execGitInDir(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    workDir,
    agentEnvironment,
  );
  const head = result?.stdout.trim();
  return head && head !== 'HEAD' ? head : null;
}

/**
 * `owner/repo` for a GitHub remote, null for anything else — which is also how
 * a caller asks "is this a GitHub repository at all".
 */
export function normalizeGithubOwnerRepo(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];
  return null;
}

async function compareHeadContainment(
  workDir: string,
  ownerRepo: string,
  currentHead: string,
  prHead: string,
  agentEnvironment: AgentEnvironment,
): Promise<HeadContainment> {
  const runGit = createGitRunner(agentEnvironment);
  try {
    await runGit(
      ['-C', workDir, 'merge-base', '--is-ancestor', currentHead, prHead],
      { timeoutMs: 10_000 },
    );
    return 'contains';
  } catch (error) {
    // `merge-base --is-ancestor` uses exit 1 for a proven negative. Missing
    // objects and actual Git failures use other codes and need the remote
    // fallback below.
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return 'not_contains';
    }
  }

  // Shallow clones and force-pushes may not retain the old PR head locally.
  // GitHub can still compare the two advertised commits. This is an edge-case
  // fallback, not another API request on the normal polling path.
  const compared = await execGhInDir(
    [
      'api',
      `repos/${ownerRepo}/compare/${currentHead}...${prHead}`,
      '--jq',
      '.status',
    ],
    workDir,
    agentEnvironment,
  );
  if (!compared.ok) return 'unknown';

  const status = compared.stdout.trim().toLowerCase();
  if (status === 'identical' || status === 'ahead') return 'contains';
  if (status === 'behind' || status === 'diverged') return 'not_contains';
  return 'unknown';
}

/**
 * Probe a task's GitHub PR state. Safe to call on any task — returns
 * "unsupported" when the environment cannot answer the question.
 */
export async function probeTaskPrStatus(params: {
  workDir: string;
  branch: string;
  agentEnvironment: AgentEnvironment;
}): Promise<PrProbeResult> {
  const { workDir, branch, agentEnvironment } = params;

  if (!workDir) return { kind: 'unsupported', reason: 'workdir_missing' };
  if (!branch) return { kind: 'unsupported', reason: 'branch_missing' };

  const isRepo = await execGitInDir(['rev-parse', '--is-inside-work-tree'], workDir, agentEnvironment);
  if (!isRepo || isRepo.stdout.trim() !== 'true') {
    return { kind: 'unsupported', reason: 'not_git_repo' };
  }

  const remote = await execGitInDir(['remote', 'get-url', 'origin'], workDir, agentEnvironment);
  const ownerRepo = normalizeGithubOwnerRepo(remote?.stdout ?? null);
  if (!remote) return { kind: 'unsupported', reason: 'no_origin' };
  if (!ownerRepo) return { kind: 'unsupported', reason: 'origin_not_github' };

  if (!(await isGhCliAvailable(agentEnvironment))) {
    return { kind: 'unsupported', reason: 'gh_missing' };
  }

  // Prefer the worktree's current HEAD branch over the DB-stored one. Users
  // often iterate with `git checkout -b <new>` after the initial task branch
  // is merged (e.g. follow-up bug fixes pushed to a fresh branch), so the
  // probe needs to track wherever HEAD actually points — matching the Git
  // panel's behavior. Falls back to the caller-provided `branch` when HEAD
  // is detached or we can't resolve it.
  const headBranchResult = await execGitInDir(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    workDir,
    agentEnvironment,
  );
  const headBranch = headBranchResult?.stdout.trim();
  const resolvedBranch =
    headBranch && headBranch !== 'HEAD' ? headBranch : null;
  const probeBranch = resolvedBranch ?? branch;

  const lsRemote = await execGitInDir(
    ['ls-remote', '--heads', 'origin', probeBranch],
    workDir,
    agentEnvironment,
  );
  if (!lsRemote) {
    return {
      kind: 'transient_error',
      stderr: 'Could not determine whether the remote branch exists',
      resolvedBranch,
    };
  }
  const remoteBranchExists = lsRemote.stdout.trim().length > 0;

  const run = await execGhInDir(
    [
      'pr', 'list',
      '--repo', ownerRepo,
      '--head', probeBranch,
      '--state', 'all',
      '--json', 'number,state,url,mergedAt,updatedAt,headRefName,headRefOid',
      '--limit', '100',
    ],
    workDir,
    agentEnvironment,
  );

  if (!run.ok) {
    const stderr = run.stderr.toLowerCase();
    if (stderr.includes('gh auth login') || stderr.includes('authentication token')) {
      return { kind: 'unsupported', reason: 'gh_unauthenticated' };
    }
    logger.warn({ branch: probeBranch, ownerRepo, stderr: run.stderr.slice(0, 300) }, 'gh pr list failed');
    // Transient failure (network blip, rate limit, subprocess hiccup). Surface
    // a distinct kind so callers can leave the previously-known PR state in the
    // DB instead of overwriting it with null and broadcasting "PR gone".
    return { kind: 'transient_error', stderr: run.stderr, resolvedBranch };
  }

  const parsed = parsePullRequestCandidates(run.stdout);
  if (!parsed.ok) {
    logger.warn(
      { branch: probeBranch, ownerRepo, error: parsed.error },
      'gh pr list returned an invalid payload',
    );
    return { kind: 'transient_error', stderr: parsed.error, resolvedBranch };
  }

  if (parsed.candidates.length === 0) {
    return { kind: 'ok', prStatus: null, remoteBranchExists, resolvedBranch };
  }

  const head = await execGitInDir(['rev-parse', 'HEAD'], workDir, agentEnvironment);
  const currentHead = head?.stdout.trim();
  const selected = await selectRepresentativePullRequest(
    parsed.candidates,
    currentHead && /^[0-9a-f]{40}$/i.test(currentHead) ? currentHead : null,
    (headSha, prHead) => compareHeadContainment(
      workDir,
      ownerRepo,
      headSha,
      prHead,
      agentEnvironment,
    ),
  );
  if (selected.kind === 'unknown') {
    logger.warn(
      { branch: probeBranch, ownerRepo, reason: selected.reason },
      'PR revision relationship is unknown',
    );
    return { kind: 'transient_error', stderr: selected.reason, resolvedBranch };
  }
  if (selected.kind === 'none') {
    return { kind: 'ok', prStatus: null, remoteBranchExists, resolvedBranch };
  }

  const prStatus: TaskPrStatus = {
    number: selected.candidate.number,
    url: selected.candidate.url,
    state: selected.candidate.state,
    relation: selected.relation,
    mergedAt: selected.candidate.mergedAt,
    lastSynced: new Date().toISOString(),
    headRefOid: selected.candidate.headRefOid,
  };

  return { kind: 'ok', prStatus, remoteBranchExists, resolvedBranch };
}
