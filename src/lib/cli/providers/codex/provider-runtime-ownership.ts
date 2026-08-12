import { execCli, isRunningInWsl, type CliEnvironment, type ExecResult } from '@/lib/cli/cli-exec';
import { ProviderSessionResumeUnavailableError } from '@/lib/cli/provider-session-resume';
import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

export interface ProviderRuntimeOwnershipDependencies {
  exec?: typeof execCli;
  runtimePlatform?: () => NodeJS.Platform;
  runningInWsl?: () => boolean;
  formatForAgent?: typeof formatPathForAgentDisplay;
  pollIntervalMs?: number;
}

const LINUX_OPEN_FILE_SCRIPT = String.raw`
target=$(readlink -f -- "$1") || exit 20
count=0
for process in /proc/[0-9]*; do
  for fd in "$process"/fd/*; do
    opened=$(readlink -f -- "$fd" 2>/dev/null) || continue
    if [ "$opened" = "$target" ]; then
      count=$((count + 1))
      break
    fi
  done
done
printf '%s\n' "$count"
`.trim();

const WINDOWS_OPEN_FILE_SCRIPT = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;
public static class TesseraRestartManager {
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, IntPtr appInfo, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint handle, out uint needed, ref uint count, IntPtr processInfo, ref uint reasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint handle);
}
'@
Add-Type -TypeDefinition $source
$handle = 0
$key = [Guid]::NewGuid().ToString('N')
if ([TesseraRestartManager]::RmStartSession([ref]$handle, 0, $key) -ne 0) { exit 20 }
try {
  if ([TesseraRestartManager]::RmRegisterResources($handle, 1, @($args[0]), 0, [IntPtr]::Zero, 0, $null) -ne 0) { exit 20 }
  $needed = 0
  $count = 0
  $reasons = 0
  $result = [TesseraRestartManager]::RmGetList($handle, [ref]$needed, [ref]$count, [IntPtr]::Zero, [ref]$reasons)
  if (($result -eq 234) -and ($needed -gt 0)) { Write-Output $needed; exit 0 }
  if ($result -ne 0) { exit 20 }
  Write-Output 0
  exit 0
} finally {
  [TesseraRestartManager]::RmEndSession($handle) | Out-Null
}
`.trim();

function interpretOwnerCount(result: ExecResult): number {
  if (result.ok) {
    const count = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  throw new Error(`Codex runtime ownership could not be inspected: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

/**
 * Ordinary Codex keeps the active rollout open for the lifetime of its runtime.
 * Query that provider-owned OS handle without creating any Tessera artifact in
 * the provider home. The check runs inside the Agent Environment so WSL `/proc`
 * and native Windows Restart Manager see the same processes as Codex.
 */
export async function countCodexRolloutRuntimeOwners(
  rolloutFilesystemPath: string,
  environment: CliEnvironment,
  dependencies: ProviderRuntimeOwnershipDependencies = {},
): Promise<number> {
  const execute = dependencies.exec ?? execCli;
  const runtimePlatform = dependencies.runtimePlatform ?? getRuntimePlatform;
  const runningInWsl = dependencies.runningInWsl ?? isRunningInWsl;
  const rolloutAgentPath = (dependencies.formatForAgent ?? formatPathForAgentDisplay)(
    rolloutFilesystemPath,
    environment,
  );
  const nativeWindows = environment === 'native'
    && (runtimePlatform() === 'win32' || runningInWsl());

  if (nativeWindows) {
    return interpretOwnerCount(await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OPEN_FILE_SCRIPT, rolloutAgentPath],
      environment,
      10_000,
    ));
  }

  if (runtimePlatform() === 'darwin') {
    const result = await execute('lsof', ['-t', '--', rolloutAgentPath], environment, 5_000);
    if (result.exitCode === 1) return 0;
    if (result.ok) {
      return new Set(result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)).size;
    }
    return interpretOwnerCount(result);
  }

  return interpretOwnerCount(await execute(
    'sh',
    ['-c', LINUX_OPEN_FILE_SCRIPT, 'tessera-codex-runtime-probe', rolloutAgentPath],
    environment,
    5_000,
    { loginShell: false },
  ));
}

export async function isCodexRolloutOpenByAnotherRuntime(
  rolloutFilesystemPath: string,
  environment: CliEnvironment,
  dependencies: ProviderRuntimeOwnershipDependencies = {},
): Promise<boolean> {
  return await countCodexRolloutRuntimeOwners(
    rolloutFilesystemPath,
    environment,
    dependencies,
  ) > 0;
}

/** Watch the provider-owned rollout for a second process until the managed runtime exits. */
export async function watchCodexRolloutRuntimeOwners(
  rolloutFilesystemPath: string,
  environment: CliEnvironment,
  onConflict: (message: string) => void,
  dependencies: ProviderRuntimeOwnershipDependencies = {},
): Promise<() => void> {
  const inspect = () => countCodexRolloutRuntimeOwners(
    rolloutFilesystemPath,
    environment,
    dependencies,
  );
  if (await inspect() > 1) {
    throw new ProviderSessionResumeUnavailableError(
      'provider-session-already-running',
      'This provider conversation became active in another runtime during launch. Fork it to work in parallel.',
    );
  }

  let disposed = false;
  let polling = false;
  const timer = setInterval(() => {
    if (disposed || polling) return;
    polling = true;
    void inspect().then((owners) => {
      if (disposed || owners <= 1) return;
      disposed = true;
      clearInterval(timer);
      onConflict('This provider conversation was opened by another runtime. Tessera stopped its managed runtime; fork it to work in parallel.');
    }).catch((error) => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      onConflict(`Provider runtime ownership could no longer be inspected safely: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      polling = false;
    });
  }, dependencies.pollIntervalMs ?? 1_000);
  timer.unref?.();

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
