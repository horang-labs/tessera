import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE = 20;
export const TESSERA_FIREWALL_RULE_NAME = 'Tessera-Remote-Access-Tailscale';

export type TailscaleFirewallResult =
  | { ok: true }
  | {
      ok: false;
      code: 'unsupported' | 'server-not-ready' | 'tailscale-not-found' | 'cancelled' | 'failed';
      error: string;
    };

type PowerShellRunner = (args: string[]) => Promise<void>;

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Tessera server port is unavailable');
  }
}

export function buildTailscaleFirewallScript(port: number): string {
  assertValidPort(port);

  return [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    `$ruleName = '${TESSERA_FIREWALL_RULE_NAME}'`,
    "$displayName = 'Tessera Remote Access (Tailscale)'",
    '$tailscaleAdapters = @(',
    '  Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |',
    "    Where-Object { $_.Name -like '*Tailscale*' -or $_.InterfaceDescription -like '*Tailscale*' } |",
    '    ForEach-Object { $_.Name } |',
    '    Sort-Object -Unique',
    ')',
    `if ($tailscaleAdapters.Count -eq 0) { exit ${TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE} }`,
    'Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule',
    'New-NetFirewallRule `',
    '  -Name $ruleName `',
    '  -DisplayName $displayName `',
    "  -Group 'Tessera Remote Access' `",
    '  -Direction Inbound `',
    '  -Action Allow `',
    '  -Enabled True `',
    '  -Profile Any `',
    '  -Protocol TCP `',
    `  -LocalPort ${port} \``,
    '  -InterfaceAlias $tailscaleAdapters `',
    '  -EdgeTraversalPolicy Block | Out-Null',
  ].join('\n');
}

export function buildElevationCommand(encodedScript: string): string {
  return [
    "$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(",
    "  '-NoProfile',",
    "  '-NonInteractive',",
    "  '-ExecutionPolicy',",
    "  'Bypass',",
    "  '-EncodedCommand',",
    `  '${encodedScript}'`,
    ')',
    'if ($null -eq $process) { exit 1 }',
    'exit $process.ExitCode',
  ].join('\n');
}

async function runPowerShell(args: string[]): Promise<void> {
  await execFileAsync('powershell.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function processExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function configureTailscaleFirewall({
  port,
  platform = process.platform,
  runner = runPowerShell,
}: {
  port: number;
  platform?: NodeJS.Platform;
  runner?: PowerShellRunner;
}): Promise<TailscaleFirewallResult> {
  if (platform !== 'win32') {
    return {
      ok: false,
      code: 'unsupported',
      error: 'Windows Firewall configuration is only available on Windows',
    };
  }

  try {
    assertValidPort(port);
  } catch (error) {
    return { ok: false, code: 'server-not-ready', error: errorMessage(error) };
  }

  const script = buildTailscaleFirewallScript(port);
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const elevationCommand = buildElevationCommand(encodedScript);

  try {
    await runner([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      elevationCommand,
    ]);
    return { ok: true };
  } catch (error) {
    const exitCode = processExitCode(error);
    if (exitCode === TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE) {
      return {
        ok: false,
        code: 'tailscale-not-found',
        error: 'A Tailscale network adapter was not found',
      };
    }

    const message = errorMessage(error);
    if (/cancel|canceled|cancelled|1223/i.test(message)) {
      return { ok: false, code: 'cancelled', error: message };
    }
    return { ok: false, code: 'failed', error: message };
  }
}
