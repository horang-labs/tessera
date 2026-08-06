/**
 * Running the GitHub CLI, once, in the agent's environment.
 *
 * `gh` is not Git, so it does not go through `git-runner.ts` — but it is subject
 * to the same rule about where it runs: the agent environment decides, because a
 * bridged setup keeps the repository, the credentials and the CLI on the far
 * side of the boundary (ADR 0006). `spawnCli` is what applies that.
 *
 * A non-zero exit is a result, not an exception: the caller classifies what gh
 * said. Only a process that never started resolves with a null exit code, and
 * its stderr is the spawn error.
 */
import type { SpawnOptions } from 'child_process';
import { spawnCli } from '@/lib/cli/spawn-cli';
import type { AgentEnvironment } from '@/lib/settings/types';

/** Enough for any JSON gh returns; a runaway process cannot fill memory. */
const GH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GhCommandResult {
  /** Null when gh never ran at all — then `stderr` is the spawn error. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
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

    child.stdout?.on('data', stdout.push);
    child.stderr?.on('data', stderr.push);

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout: stdout.read(), stderr: stderr.read() });
    });

    child.on('error', (error) => {
      resolve({ exitCode: null, stdout: stdout.read(), stderr: error.message });
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
