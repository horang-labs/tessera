/**
 * The one place Tessera runs Git (`docs/design/git-delivery.md` §10).
 *
 * Everything a Git call needs lives here rather than half in this file and half
 * in the Git panel: per-argument path translation for the agent environment, a
 * preserved exit code and stderr on failure, a default timeout that also kills
 * wedged grandchildren, an output cap, and stderr classification that promotes
 * authentication and not-found out of a generic command failure.
 *
 * The environment is always named by the caller; ADR 0006 explains why, and
 * `@/lib/git/git-environment` is where it comes from.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { normalizeCwdForCliEnvironment, spawnCli } from '@/lib/cli/spawn-cli';
import type { AgentEnvironment } from '@/lib/settings/types';

/**
 * A hung Git command dies here — a backstop for a command that will never
 * answer, not a latency budget. It has to clear the slowest legitimate call in
 * the product by a wide margin: `worktree add` on a large repository runs for
 * minutes, and before this runner those call sites had no deadline at all, so a
 * tight default would turn a slow success into a failure. Callers that want a
 * quick failure (the Git panel reads a session's state on every switch) pass
 * their own `timeoutMs`.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 600_000;

/**
 * Output past this is dropped rather than buffered. A `git diff` over a vendored
 * tree or an unignored `node_modules` can produce hundreds of megabytes, all of
 * it destined for a panel that shows the first few hundred lines.
 */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * How a Git command failed. `authentication`, `not_found` and `hook_rejected`
 * are promoted out of `command_failed` because a caller can act on them — the
 * rest is stderr.
 *
 * `hook_rejected` earns its place by answering a different question from the
 * others: the tool worked and the user's own code was refused.
 */
export type GitFailureKind =
  | 'authentication'
  | 'not_found'
  | 'hook_rejected'
  | 'timeout'
  | 'spawn_failed'
  | 'command_failed';

export interface GitRunResult {
  /** Trailing whitespace trimmed only: `git status -z` leads with a status column. */
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when output passed the cap and the remainder was dropped. */
  truncated: boolean;
  /** True when `onStdout` asked to stop before Git finished on its own. */
  stoppedEarly: boolean;
}

export class GitCommandError extends Error {
  readonly kind: GitFailureKind;
  /** Null when the process never ran (spawn failure) or was killed by us. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The spawn errno (`ENOENT`, ...) when Git could not be started. Preserved as
   * an own property because `checkManagedWorktreePreflight` distinguishes "Git
   * is not installed" from "Git said no" by reading it.
   */
  readonly code?: string;

  constructor(
    kind: GitFailureKind,
    message: string,
    detail: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      code?: string;
    } = {},
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.kind = kind;
    this.exitCode = detail.exitCode ?? null;
    this.stdout = detail.stdout ?? '';
    this.stderr = detail.stderr ?? '';
    if (detail.code) this.code = detail.code;
  }
}

export interface GitRunnerOptions {
  /** Overrides `DEFAULT_GIT_TIMEOUT_MS` for every call this runner makes. */
  timeoutMs?: number;
  /** Overrides `DEFAULT_GIT_MAX_OUTPUT_BYTES` for every call this runner makes. */
  maxOutputBytes?: number;
}

export interface GitInvocationOptions extends GitRunnerOptions {
  /**
   * Working directory. `spawnCli` translates it for the agent environment on
   * the way out, so pass it in whichever form this server knows it.
   */
  cwd?: string;
  /**
   * Watch stdout as it arrives. Returning `'stop'` kills the process group and
   * resolves with whatever has been collected (`stoppedEarly: true`) — how the
   * Git panel stops `git status` halfway through a huge untracked tree instead
   * of waiting out a walk whose result it would discard.
   */
  onStdout?: (chunk: Buffer) => 'stop' | void;
}

export type GitRunner = (
  args: string[],
  options?: GitInvocationOptions,
) => Promise<GitRunResult>;

/**
 * Runs several Git commands behind one `sh -c`. Only worth it when each spawn
 * crosses the WSL bridge; the script itself is the caller's to build.
 */
export type GitShellRunner = (
  script: string,
  options?: GitInvocationOptions,
) => Promise<GitRunResult>;

export function createGitRunner(
  agentEnvironment: AgentEnvironment,
  runnerOptions?: GitRunnerOptions,
): GitRunner {
  return (args, invocationOptions) => runCommand(
    'git',
    normalizeGitPathArgs(args, agentEnvironment),
    agentEnvironment,
    { ...runnerOptions, ...invocationOptions },
  );
}

export function createGitShellRunner(
  agentEnvironment: AgentEnvironment,
  runnerOptions?: GitRunnerOptions,
): GitShellRunner {
  // The script is program text, not a path argument, so it is passed through
  // untranslated — the Git commands inside it name paths relative to `cwd`.
  return (script, invocationOptions) => runCommand(
    'sh',
    ['-c', script],
    agentEnvironment,
    { ...runnerOptions, ...invocationOptions },
  );
}

function normalizeGitPathArgs(args: string[], agentEnvironment: AgentEnvironment): string[] {
  return args.map((arg) => (
    looksLikeFilesystemPath(arg)
      ? normalizeCwdForCliEnvironment(arg, agentEnvironment)
      : arg
  ));
}

/** What the runner treats as a path argument, and therefore translates. */
export function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || value.startsWith('//')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /^[a-zA-Z]:$/.test(value)
  );
}

// A killed process group can keep the stdout pipe open through a grandchild, so
// 'close' may never arrive. Resolve shortly after the kill with what we have.
const STOPPED_EARLY_GRACE_MS = 500;

function runCommand(
  command: string,
  args: string[],
  agentEnvironment: AgentEnvironment,
  options: GitInvocationOptions,
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      // stdin is ignored, so a credential prompt would block the child
      // forever; tell git to fail instead of prompting.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    // git and sh resolve from WSL's default PATH and need nothing from the
    // user's shell rc, so skip the WSL login shell — sourcing heavy rc files
    // (nvm, oh-my-zsh) on every call dominated worktree creation time.
    const child = spawnCli(command, args, spawnOptions, agentEnvironment, { loginShell: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let truncated = false;
    let stoppedEarly = false;
    let settled = false;

    const collect = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdoutChunks).toString('utf8').trimEnd(),
      stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
    });

    // Kill on our own timer rather than spawn's `timeout`: a wedged grandchild
    // (hook, credential helper, fsmonitor) inherits the stdio pipes and keeps
    // 'close' from firing even after the command itself is killed.
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup(child);
      const { stdout, stderr } = collect();
      reject(new GitCommandError(
        'timeout',
        `${command} did not respond within ${timeoutMs}ms and was terminated`,
        { stdout, stderr },
      ));
    }, timeoutMs);

    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const fail = (error: GitCommandError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(error);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= maxOutputBytes) stdoutChunks.push(chunk);
      else truncated = true;

      if (stoppedEarly || settled) return;
      if (options.onStdout?.(chunk) !== 'stop') return;

      stoppedEarly = true;
      killProcessGroup(child);
      setTimeout(() => {
        const { stdout, stderr } = collect();
        finish({ stdout, stderr, exitCode: 0, truncated, stoppedEarly: true });
      }, STOPPED_EARLY_GRACE_MS);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength <= maxOutputBytes) stderrChunks.push(chunk);
      else truncated = true;
    });

    child.on('close', (code) => {
      const { stdout, stderr } = collect();

      if (stoppedEarly) {
        finish({ stdout, stderr, exitCode: code ?? 0, truncated, stoppedEarly: true });
        return;
      }

      if (code === 0) {
        finish({ stdout, stderr, exitCode: 0, truncated, stoppedEarly: false });
        return;
      }

      fail(new GitCommandError(
        classifyGitFailure(stderr),
        stderr || `${command} exited with code ${code}`,
        { exitCode: code, stdout, stderr },
      ));
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(new GitCommandError(
        'spawn_failed',
        error.message || `Failed to run ${command}`,
        { code: error.code, stderr: error.message },
      ));
    });
  });
}

function killProcessGroup(child: ChildProcess): void {
  try {
    // detached spawn makes the command a group leader on POSIX; kill the whole
    // group so wedged grandchildren die with it.
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Git says the same few things when a credential or a ref is the problem, and
// nothing machine-readable, so the promotion is by stderr text. Anything not
// matched here stays `command_failed` and keeps its stderr.
const AUTHENTICATION_PATTERNS = [
  'authentication failed',
  'could not read username',
  'could not read password',
  'terminal prompts disabled',
  'permission denied (publickey',
  'invalid username or password',
  'support for password authentication was removed',
  // No bare "access denied": Windows says it for a locked file, and a
  // `worktree remove` losing to an open handle is not a credential problem.
];

const NOT_FOUND_PATTERNS = [
  'repository not found',
  'not a git repository',
  'does not exist',
  'unknown revision or path not in the working tree',
  "did not match any file(s) known to git",
  "couldn't find remote ref",
  'no such remote',
];

/**
 * How Git prefixes a line it wrote itself. `remote:` output is excluded on
 * purpose: `remote: error: hook declined` is a server echoing its own hook, not
 * this Git explaining a failure.
 */
const GIT_DIAGNOSTIC_PREFIXES = ['fatal:', 'error:', 'warning:', 'hint:'];

/** True when any line reads as Git's own diagnostic rather than a child's output. */
export function hasGitDiagnosticLine(text: string): boolean {
  return text
    .split('\n')
    .some((line) => {
      const normalized = line.trimStart().toLowerCase();
      return GIT_DIAGNOSTIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    });
}

/**
 * Git sends hook output to stderr along with its own, and says nothing itself
 * about which hook refused, so the signal is whatever the hook printed. Named
 * runners identify themselves; a hand-written hook may not, and one that also
 * stays silent is caught in the commit path instead
 * (`src/lib/git/git-actions.ts`), where the command being `git commit` is known.
 *
 * These are substring matches, so a hook's *filename* can trip them —
 * `fatal: cannot open '.husky/pre-commit'` is Git failing to read a file, not a
 * hook refusing anything. `hasGitDiagnosticLine` is what tells the two apart.
 */
const HOOK_REJECTION_PATTERNS = [
  'pre-commit',
  'commit-msg',
  'pre-push',
  'pre-rebase',
  'pre-merge-commit',
  'prepare-commit-msg',
  'hook declined',
  'hook failed',
  'husky',
  'lefthook',
  'lint-staged',
  'pre-receive hook',
  'update hook',
];

function classifyGitFailure(stderr: string): GitFailureKind {
  const haystack = stderr.toLowerCase();
  // Authentication first: a private repository answers "Repository not found"
  // to an unauthenticated caller, but a credential error is never ambiguous.
  if (AUTHENTICATION_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return 'authentication';
  }
  if (NOT_FOUND_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return 'not_found';
  }
  // After both, so a hook that fails on a credential or a missing ref is still
  // reported as the thing the user can act on.
  if (
    HOOK_REJECTION_PATTERNS.some((pattern) => haystack.includes(pattern))
    && !hasGitDiagnosticLine(stderr)
  ) {
    return 'hook_rejected';
  }
  return 'command_failed';
}
