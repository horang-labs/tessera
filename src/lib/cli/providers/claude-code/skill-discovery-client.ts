import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { CliEnvironment } from '@/lib/cli/cli-exec';
import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import {
  getAgentEnvironment,
  normalizeCwdForCliEnvironment,
  spawnCli,
} from '@/lib/cli/spawn-cli';
import type { SkillInfo } from '../skill-types';

const DISCOVERY_TIMEOUT_MS = 30_000;

export interface ClaudeSkillDiscoveryContext {
  userId?: string;
  workDir?: string | null;
  environment?: CliEnvironment;
}

export type ClaudeSkillDiscoveryResponse =
  | { skills: SkillInfo[] }
  | { error: string };

/** Parses only the initialize response belonging to this discovery request. */
export function parseClaudeSkillDiscoveryResponse(
  line: string,
  requestId: string,
): ClaudeSkillDiscoveryResponse | null {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }

  const response = message?.type === 'control_response' ? message.response : null;
  if (!response || response.request_id !== requestId) return null;
  if (response.subtype === 'error') {
    return { error: String(response.error || 'Claude initialize failed.') };
  }

  const commands = response.response?.commands;
  if (!Array.isArray(commands)) return null;

  return {
    skills: commands
      .filter((command: any) => command && typeof command.name === 'string')
      .map((command: any) => ({
        name: command.name.slice(0, 100),
        description: typeof command.description === 'string'
          ? command.description.slice(0, 500)
          : '',
      })),
  };
}

function killDiscoveryProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // The short-lived process may already have exited between the checks.
  }
}

/** Lists Claude's provider-reported commands without creating a persisted session or turn. */
export async function listClaudeSkills(
  context: ClaudeSkillDiscoveryContext,
): Promise<SkillInfo[]> {
  const environment = context.environment ?? await getAgentEnvironment(context.userId);
  const command = await resolveProviderCliCommand(
    'claude-code',
    'claude',
    environment,
    context.userId,
  );
  const requestedCwd = context.workDir?.trim() || process.cwd();
  const cwd = normalizeCwdForCliEnvironment(requestedCwd, environment);
  const requestId = randomUUID();
  const spawnEnv: Record<string, string | undefined> = { ...process.env };
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.NODE_ENV;
  delete spawnEnv.MAX_THINKING_TOKENS;

  return new Promise<SkillInfo[]>((resolve, reject) => {
    const proc = spawnCli(command, [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--allow-dangerously-skip-permissions',
      '--append-system-prompt', '',
      '--no-session-persistence',
    ], {
      cwd,
      shell: false,
      env: spawnEnv as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }, environment);
    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('spawn', onSpawn);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
      killDiscoveryProcess(proc);
      callback();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const onStdout = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const response = parseClaudeSkillDiscoveryResponse(line, requestId);
        if (!response) continue;
        if ('error' in response) {
          fail(new Error(response.error));
        } else {
          finish(() => resolve(response.skills));
        }
        return;
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    };
    const onSpawn = () => {
      if (!proc.stdin?.writable) {
        fail(new Error('Claude discovery stdin is unavailable.'));
        return;
      }
      proc.stdin.write(`${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'initialize' },
      })}\n`);
    };
    const onError = (error: Error) => fail(error);
    const onClose = (code: number | null) => {
      fail(new Error(
        `Claude exited before skill discovery completed (code ${code})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    };
    const timeout = setTimeout(() => {
      fail(new Error('Timed out while discovering Claude skills.'));
    }, DISCOVERY_TIMEOUT_MS);

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
    proc.once('close', onClose);
  });
}
