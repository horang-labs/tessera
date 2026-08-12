import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execCli, isRunningInWsl, type CliEnvironment } from '@/lib/cli/cli-exec';
import { buildWslFilesystemPathProbe } from '@/lib/filesystem/wsl-path-probe';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';

interface CodexProviderHomeDependencies {
  exec?: typeof execCli;
  runtimePlatform?: () => NodeJS.Platform;
  runningInWsl?: () => boolean;
}

interface CodexProviderHomeFingerprintDependencies {
  realpath?: (filesystemPath: string) => string;
  formatForAgent?: typeof formatPathForAgentDisplay;
  wslDistroName?: () => string | undefined;
}

interface CodexProviderHomeIdentityDependencies
  extends CodexProviderHomeFingerprintDependencies {
  exec?: typeof execCli;
}

function extractWslDistroName(filesystemPath: string): string | undefined {
  return filesystemPath
    .replace(/\//gu, '\\')
    .match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)/iu)?.[1];
}

/** Stable, path-free identity for one Codex home in one Agent Environment. */
export function fingerprintCodexProviderHome(
  environment: CliEnvironment,
  providerHomeFilesystemPath: string,
  dependencies: CodexProviderHomeFingerprintDependencies = {},
): string {
  let canonicalFilesystemPath = providerHomeFilesystemPath.trim();
  try {
    canonicalFilesystemPath = (dependencies.realpath ?? fs.realpathSync.native)(
      canonicalFilesystemPath,
    );
  } catch {
    // A prospective home may not exist yet. Its absolute Agent-visible spelling
    // is still stable enough to compare before lifecycle installation creates it.
  }
  const agentPath = (dependencies.formatForAgent ?? formatPathForAgentDisplay)(
    canonicalFilesystemPath,
    environment,
  );
  const windowsStyle = /^[A-Za-z]:[\\/]/u.test(agentPath) || agentPath.startsWith('\\\\');
  const pathModule = windowsStyle ? path.win32 : path.posix;
  const normalized = pathModule.normalize(agentPath).replace(/[\\/]+$/u, '');
  const canonicalKey = windowsStyle ? normalized.toLowerCase() : normalized;
  const wslDistro = environment === 'wsl'
    ? (
        extractWslDistroName(canonicalFilesystemPath)
        ?? dependencies.wslDistroName?.()
        ?? process.env.WSL_DISTRO_NAME
        ?? ''
      ).trim().toLowerCase()
    : '';
  return `codex-home:v1:${createHash('sha256')
    .update(`${environment}\0${wslDistro}\0${canonicalKey}`)
    .digest('hex')}`;
}

/**
 * Resolve the complete ownership key before hashing a home. A WSL-owned home
 * can live on a Windows-mounted drive, where its path alone carries no distro
 * name, so the active Agent Environment must supply that missing owner.
 */
export async function resolveCodexProviderHomeIdentity(
  environment: CliEnvironment,
  providerHomeFilesystemPath: string,
  dependencies: CodexProviderHomeIdentityDependencies = {},
): Promise<string> {
  if (environment !== 'wsl') {
    return fingerprintCodexProviderHome(
      environment,
      providerHomeFilesystemPath,
      dependencies,
    );
  }

  let wslDistroName = extractWslDistroName(providerHomeFilesystemPath)
    ?? dependencies.wslDistroName?.();
  if (!wslDistroName) {
    const result = await (dependencies.exec ?? execCli)(
      'sh',
      ['-c', 'printf \'%s\\n\' "${WSL_DISTRO_NAME:-}"'],
      'wsl',
      5_000,
    );
    wslDistroName = result.ok ? lastNonEmptyLine(result.stdout) ?? undefined : undefined;
  }
  if (!wslDistroName?.trim()) {
    throw new Error('The WSL distribution owning the Codex home could not be resolved.');
  }

  return fingerprintCodexProviderHome(
    environment,
    providerHomeFilesystemPath,
    {
      ...dependencies,
      wslDistroName: () => wslDistroName,
    },
  );
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
