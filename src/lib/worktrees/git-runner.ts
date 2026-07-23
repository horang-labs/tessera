import type { SpawnOptions } from 'child_process';
import { normalizeCwdForCliEnvironment, spawnCli } from '@/lib/cli/spawn-cli';
import type { AgentEnvironment } from '@/lib/settings/types';

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitRunResult>;

export interface GitRunnerOptions {
  // Kill the command (and its process group) after this many milliseconds.
  // Only opt in for read-only queries; long-running operations like
  // `worktree add` on large repos legitimately exceed small deadlines.
  timeoutMs?: number;
}

export function createGitRunner(
  agentEnvironment: AgentEnvironment,
  runnerOptions?: GitRunnerOptions,
): GitRunner {
  return (args) => runGitCommand(
    normalizeGitPathArgs(args, agentEnvironment),
    agentEnvironment,
    runnerOptions,
  );
}

function normalizeGitPathArgs(args: string[], agentEnvironment: AgentEnvironment): string[] {
  return args.map((arg) => (
    looksLikeFilesystemPath(arg)
      ? normalizeCwdForCliEnvironment(arg, agentEnvironment)
      : arg
  ));
}

function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || value.startsWith('//')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /^[a-zA-Z]:$/.test(value)
  );
}

function runGitCommand(
  args: string[],
  agentEnvironment: AgentEnvironment,
  runnerOptions?: GitRunnerOptions,
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    // git resolves from WSL's default PATH and needs nothing from the user's
    // shell rc, so skip the WSL login shell here — sourcing heavy rc files
    // (nvm, oh-my-zsh) on every git call dominated worktree creation time.
    const child = spawnCli('git', args, options, agentEnvironment, { loginShell: false });

    // Reject on a timer rather than spawn's `timeout`: a wedged grandchild
    // (hook, fsmonitor) inherits the stdio pipes and keeps 'close' from
    // firing even after git itself is killed.
    const killTimer = runnerOptions?.timeoutMs
      ? setTimeout(() => {
        reject(new Error(`git did not respond within ${runnerOptions.timeoutMs}ms and was terminated`));
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, runnerOptions.timeoutMs)
      : null;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `git exited with code ${code}`));
    });

    child.on('error', (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
  });
}
