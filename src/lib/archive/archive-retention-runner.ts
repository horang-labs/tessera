import logger from '@/lib/logger';
import { pruneExpiredArchivedWorktrees, type RetentionResult } from './archive-service';

const ACTIVE_PASS_DELAY_MS = 30_000;
const IDLE_PASS_DELAY_MS = 5 * 60_000;

interface RetentionPolicy {
  retentionDays: number;
  userId: string;
}

interface RetentionRunnerState {
  policy: RetentionPolicy | null;
  timer: NodeJS.Timeout | null;
  running: Promise<RetentionResult> | null;
}

const GLOBAL_KEY = Symbol.for('tessera.archiveRetentionRunner');
const globalState = globalThis as unknown as { [GLOBAL_KEY]?: RetentionRunnerState };

function getState(): RetentionRunnerState {
  return globalState[GLOBAL_KEY]
    ?? (globalState[GLOBAL_KEY] = { policy: null, timer: null, running: null });
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

async function runOnePass(): Promise<RetentionResult> {
  const state = getState();
  if (state.running) return state.running;
  const policy = state.policy;
  if (!policy) return { removed: 0, skipped: 0, attempted: 0, errors: [] };

  const pass = pruneExpiredArchivedWorktrees(
    policy.retentionDays,
    policy.userId,
    { maxWorktreeAttempts: 1 },
  );
  state.running = pass;
  let attempted = 0;
  try {
    const result = await pass;
    attempted = result.attempted;
    if (result.errors.length > 0) {
      logger.warn({ errors: result.errors }, 'Archived Worktree retention pass had errors');
    }
    return result;
  } catch (error) {
    logger.warn({ error }, 'Archived Worktree retention pass failed');
    return { removed: 0, skipped: 0, attempted: 0, errors: [] };
  } finally {
    state.running = null;
    // A pass that touched a Worktree stays deliberately slow: wsl.exe can exit
    // while its Windows conhost teardown is still consuming CPU. An idle scan
    // backs off further so an empty archive is effectively free.
    armNextPass(attempted > 0 ? ACTIVE_PASS_DELAY_MS : IDLE_PASS_DELAY_MS);
  }
}

export function configureArchivedWorktreeRetention(
  policy: RetentionPolicy | null,
  options: { runImmediately?: boolean } = {},
): void {
  const state = getState();
  state.policy = policy;
  clearTimer(state);
  if (!policy) return;
  // A normal startup gets a long quiet window. Settings changes that the user
  // explicitly confirmed may request an immediate (still single-item) pass.
  armNextPass(options.runImmediately ? 0 : IDLE_PASS_DELAY_MS);
}

export function runArchivedWorktreeRetentionNow(): Promise<RetentionResult> {
  clearTimer(getState());
  return runOnePass();
}

export function stopArchivedWorktreeRetention(): void {
  const state = getState();
  state.policy = null;
  clearTimer(state);
}
