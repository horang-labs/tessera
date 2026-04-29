import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { getRuntimePlatform } from '../system/runtime-platform';

export interface ExecResult {
  /** True iff the process closed with exit code 0 AND did not time out. */
  ok: boolean;
  /** Exit code, or null when the process died without exiting cleanly. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CliEnvironment = 'native' | 'wsl';

let _wslDetectionCache: boolean | undefined;

/**
 * Detects whether the current Node process runs inside WSL.
 * Cached after first read.
 *
 * Uses /proc/version which on WSL contains `microsoft` or `WSL`
 * (case-insensitive). On non-Linux platforms the file either doesn't
 * exist or doesn't contain those tokens.
 */
export function isRunningInWsl(): boolean {
  if (_wslDetectionCache !== undefined) return _wslDetectionCache;
  try {
    if (!existsSync('/proc/version')) {
      _wslDetectionCache = false;
      return false;
    }
    const content = readFileSync('/proc/version', 'utf8').toLowerCase();
    _wslDetectionCache = content.includes('microsoft') || content.includes('wsl');
    return _wslDetectionCache;
  } catch {
    _wslDetectionCache = false;
    return false;
  }
}

/**
 * Reset the WSL-detection cache. Only used by tests.
 */
export function __resetWslDetectionCacheForTests(): void {
  _wslDetectionCache = undefined;
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildBashExecScript(command: string, args: string[]): string {
  return ['exec', quoteBashArg(command), ...args.map(quoteBashArg)].join(' ');
}

/**
 * Runs a CLI binary with a hard timeout, capturing stdout/stderr as strings.
 *
 * Routing:
 *   - server=Windows native, env=wsl  → `wsl bash -lic 'exec <command> <args...>'`
 *   - server=WSL, env=native          → `cmd.exe /c "<command> <args>"`
 *     (reaches the Windows host's PATH via WSL interop)
 *   - otherwise                       → `spawn(command, args)` directly
 *
 * Never throws — all failure modes map to `{ ok: false, ... }`.
 */
export async function execCli(
  command: string,
  args: string[],
  environment: CliEnvironment,
  timeoutMs: number,
): Promise<ExecResult> {
  const onWin32 = getRuntimePlatform() === 'win32';
  const onWsl = !onWin32 && isRunningInWsl();

  let spawnCommand: string;
  let spawnArgs: string[];

  if (onWin32 && environment === 'wsl') {
    spawnCommand = 'wsl';
    // Match WSL session spawning so status checks see the same PATH a user
    // gets from their WSL shell.
    spawnArgs = ['bash', '-lic', buildBashExecScript(command, args)];
  } else if (onWsl && environment === 'native') {
    // cmd.exe /c takes a single command string. Our callers only run
    // fixed verbs like `claude --version` with no user input, so a
    // simple space-join is safe. Do NOT shell-escape — it would mangle
    // the expected argv on the Windows side.
    spawnCommand = 'cmd.exe';
    spawnArgs = ['/c', [command, ...args].join(' ')];
  } else {
    // Native on the server's own platform, including the WSL self-check
    // (env=wsl when the server itself runs in WSL).
    spawnCommand = command;
    spawnArgs = args;
  }

  return new Promise((resolve) => {
    const proc = spawn(spawnCommand, spawnArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stderr += `\n[execCli] timeout after ${timeoutMs}ms`;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    const finish = (exitCode: number | null, ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, exitCode, stdout, stderr });
    };

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      stderr += `\n[execCli] spawn error: ${err.message}`;
      finish(null, false);
    });

    proc.on('close', (code) => {
      finish(code, !timedOut && code === 0);
    });
  });
}

/**
 * Checks whether a CLI binary is reachable in the requested environment.
 *
 * Routes through execCli so the probe runs in the correct host:
 *   - env=native on Windows/WSL → `where <binary>` via cmd.exe
 *   - env=wsl   on Windows      → `which <binary>` via wsl.exe
 *   - otherwise (Linux/macOS)   → `which <binary>` directly
 */
export async function probeBinaryAvailable(
  binary: string,
  environment: CliEnvironment,
): Promise<boolean> {
  const onWin32 = getRuntimePlatform() === 'win32';
  const onWsl = !onWin32 && isRunningInWsl();
  const targetIsWindows = environment === 'native' && (onWin32 || onWsl);
  const probe = targetIsWindows ? 'where' : 'which';
  const result = await execCli(probe, [binary], environment, 5000);
  return result.ok;
}

/**
 * Extracts a SemVer-ish token from arbitrary CLI `--version` stdout.
 * Matches the first `N.N.N` triple with an optional pre-release suffix.
 * Returns undefined when no triple is found.
 *
 * Examples:
 *   "Claude Code 2.1.114"                      → "2.1.114"
 *   "codex-cli 0.42.0 (build 1234)"            → "0.42.0"
 *   "weird output with no version"             → undefined
 */
export function parseVersion(stdout: string): string | undefined {
  const match = stdout.match(/\b(\d+\.\d+\.\d+(?:[-.\w]*)?)\b/);
  return match ? match[1] : undefined;
}
