export const LOOPBACK_SERVER_HOST = '127.0.0.1';
export const REMOTE_SERVER_HOST = '0.0.0.0';

const REMOTE_CAPABLE_DESKTOP_PLATFORMS = new Set<NodeJS.Platform>([
  'win32',
  'darwin',
  'linux',
]);

/**
 * Only packaged desktop servers accept direct Tailscale connections. The
 * ordinary web/dev server and unpackaged Electron children stay on loopback.
 */
export function resolveElectronServerHost(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): string {
  return isPackaged && REMOTE_CAPABLE_DESKTOP_PLATFORMS.has(platform)
    ? REMOTE_SERVER_HOST
    : LOOPBACK_SERVER_HOST;
}
