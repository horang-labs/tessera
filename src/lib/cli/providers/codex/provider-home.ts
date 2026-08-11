import path from 'node:path';
import { createHash } from 'node:crypto';
import { execCli, isRunningInWsl, type CliEnvironment } from '@/lib/cli/cli-exec';
import { buildWslFilesystemPathProbe } from '@/lib/filesystem/wsl-path-probe';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

interface CodexProviderHomeDependencies {
  exec?: typeof execCli;
  runtimePlatform?: () => NodeJS.Platform;
  runningInWsl?: () => boolean;
}

/** Stable, path-free identity for one Codex home in one Agent Environment. */
export function fingerprintCodexProviderHome(
  environment: CliEnvironment,
  providerHomeFilesystemPath: string,
): string {
  const normalized = path.normalize(providerHomeFilesystemPath).replace(/[\\/]+$/u, '');
  return `codex-home:v1:${createHash('sha256')
    .update(`${environment}\0${normalized}`)
    .digest('hex')}`;
}

function lastNonEmptyLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function windowsPathToWslPath(value: string): string | null {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!driveMatch) return null;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/[\\/]+/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/** Resolve the sole Codex home owned by the active Agent Environment. */
export async function resolveCodexHomeForEnvironment(
  environment: CliEnvironment,
  dependencies: CodexProviderHomeDependencies = {},
): Promise<string> {
  const execute = dependencies.exec ?? execCli;
  const runtimePlatform = dependencies.runtimePlatform ?? getRuntimePlatform;
  const runningInWsl = dependencies.runningInWsl ?? isRunningInWsl;

  if (environment === 'wsl' && runtimePlatform() === 'win32') {
    // The WSL bridge already invokes a login shell. Keep it enabled so a custom
    // CODEX_HOME exported by the user's profile is the same one Codex sees.
    const result = await execute(
      'sh',
      ['-c', buildWslFilesystemPathProbe('${CODEX_HOME:-$HOME/.codex}')],
      'wsl',
      5_000,
    );
    const resolvedDir = lastNonEmptyLine(result.stdout);
    if (result.ok && resolvedDir) return resolvedDir;
    throw new Error('The WSL Codex home could not be resolved from the agent login environment.');
  }

  if (
    environment === 'native'
    && (runtimePlatform() === 'win32' || runningInWsl())
  ) {
    const result = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }; Write-Output $codexDir",
      ],
      'native',
      5_000,
    );
    const windowsCodexHome = lastNonEmptyLine(result.stdout);
    if (result.ok && windowsCodexHome) {
      if (runtimePlatform() === 'win32') return path.win32.resolve(windowsCodexHome);
      const wslCodexHome = windowsPathToWslPath(windowsCodexHome);
      if (wslCodexHome) return wslCodexHome;
    }
    throw new Error('The native Windows Codex home could not be resolved from the agent login environment.');
  }

  // On macOS/Linux (including a WSL-hosted server with a WSL agent), probe the
  // same login environment used to spawn Codex. GUI launchers often do not
  // inherit a CODEX_HOME exported from the user's shell profile.
  const result = await execute(
    'sh',
    ['-c', 'printf \'%s\\n\' "${CODEX_HOME:-$HOME/.codex}"'],
    environment,
    5_000,
  );
  const resolvedDir = lastNonEmptyLine(result.stdout);
  if (result.ok && resolvedDir && path.isAbsolute(resolvedDir)) {
    return path.resolve(resolvedDir);
  }

  // A failed probe is not permission to guess the default home: the login
  // environment may define a custom CODEX_HOME that this process cannot see.
  throw new Error('The Codex home could not be resolved from the agent login environment.');
}
