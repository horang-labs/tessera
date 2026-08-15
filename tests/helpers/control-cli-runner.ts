import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ControlCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runControlCli(
  args: string[],
  options: {
    repoRoot?: string;
    envOverrides?: Record<string, string>;
    stdin?: string;
  } = {},
): Promise<ControlCliResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'bin', 'tessera.mjs'), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TESSERA_AGENT_ENVIRONMENT: 'wsl',
        TESSERA_CONTROL_DESCRIPTOR: '',
        TESSERA_PROJECT_ID: '',
        ...options.envOverrides,
      },
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}
