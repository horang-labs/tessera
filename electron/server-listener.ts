export const LOOPBACK_SERVER_HOST = '127.0.0.1';
export const WINDOWS_REMOTE_SERVER_HOST = '0.0.0.0';

/**
 * The packaged Windows server accepts direct Tailscale connections. Other
 * desktop platforms keep the existing loopback-only behavior until their
 * firewall and packaging paths are explicitly supported.
 */
export function resolveElectronServerHost(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? WINDOWS_REMOTE_SERVER_HOST
    : LOOPBACK_SERVER_HOST;
}
