/**
 * Keeping `refs/remotes/*` warm while a Git panel is open (#239).
 *
 * A panel read is otherwise entirely local: it asks Git what the refs already
 * say, and nothing moves them. So a branch that fell behind on the remote was
 * invisible — not stale, *unknown* — until the user ran `git fetch` by hand,
 * and the Pull rung (#235) was unreachable in ordinary use.
 *
 * The fetch therefore rides on the panel read, which is the signal that someone
 * is looking, and is rate-limited so that riding on a 5s poll does not mean
 * fetching every 5s.
 */

import logger from "@/lib/logger";
import { fetchGitRemote, getGitCommonDir } from "./git-panel";
import { scheduleGitPanelRecompute } from "./git-panel-cache";

/**
 * How long a repository's remote refs are treated as fresh enough.
 *
 * **Two minutes**, chosen between the two reference products that do this at
 * all — Orca does not, which is why its ahead/behind is only as fresh as the
 * user's last manual fetch:
 *
 * - t3code: 30s, per repository, but **user-configurable and switchable off**,
 *   and its settings copy says why the knob exists — a fetch on a timer can make
 *   Git credentials or a security key prompt on a timer too
 *   (`SourceControlSettings.tsx:396`).
 * - Paseo: 180s, per repository, fixed, with no way to change it.
 *
 * Tessera has no setting for this in v1, so a fixed value has to be defensible
 * without one, which rules out t3code's 30s. Against Paseo's 180s: this is what
 * bounds how long a branch can be behind before the panel says so — with the
 * panel open and untouched, the Pull rung appears within this interval plus one
 * poll (~2m05s) — and three minutes is long enough that a user waiting on a
 * colleague's push reaches for a terminal instead, which is the feature failing.
 *
 * Tessera's PR poller sits at 60s (`task-pr-poller.ts`), but it runs only for
 * tasks with an open pull request; this runs for any open panel.
 *
 * `TESSERA_GIT_REMOTE_REFRESH_INTERVAL_MS` overrides it, for tests that cannot
 * wait two minutes to observe the behaviour.
 */
const DEFAULT_REMOTE_REFRESH_INTERVAL_MS = 120_000;

export const GIT_REMOTE_REFRESH_INTERVAL_MS = (() => {
  const raw = process.env.TESSERA_GIT_REMOTE_REFRESH_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REMOTE_REFRESH_INTERVAL_MS;
})();

export interface GitRemoteRefreshRequest {
  /** Whose panel to recompute once the refs have moved. */
  sessionId: string;
  workDir: string;
  userId: string;
}

export interface GitRemoteRefreshDeps {
  /**
   * What the rate limit is keyed by — see `resolveRefsKeyCached` below. Null
   * when Git could not say, which is not cached: the answer is a property of
   * the working directory and does not change, so a momentary failure to read
   * it must not decide the key for the rest of the process's life.
   */
  resolveRefsKey: (workDir: string, userId: string) => Promise<string | null>;
  runFetch: (workDir: string, userId: string) => Promise<void>;
  /** Called only after a fetch that landed. */
  onFetched: (sessionId: string, userId: string) => void;
  now: () => number;
}

interface RefreshState {
  /** When the last attempt *finished*, per set of refs. */
  lastAttemptAt: Map<string, number>;
  inFlight: Map<string, Promise<void>>;
  /** A working directory's Git directory never changes; learn it once. */
  refsKeyByWorkDir: Map<string, string>;
}

const GLOBAL_KEY = Symbol.for("tessera.gitRemoteRefresh");
const g = globalThis as unknown as { [GLOBAL_KEY]?: RefreshState };

function getState(): RefreshState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      lastAttemptAt: new Map(),
      inFlight: new Map(),
      refsKeyByWorkDir: new Map(),
    };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * What one fetch covers: the Git directory the refs live in, not the working
 * directory and not the session.
 *
 * Not the session, because several sessions can share one checkout
 * (`docs/design/git-delivery.md` §5). Not the working directory either, because
 * every managed worktree of a repository shares that repository's
 * `refs/remotes/*` — and Tessera's normal shape is many worktrees of one
 * repository, so keying per working directory would turn one repository's
 * interval into one fetch per open panel. t3code fetches against the common Git
 * directory for the same reason (`GitVcsDriverCore.ts:1000`).
 *
 * Separate clones of the same upstream have separate Git directories and are
 * correctly kept apart: their refs really are independent, and deduping them
 * would leave one of the two permanently stale.
 */
async function resolveRefsKeyCached(
  workDir: string,
  userId: string,
  deps: GitRemoteRefreshDeps,
): Promise<string> {
  const state = getState();
  const cached = state.refsKeyByWorkDir.get(workDir);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  try {
    resolved = await deps.resolveRefsKey(workDir, userId);
  } catch (error) {
    // Naming the refs is itself a Git command, and `runOptionalGitCommand`
    // deliberately rethrows a timeout rather than degrading it to null — a
    // stalled mount or a cold bridge throws here. Answering with the working
    // directory keeps this function total, which is what lets the caller reach
    // the block that consumes the interval: a throw from here would escape
    // before anything was recorded, and the next poll five seconds later would
    // spawn the same hanging command.
    logger.debug(
      { error, workDir },
      "Could not name the Git directory for the panel's remote refresh",
    );
  }

  // Falling back to the working directory costs an extra fetch per worktree of
  // the repository, which the interval already bounds. It is never a wrong
  // answer, only a less shared one. Not cached, so a momentary failure does not
  // decide the key for the rest of the process's life.
  if (resolved === null) return workDir;

  state.refsKeyByWorkDir.set(workDir, resolved);
  return resolved;
}

const defaultDeps: GitRemoteRefreshDeps = {
  // `{ userId }` rather than an omitted argument: a panel read always has a
  // user, and ADR 0006 wants that said here rather than defaulted out of sight.
  resolveRefsKey: (workDir, userId) => getGitCommonDir(workDir, { userId }),
  runFetch: (workDir, userId) => fetchGitRemote(workDir, { userId }),
  onFetched: (sessionId, userId) => scheduleGitPanelRecompute(sessionId, userId),
  now: () => Date.now(),
};

/**
 * Refresh this working directory's remote refs if they are due one.
 *
 * Never rejects: a remote that cannot be reached is an ordinary state for a
 * panel to be in — no network, no credentials, a remote that has gone away —
 * and it must not turn a panel read into an error. A failed attempt still
 * consumes the interval, so an unreachable remote is retried on the same
 * schedule rather than on every poll.
 */
export async function scheduleGitRemoteRefresh(
  request: GitRemoteRefreshRequest,
  deps: GitRemoteRefreshDeps = defaultDeps,
): Promise<void> {
  const { sessionId, workDir, userId } = request;
  const state = getState();
  const key = await resolveRefsKeyCached(workDir, userId, deps);

  const running = state.inFlight.get(key);
  if (running) return running;

  const lastAttemptAt = state.lastAttemptAt.get(key);
  if (
    lastAttemptAt !== undefined &&
    deps.now() - lastAttemptAt < GIT_REMOTE_REFRESH_INTERVAL_MS
  ) {
    return Promise.resolve();
  }

  const attempt = (async () => {
    try {
      await deps.runFetch(workDir, userId);
      // Only the session that asked. Every other panel on this checkout reads
      // the same refs on its own 5s poll, so what this adds is speed for the
      // one panel a user is looking at — including one whose poll has backed
      // off after a slow scan.
      deps.onFetched(sessionId, userId);
    } catch (error) {
      logger.debug(
        { error, sessionId, workDir },
        "Background git fetch for the Git panel failed",
      );
    } finally {
      state.lastAttemptAt.set(key, deps.now());
      state.inFlight.delete(key);
    }
  })();

  state.inFlight.set(key, attempt);
  return attempt;
}
