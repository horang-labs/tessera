import { isRunningInWsl } from '@/lib/cli/cli-exec';
import { getRuntimePlatform } from './runtime-platform';
import type { ServerHostInfo } from './types';

interface GetServerHostInfoOptions {
  platform?: NodeJS.Platform;
  isWsl?: boolean;
}

export function getServerHostInfo(options: GetServerHostInfoOptions = {}): ServerHostInfo {
  const platform = options.platform ?? getRuntimePlatform();
  const isWsl = options.isWsl ?? isRunningInWsl();

  return {
    platform,
    isWindowsEcosystem: platform === 'win32' || isWsl,
  };
}
