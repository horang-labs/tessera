import { existsSync, readFileSync } from 'fs';
import { getRuntimePlatform } from '../system/runtime-platform';
import { getSpawnCliCache } from './spawn-cli-cache';
import { spawnCliProcess } from './spawn-cli-runtime';

export interface ExecResult {
  /** True iff the process closed with exit code 0 AND did not time out. */
  ok: boolean;
  /** Exit code, or null when the process died without exiting cleanly. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  spawnErrorCode?: string;
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

/**
 * Runs a CLI binary with a hard timeout, capturing stdout/stderr as strings.
 *
 * Routing is delegated to spawn-cli-runtime so status probes and real sessions
 * resolve Windows npm shims (`*.cmd`, `*.ps1`) the same way.
 *
 * Never throws — all failure modes map to `{ ok: false, ... }`.
 */
export async function execCli(
  command: string,
  args: string[],
  environment: CliEnvironment,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawnCliProcess(command, args, {
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, environment, getSpawnCliCache());

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

    const finish = (exitCode: number | null, ok: boolean, spawnErrorCode?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    };

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      stderr += `\n[execCli] spawn error: ${err.message}`;
      finish(null, false, err.code);
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
 *   - env=native on Windows     → `where.exe <binary>` via cmd.exe
 *   - env=native from WSL       → `where.exe <binary>` via PowerShell
 *   - env=wsl   on Windows      → `which <binary>` via wsl.exe login shell
 *   - otherwise (Linux/macOS)   → `which <binary>` directly
 */
export async function probeBinaryAvailable(
  binary: string,
  environment: CliEnvironment,
): Promise<boolean> {
  const onWin32 = getRuntimePlatform() === 'win32';
  const onWsl = !onWin32 && isRunningInWsl();
  const targetIsWindows = environment === 'native' && (onWin32 || onWsl);
  const probe = targetIsWindows ? 'where.exe' : 'which';
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
