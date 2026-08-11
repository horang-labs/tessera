import path from 'node:path';
import { execCli, type CliEnvironment } from '@/lib/cli/cli-exec';
import {
  isBridgedAgentEnvironment,
  isWindowsHostedWslFilesystemPath,
} from '@/lib/filesystem/path-environment';
import { buildWslFilesystemPathProbe } from '@/lib/filesystem/wsl-path-probe';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

export interface ProviderSkillHomeResolution {
  providerId: string;
  environment: CliEnvironment;
  windowsHostedWslExpression: string;
  resolveSharedFilesystemHome: () => Promise<string>;
}

/** Resolve and verify the provider-owned home without crossing Agent Environments. */
export async function resolveProviderOwnedSkillHome(
  options: ProviderSkillHomeResolution,
): Promise<string> {
  const home = options.environment === 'wsl' && getRuntimePlatform() === 'win32'
    ? await resolveWindowsHostedWslSkillHome(options)
    : await options.resolveSharedFilesystemHome();
  assertProviderSkillHomeOwnership(home, options.environment, options.providerId);
  return home;
}

async function resolveWindowsHostedWslSkillHome(
  options: ProviderSkillHomeResolution,
): Promise<string> {
  const result = await execCli(
    'sh',
    ['-c', buildWslFilesystemPathProbe(options.windowsHostedWslExpression)],
    'wsl',
    5_000,
  );
  const home = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!result.ok || !home) {
    throw new Error(
      `The WSL ${options.providerId} home could not be resolved. Verify the selected WSL `
      + 'distribution and its login shell, then retry; no native provider home was used.',
    );
  }
  return home;
}

function assertProviderSkillHomeOwnership(
  home: string,
  environment: CliEnvironment,
  providerId: string,
): void {
  if (!path.isAbsolute(home)) {
    throw new Error(`The ${providerId} home is not an absolute path in the selected Agent Environment.`);
  }
  if (!isBridgedAgentEnvironment(environment)) return;

  const owned = environment === 'wsl'
    ? isWindowsHostedWslFilesystemPath(home)
    : /^\/mnt\/[a-zA-Z](?:\/|$)/.test(home.replaceAll('\\', '/'))
      || /^[a-zA-Z]:[\\/]/.test(home);
  if (!owned) {
    throw new Error(
      `The resolved ${providerId} home belongs to the opposite Agent Environment. `
      + 'No provider home was modified.',
    );
  }
}
