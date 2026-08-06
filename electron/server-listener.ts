import type { NetworkInterfaceInfo } from 'node:os';

import type { DirectListenerTarget } from '../src/lib/http/direct-listeners';
import { collectExternalIpv4Addresses } from './network-addresses';

export const LOOPBACK_SERVER_HOST = '127.0.0.1';

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const REMOTE_CAPABLE_DESKTOP_PLATFORMS = new Set<NodeJS.Platform>([
  'win32',
  'darwin',
  'linux',
]);

/**
 * Only packaged desktop servers may take a second, non-loopback listener. The
 * ordinary web/dev server and unpackaged Electron children stay on loopback.
 */
function supportsDirectRemoteListener(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): boolean {
  return isPackaged && REMOTE_CAPABLE_DESKTOP_PLATFORMS.has(platform);
}

function advertisedHostname(advertisedAddress: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(advertisedAddress).hostname;
  } catch {
    return null;
  }
  // URL wraps IPv6 literals in brackets; interface addresses never carry them.
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * The single non-loopback address this machine is allowed to listen on.
 *
 * Binding the wildcard address opens the port on every adapter, including the
 * Public-profile Ethernet one, which is what makes Windows Defender prompt on
 * each launch. So a direct listener is added only for an address the user has
 * actually advertised, and only when that address belongs to a live interface
 * — a tunnelled or DNS advertised address stays on loopback, which is where
 * its local tunnel client connects anyway.
 */
export function resolveDirectListenerHost(
  advertisedAddress: string | null | undefined,
  interfaces: NetworkInterfaces,
): string | null {
  if (!advertisedAddress) return null;

  const hostname = advertisedHostname(advertisedAddress);
  if (!hostname) return null;

  // collectExternalIpv4Addresses already drops loopback and wildcard entries,
  // so neither can be promoted into a direct listener here.
  const match = collectExternalIpv4Addresses(interfaces)
    .find((candidate) => candidate.address === hostname);
  return match?.address ?? null;
}

/**
 * Whether the packaged Electron server should carry a direct listener beside
 * its loopback one, and whether it should keep looking for the address.
 */
export function resolveDirectListenerTarget({
  platform,
  isPackaged,
  advertisedAddress,
  interfaces,
}: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  advertisedAddress: string | null | undefined;
  interfaces: NetworkInterfaces;
}): DirectListenerTarget {
  if (!supportsDirectRemoteListener(platform, isPackaged) || !advertisedAddress) {
    return { host: null, pending: false };
  }

  // Pending covers Tailscale that has not finished starting: remote access is
  // configured, so keep retrying instead of settling for loopback forever.
  const host = resolveDirectListenerHost(advertisedAddress, interfaces);
  return { host, pending: host === null };
}
