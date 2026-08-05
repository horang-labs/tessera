import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

const execFileAsync = promisify(execFile);
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ControlCliBridgeContext {
  agentEnvironment: AgentEnvironment;
  projectId: string;
  sessionId: string;
  worktreeId?: string;
}

export interface PreparedControlCliBridge {
  commandPath: string;
  environment: Record<string, string | undefined>;
  dispose(): Promise<void>;
}

export interface ControlCliBridgeFactory {
  create(context: ControlCliBridgeContext): Promise<PreparedControlCliBridge>;
  dispose(): Promise<void>;
}

export interface WslExecutableStore {
  create(contents: string): Promise<string>;
  remove(commandPath: string): Promise<void>;
}

export interface ControlCliBridgeFactoryOptions {
  runtimeId: string;
  descriptorPath: string;
  cliEntryPath: string;
  hostExecutablePath: string;
  hostPlatform?: NodeJS.Platform;
  artifactRoot?: string;
  wslExecutableStore?: WslExecutableStore;
  formatHostPathForWsl?: (hostPath: string) => string;
}

interface OwnedBridge {
  commandPath: string;
  hostDirectory: string;
  guestCommandPath?: string;
  disposal?: Promise<void>;
}

export function createControlCliBridgeFactory(
  options: ControlCliBridgeFactoryOptions,
): ControlCliBridgeFactory {
  if (!SAFE_RUNTIME_ID.test(options.runtimeId)) {
    throw new Error('The Control runtime identity is invalid.');
  }
  const hostPlatform = options.hostPlatform ?? process.platform;
  const runtimeRoot = path.join(
    options.artifactRoot ?? getTesseraDataPath('control-bridges'),
    options.runtimeId,
  );
  const wslExecutableStore = options.wslExecutableStore ?? createDefaultWslExecutableStore();
  const owned = new Set<OwnedBridge>();
  const pendingCreations = new Set<Promise<void>>();
  const pendingDisposals = new Set<Promise<void>>();
  let factoryDisposed = false;
  let factoryDisposal: Promise<void> | undefined;

  const removeArtifacts = async (
    hostDirectory: string,
    guestCommandPath?: string,
  ): Promise<void> => {
    let firstError: unknown;
    if (guestCommandPath) {
      try {
        await wslExecutableStore.remove(guestCommandPath);
      } catch (error) {
        firstError = error;
      }
    }
    try {
      await fs.rm(hostDirectory, { recursive: true, force: true });
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };

  const disposeOwned = (bridge: OwnedBridge): Promise<void> => {
    if (bridge.disposal) return bridge.disposal;
    const disposal = removeArtifacts(bridge.hostDirectory, bridge.guestCommandPath)
      .then(() => { owned.delete(bridge); });
    bridge.disposal = disposal;
    pendingDisposals.add(disposal);
    void disposal.finally(() => {
      bridge.disposal = undefined;
      pendingDisposals.delete(disposal);
    }).catch(() => undefined);
    return disposal;
  };

  return {
    async create(context): Promise<PreparedControlCliBridge> {
      if (factoryDisposed) throw new Error('The Control CLI bridge factory is closed.');
      let finishCreation!: () => void;
      const creation = new Promise<void>((resolve) => { finishCreation = resolve; });
      pendingCreations.add(creation);
      try {
        const bridgeDirectory = path.join(runtimeRoot, randomUUID());
        await fs.mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
        await fs.chmod(runtimeRoot, 0o700).catch(() => undefined);
        await fs.chmod(bridgeDirectory, 0o700).catch(() => undefined);

        let commandPath: string;
        let guestCommandPath: string | undefined;
        try {
          if (hostPlatform === 'win32') {
            const hostBridgePath = path.join(bridgeDirectory, 'tessera-control-bridge.ps1');
            await fs.writeFile(
              hostBridgePath,
              buildPowerShellBridge({ ...options, context }),
              { encoding: 'utf8', mode: 0o600 },
            );
            if (context.agentEnvironment === 'wsl') {
              guestCommandPath = await wslExecutableStore.create(
                buildWslLauncher(
                  options.formatHostPathForWsl?.(hostBridgePath) ?? hostBridgePath,
                ),
              );
              commandPath = guestCommandPath;
            } else {
              commandPath = path.join(bridgeDirectory, 'tessera-control.cmd');
              await fs.writeFile(
                commandPath,
                buildWindowsCommandLauncher(hostBridgePath),
                { encoding: 'utf8', mode: 0o700 },
              );
            }
          } else {
            commandPath = path.join(bridgeDirectory, 'tessera-control');
            await fs.writeFile(
              commandPath,
              buildPosixBridge({ ...options, context }),
              { encoding: 'utf8', mode: 0o700 },
            );
            await fs.chmod(commandPath, 0o700);
          }
        } catch (error) {
          try {
            await removeArtifacts(bridgeDirectory, guestCommandPath);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              error instanceof Error ? error.message : 'Failed to create the Control CLI bridge.',
            );
          }
          throw error;
        }

        const bridge: OwnedBridge = {
          commandPath,
          hostDirectory: bridgeDirectory,
          guestCommandPath,
        };
        owned.add(bridge);
        if (factoryDisposed) {
          await disposeOwned(bridge).catch(() => undefined);
          throw new Error('The Control CLI bridge factory is closed.');
        }
        return {
          commandPath,
          environment: bridgeEnvironment(commandPath, context),
          dispose: () => disposeOwned(bridge),
        };
      } finally {
        pendingCreations.delete(creation);
        finishCreation();
      }
    },

    async dispose(): Promise<void> {
      factoryDisposed = true;
      if (factoryDisposal) return factoryDisposal;
      factoryDisposal = (async () => {
        await Promise.all([...pendingCreations]);
        const results = await Promise.allSettled([
          ...[...owned].map(disposeOwned),
          ...pendingDisposals,
        ]);
        let firstError = results.find((result) => result.status === 'rejected')?.reason;
        try {
          await fs.rm(runtimeRoot, { recursive: true, force: true });
        } catch (error) {
          firstError ??= error;
        }
        if (firstError) throw firstError;
      })();
      try {
        await factoryDisposal;
      } finally {
        factoryDisposal = undefined;
      }
    },
  };
}

function bridgeEnvironment(
  commandPath: string,
  context: ControlCliBridgeContext,
): Record<string, string> {
  return {
    TESSERA_ENV: '1',
    TESSERA_CLI_COMMAND: commandPath,
    TESSERA_PROJECT_ID: context.projectId,
    TESSERA_SESSION_ID: context.sessionId,
    ...(context.worktreeId ? { TESSERA_WORKTREE_ID: context.worktreeId } : {}),
  };
}

function buildPosixBridge(
  options: ControlCliBridgeFactoryOptions & { context: ControlCliBridgeContext },
): string {
  const { context } = options;
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'unset TESSERA_CONTROL_DESCRIPTOR TESSERA_CONTROL_DESCRIPTOR_PATH TESSERA_CLI_CWD TESSERA_CLI_WSL_DISTRO',
    'TESSERA_ENV=1; export TESSERA_ENV',
    `TESSERA_AGENT_ENVIRONMENT=${quotePosix(context.agentEnvironment)}; export TESSERA_AGENT_ENVIRONMENT`,
    `TESSERA_PROJECT_ID=${quotePosix(context.projectId)}; export TESSERA_PROJECT_ID`,
    `TESSERA_SESSION_ID=${quotePosix(context.sessionId)}; export TESSERA_SESSION_ID`,
    context.worktreeId
      ? `TESSERA_WORKTREE_ID=${quotePosix(context.worktreeId)}; export TESSERA_WORKTREE_ID`
      : 'unset TESSERA_WORKTREE_ID',
    'ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE',
    `exec ${quotePosix(options.hostExecutablePath)} ${quotePosix(options.cliEntryPath)} --control-descriptor ${quotePosix(options.descriptorPath)} "$@"`,
    '',
  ].join('\n');
}

function buildPowerShellBridge(
  options: ControlCliBridgeFactoryOptions & { context: ControlCliBridgeContext },
): string {
  const { context } = options;
  const worktreeAssignment = context.worktreeId
    ? `$env:TESSERA_WORKTREE_ID = ${quotePowerShell(context.worktreeId)}`
    : 'Remove-Item Env:TESSERA_WORKTREE_ID -ErrorAction SilentlyContinue';
  return [
    '[CmdletBinding(PositionalBinding=$false)]',
    'param(',
    '  [string]$WslCwd,',
    '  [string]$WslDistro,',
    '  [Parameter(ValueFromRemainingArguments=$true)]',
    '  [string[]]$ForwardArgs',
    ')',
    '$exitCode = 0',
    'try {',
    '  Remove-Item Env:TESSERA_CONTROL_DESCRIPTOR -ErrorAction SilentlyContinue',
    '  Remove-Item Env:TESSERA_CONTROL_DESCRIPTOR_PATH -ErrorAction SilentlyContinue',
    "  $env:TESSERA_ENV = '1'",
    `  $env:TESSERA_AGENT_ENVIRONMENT = ${quotePowerShell(context.agentEnvironment)}`,
    `  $env:TESSERA_PROJECT_ID = ${quotePowerShell(context.projectId)}`,
    `  $env:TESSERA_SESSION_ID = ${quotePowerShell(context.sessionId)}`,
    `  ${worktreeAssignment}`,
    '  if ([string]::IsNullOrEmpty($WslCwd)) {',
    '    Remove-Item Env:TESSERA_CLI_CWD -ErrorAction SilentlyContinue',
    '  } else {',
    '    $env:TESSERA_CLI_CWD = $WslCwd',
    '  }',
    '  if ([string]::IsNullOrEmpty($WslDistro)) {',
    '    Remove-Item Env:TESSERA_CLI_WSL_DISTRO -ErrorAction SilentlyContinue',
    '  } else {',
    '    $env:TESSERA_CLI_WSL_DISTRO = $WslDistro',
    '  }',
    "  $env:ELECTRON_RUN_AS_NODE = '1'",
    `  $cliArgs = @(${quotePowerShell(options.cliEntryPath)}, '--control-descriptor', ${quotePowerShell(options.descriptorPath)}) + @($ForwardArgs)`,
    `  & ${quotePowerShell(options.hostExecutablePath)} @cliArgs`,
    '  if ($null -eq $LASTEXITCODE) {',
    '    $exitCode = if ($?) { 0 } else { 1 }',
    '  } else {',
    '    $exitCode = $LASTEXITCODE',
    '  }',
    '} catch {',
    '  Write-Error $_',
    '  $exitCode = 1',
    '}',
    'exit $exitCode',
    '',
  ].join('\r\n');
}

function buildWindowsCommandLauncher(hostBridgePath: string): string {
  return [
    '@echo off',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${hostBridgePath.replace(/"/g, '""')}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function buildWslLauncher(hostBridgePath: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `TESSERA_HOST_BRIDGE=${quotePosix(hostBridgePath)}`,
    'if command -v powershell.exe >/dev/null 2>&1; then',
    '  TESSERA_POWERSHELL=powershell.exe',
    'elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then',
    '  TESSERA_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    'else',
    '  echo "The Tessera CLI bridge requires Windows interop." >&2',
    '  exit 1',
    'fi',
    'TESSERA_WSL_CWD=$(pwd -P 2>/dev/null) || { TESSERA_WSL_CWD=/; cd /; }',
    'TESSERA_WSL_CWD_WIN=$(wslpath -w "$TESSERA_WSL_CWD")',
    'exec "$TESSERA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$TESSERA_HOST_BRIDGE" -WslCwd "$TESSERA_WSL_CWD_WIN" -WslDistro "${WSL_DISTRO_NAME:-}" "$@"',
    '',
  ].join('\n');
}

function createDefaultWslExecutableStore(): WslExecutableStore {
  return {
    async create(contents): Promise<string> {
      const encoded = Buffer.from(contents, 'utf8').toString('base64');
      const script = [
        'set -eu',
        'base="${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/tessera/control-bridges"',
        'mkdir -p "$base"',
        'chmod 700 "$base"',
        'bridge_dir=$(mktemp -d "$base/bridge.XXXXXX")',
        `printf %s ${quotePosix(encoded)} | base64 -d > "$bridge_dir/tessera"`,
        'chmod 700 "$bridge_dir/tessera"',
        'printf %s "$bridge_dir/tessera"',
      ].join('; ');
      const { stdout } = await execFileAsync(
        'wsl.exe',
        ['-e', 'sh', '-c', script],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      const commandPath = stdout.trim();
      if (!commandPath.startsWith('/')) {
        throw new Error('The WSL Control CLI bridge path is unavailable.');
      }
      return commandPath;
    },

    async remove(commandPath): Promise<void> {
      await execFileAsync(
        'wsl.exe',
        [
          '-e', 'sh', '-c',
          'target=$1; rm -f -- "$target"; rmdir -- "$(dirname "$target")" 2>/dev/null || true',
          'sh', commandPath,
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
    },
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
