import { isRunningInWsl } from '@/lib/cli/cli-exec';
import { getRuntimePlatform } from './runtime-platform';
import type { ServerHostInfo } from './types';
import packageJson from '../../../package.json';

interface GetServerHostInfoOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  isWsl?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function getServerHostInfo(options: GetServerHostInfoOptions = {}): ServerHostInfo {
  const platform = options.platform ?? getRuntimePlatform();
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const isWsl = options.isWsl ?? isRunningInWsl();
  const channel = resolveInstallChannel(env);

  return {
    platform,
    arch,
    appVersion: packageJson.version,
    channel,
    telemetryDisabledByEnv: isTelemetryDisabledByEnv(env, channel),
    isWindowsEcosystem: platform === 'win32' || isWsl,
  };
}

function resolveInstallChannel(env: NodeJS.ProcessEnv): string {
  const explicit = env.TESSERA_CHANNEL?.trim();
  if (explicit) return explicit;
  if (env.TESSERA_ELECTRON_SERVER === '1') return env.NODE_ENV === 'development' ? 'dev' : 'github-release';
  if (env.TESSERA_CLI === '1') return 'npm';
  if (env.NODE_ENV === 'development') return 'dev';
  return 'unknown';
}

function isTelemetryDisabledByEnv(env: NodeJS.ProcessEnv, channel: string): boolean {
  if (
    env.TESSERA_TELEMETRY_DISABLED === '1'
    || env.DO_NOT_TRACK === '1'
    || Boolean(env.TESSERA_ELECTRON_TEST_INSTANCE?.trim())
  ) {
    return true;
  }

  if ((channel === 'dev' || channel === 'unknown') && env.TESSERA_TELEMETRY_LOCAL !== '1') {
    return true;
  }

  return false;
}
