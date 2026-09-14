import {
  createGitShellRunner,
  GitCommandError,
  looksLikeFilesystemPath,
  type GitRunnerOptions,
} from './git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';

export interface GitBatchCommand {
  key: string;
  args: string[];
}

export interface GitBatchResult {
  stdout: string;
  exitCode: number;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Path-free reads only. cwd is translated by the platform runner, never here. */
export function buildGitBatchScript(commands: GitBatchCommand[]): string {
  const keys = new Set<string>();
  for (const { key, args } of commands) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || keys.has(key)) {
      throw new Error(`Invalid git batch key: ${key}`);
    }
    keys.add(key);
    const pathArg = args.find(looksLikeFilesystemPath);
    if (pathArg) throw new Error(`Batched git commands cannot carry a path argument: ${pathArg}`);
  }
  // Encode stdout together with a final NUL + exit status. Shell variables
  // cannot preserve NULs; streaming this envelope avoids temporary files that
  // would survive SIGKILL on timeout. The final NUL is unambiguous even when
  // stdout itself is NUL-delimited (ls-files/status).
  return [
    'command -v base64 >/dev/null 2>&1 || exit 69',
    'command -v tr >/dev/null 2>&1 || exit 69',
    ...commands.flatMap(({ key, args }) => [
      `printf '%s\\tb64:' ${quote(key)}`,
      `{ git ${args.map(quote).join(' ')} 2>/dev/null; printf '\\000%d' "$?"; } | base64 | tr -d '\\r\\n'`,
      `printf '\\n'`,
    ]),
  ].join('\n');
}

export function parseGitBatchOutput(
  raw: string,
  commands: GitBatchCommand[],
): Map<string, GitBatchResult> {
  const expected = new Set(commands.map(({ key }) => key));
  const results = new Map<string, GitBatchResult>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [key, field, ...extra] = line.split('\t');
    if (!expected.has(key) || results.has(key) || extra.length
      || !/^b64:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(field ?? '')) {
      throw new GitCommandError('command_failed', 'Invalid batched git output');
    }
    const decoded = Buffer.from(field.slice(4), 'base64');
    const separator = decoded.lastIndexOf(0);
    const status = decoded.subarray(separator + 1).toString('utf8');
    if (separator < 0 || !/^\d+$/.test(status) || Number(status) > 255) {
      throw new GitCommandError('command_failed', 'Invalid batched git exit status');
    }
    results.set(key, {
      stdout: decoded.subarray(0, separator).toString('utf8').trimEnd(),
      exitCode: Number(status),
    });
  }
  if (results.size !== expected.size) {
    throw new GitCommandError('command_failed', 'Incomplete batched git output');
  }
  return results;
}

export async function runGitQueryBatch(
  commands: GitBatchCommand[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
  options: GitRunnerOptions,
): Promise<Map<string, GitBatchResult>> {
  const result = await createGitShellRunner(agentEnvironment, { ...options, readOnly: true })(
    buildGitBatchScript(commands), { cwd },
  );
  if (result.truncated || result.stoppedEarly) {
    throw new GitCommandError('command_failed', 'Batched git output exceeded its limit');
  }
  return parseGitBatchOutput(result.stdout, commands);
}
