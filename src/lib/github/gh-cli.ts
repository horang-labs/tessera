/**
 * Running the GitHub CLI, once, in the agent's environment.
 *
 * `gh` is not Git, so it does not go through `git-runner.ts` — but it is subject
 * to the same rule about where it runs: the agent environment decides, because a
 * bridged setup keeps the repository, the credentials and the CLI on the far
 * side of the boundary (ADR 0006). `spawnCli` is what applies that.
 *
 * A non-zero exit is a result, not an exception: the caller classifies what gh
 * said. Only a process that never started — or one that had to be killed —
 * resolves with a null exit code, and its stderr says which.
 */
import type { SpawnOptions } from 'child_process';
import { spawnCli } from '@/lib/cli/spawn-cli';
import { killProcessGroup } from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';

/** Enough for any JSON gh returns; a runaway process cannot fill memory. */
const GH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Well clear of a slow GitHub API round trip, and far below the Git runner's ten
 * minutes: gh runs no hooks and pushes no objects, so nothing legitimate here
 * takes a minute. Without a bound a wedged gh never settles, and the panel's
 * in-flight frame (§7) has nothing to end it — the button spins until reload.
 */
const GH_TIMEOUT_MS = 60_000;

export interface GhCommandResult {
  /** Null when gh never ran, or when it ran and had to be killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the runner killed it for taking longer than `GH_TIMEOUT_MS`. */
  timedOut?: boolean;
}

export interface GhInvocationOptions {
  cwd?: string;
}

export type GhRunner = (
  args: string[],
  options?: GhInvocationOptions,
) => Promise<GhCommandResult>;

export function createGhRunner(agentEnvironment: AgentEnvironment): GhRunner {
  return (args, options = {}) => runGh(args, options, agentEnvironment);
}

function runGh(
  args: string[],
  options: GhInvocationOptions,
  agentEnvironment: AgentEnvironment,
): Promise<GhCommandResult> {
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: process.env,
      // stdin is closed rather than inherited: gh prompts when it has a
      // terminal, and a prompt no one can answer is a request that never ends.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    const child = spawnCli('gh', args, spawnOptions, agentEnvironment);
    const stdout = createOutputCollector();
    const stderr = createOutputCollector();
    let settled = false;
    // Our own timer rather than spawn's `timeout`, for the same reason the Git
    // runner keeps one: a wedged grandchild inherits the stdio pipes and holds
    // 'close' back even once gh itself is gone.
    const killTimer = setTimeout(() => {
      if (settled) return;
      killProcessGroup(child);
      settle({
        exitCode: null,
        stdout: stdout.read(),
        stderr:
          stderr.read()
          || `gh did not respond within ${GH_TIMEOUT_MS}ms and was terminated`,
        timedOut: true,
      });
    }, GH_TIMEOUT_MS);

    const settle = (result: GhCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout?.on('data', stdout.push);
    child.stderr?.on('data', stderr.push);

    child.on('close', (code) => {
      settle({ exitCode: code, stdout: stdout.read(), stderr: stderr.read() });
    });

    child.on('error', (error) => {
      settle({ exitCode: null, stdout: stdout.read(), stderr: error.message });
    });
  });
}

function createOutputCollector() {
  const chunks: Buffer[] = [];
  let length = 0;

  return {
    push: (chunk: Buffer): void => {
      length += chunk.length;
      if (length <= GH_MAX_OUTPUT_BYTES) chunks.push(chunk);
    },
    read: (): string => Buffer.concat(chunks).toString('utf8').trim(),
  };
}
