import logger from '@/lib/logger';
import {
  listExpiredArchivedWorktreeCandidates,
  pruneExpiredArchivedWorktrees,
  type RetentionResult,
} from './archive-service';
import type { ArchiveRetentionProgress } from './retention-progress';

const ACTIVE_PASS_DELAY_MS = 30_000;
// Give startup work a short head start, then begin retention without making
// a backlog look stalled in the Archive progress indicator.
const IDLE_PASS_DELAY_MS = 60_000;

interface RetentionPolicy {
  retentionDays: number;
  userId: string;
}

type Candidate = Awaited<ReturnType<typeof listExpiredArchivedWorktreeCandidates>>[number];
interface RetentionCycle {
  candidates: Candidate[];
  progress: ArchiveRetentionProgress;
}
interface RetentionRunnerState {
  policy: RetentionPolicy | null;
  timer: NodeJS.Timeout | null;
  running: Promise<RetentionResult> | null;
  cycle: RetentionCycle | null;
  progress: ArchiveRetentionProgress;
  ownerId: string | null;
  generation: number;
  configuredDelay: number;
}

const GLOBAL_KEY = Symbol.for('tessera.archiveRetentionRunner');
const globalState = globalThis as unknown as { [GLOBAL_KEY]?: RetentionRunnerState };

function idleProgress(): ArchiveRetentionProgress {
  return {
    phase: 'idle', total: 0, completed: 0, removed: 0, skipped: 0,
    errors: [], currentTitle: null, startedAt: null, finishedAt: null,
  };
}
function emptyResult(): RetentionResult {
  return { removed: 0, skipped: 0, attempted: 0, errors: [] };
}
function getState(): RetentionRunnerState {
  const state = globalState[GLOBAL_KEY] ?? (globalState[GLOBAL_KEY] = {
    policy: null, timer: null, running: null, cycle: null, progress: idleProgress(),
    ownerId: null, generation: 0, configuredDelay: IDLE_PASS_DELAY_MS,
  });
  // Preserve the timer when a development hot reload upgrades the old runner state.
  state.progress ??= idleProgress();
  state.cycle ??= null;
  state.ownerId ??= state.policy?.userId ?? null;
  state.generation ??= 0;
  state.configuredDelay ??= IDLE_PASS_DELAY_MS;
  return state;
}

function clearTimer(state: RetentionRunnerState): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}
function armNextPass(delayMs: number): void {
  const state = getState();
  clearTimer(state);
  if (!state.policy) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void runOnePass();
  }, delayMs);
  state.timer.unref?.();
}

async function executePass(state: RetentionRunnerState, policy: RetentionPolicy, generation: number): Promise<RetentionResult> {
  if (generation !== state.generation) return emptyResult();
  if (!state.cycle) {
    const previous = state.progress;
    state.progress = { ...idleProgress(), phase: 'scanning' };
    const candidates = await listExpiredArchivedWorktreeCandidates(policy.retentionDays);
    if (generation !== state.generation) return emptyResult();
    if (candidates.length === 0) {
      state.progress = previous.phase === 'complete' ? previous : idleProgress();
      return emptyResult();
    }
    const progress: ArchiveRetentionProgress = {
      ...idleProgress(), phase: 'running', total: candidates.length,
      startedAt: new Date().toISOString(),
    };
    state.cycle = { candidates, progress };
    state.progress = progress;
  }
  const cycle = state.cycle;
  const item = cycle.candidates[cycle.progress.completed];
  cycle.progress.phase = 'running';
  cycle.progress.currentTitle = item.title;
  let result: RetentionResult;
  try {
    // Revalidate archive/checkout state at every destructive edge; the snapshot
    // is only a queue, never permission to remove a restored or missing folder.
    result = await pruneExpiredArchivedWorktrees(policy.retentionDays, policy.userId, {
      maxWorktreeAttempts: 1,
      worktreeIds: new Set([item.worktreeId]),
    });
  } catch (error) {
    result = { ...emptyResult(), errors: [{ id: item.id, kind: item.kind,
      error: error instanceof Error ? error.message : String(error) }] };
  }
  if (generation !== state.generation) return result;
  cycle.progress.completed += 1;
  cycle.progress.removed += result.removed;
  if (result.removed === 0 && result.errors.length === 0) cycle.progress.skipped += 1;
  cycle.progress.errors.push(...result.errors.map((error) => ({ ...error, title: item.title })));
  cycle.progress.currentTitle = null;
  if (cycle.progress.completed === cycle.progress.total) {
    cycle.progress.phase = 'complete';
    cycle.progress.finishedAt = new Date().toISOString();
    state.cycle = null;
  } else {
    cycle.progress.phase = 'waiting';
  }
  if (result.errors.length) logger.warn({ errors: result.errors }, 'Archived Worktree retention pass had errors');
  return result;
}

async function runOnePass(): Promise<RetentionResult> {
  const state = getState();
  if (state.running) return state.running.catch(() => emptyResult());
  const policy = state.policy;
  if (!policy) return emptyResult();
  const generation = state.generation;
  // Defer execution until the running promise is installed, including synchronous failures.
  const pass = Promise.resolve().then(() => executePass(state, policy, generation));
  state.running = pass;
  try {
    return await pass;
  } catch (error) {
    logger.warn({ error }, 'Archived Worktree retention pass failed');
    if (generation === state.generation) {
      state.progress = {
        ...idleProgress(), phase: 'complete', finishedAt: new Date().toISOString(),
        errors: [{ id: 'scan', kind: 'task', error: error instanceof Error ? error.message : String(error) }],
      };
      state.cycle = null;
    }
    return emptyResult();
  } finally {
    state.running = null;
    // Keep the existing Windows/WSL cooldown between folders; idle scans back off.
    armNextPass(generation !== state.generation ? state.configuredDelay
      : state.cycle ? ACTIVE_PASS_DELAY_MS : IDLE_PASS_DELAY_MS);
  }
}

export function getArchivedWorktreeRetentionProgress(userId: string): ArchiveRetentionProgress {
  const state = getState();
  if (state.ownerId !== userId) return idleProgress();
  return { ...state.progress, errors: state.progress.errors.map((error) => ({ ...error })) };
}

export function configureArchivedWorktreeRetention(
  policy: RetentionPolicy | null,
  options: { runImmediately?: boolean } = {},
): void {
  const state = getState();
  const changed = state.policy?.userId !== policy?.userId
    || state.policy?.retentionDays !== policy?.retentionDays;
  state.policy = policy;
  if (!changed && !options.runImmediately && (state.timer || state.running)) return;
  clearTimer(state);
  state.configuredDelay = options.runImmediately ? 0 : IDLE_PASS_DELAY_MS;
  if (changed) {
    state.generation += 1;
    state.cycle = null;
    state.progress = idleProgress();
    state.ownerId = policy?.userId ?? null;
  }
  if (!policy) return;
  // Reapplying unrelated settings must not reset an active cycle's progress/cooldown.
  armNextPass(state.cycle ? ACTIVE_PASS_DELAY_MS : state.configuredDelay);
}

export function runArchivedWorktreeRetentionNow(): Promise<RetentionResult> {
  clearTimer(getState());
  return runOnePass();
}
export function stopArchivedWorktreeRetention(): void {
  configureArchivedWorktreeRetention(null);
}
