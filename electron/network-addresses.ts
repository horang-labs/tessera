import type { NetworkInterfaceInfo } from 'node:os';

export interface ExternalIpv4Address {
  interfaceName: string;
  address: string;
  isTailscale: boolean;
}

export interface RemoteAccessAddressCandidate extends ExternalIpv4Address {
  url: string;
}

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => (
    !/^\d{1,3}$/.test(parts[index])
    || !Number.isInteger(octet)
    || octet < 0
    || octet > 255
  ))) {
    return null;
  }
  return octets;
}

export function isTailscaleIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isAdvertisableIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) return false;
  return address !== '0.0.0.0' && octets[0] !== 127;
}

/**
 * Convert os.networkInterfaces() output into stable, safe advertised-address
 * choices while retaining the interface label shown to the user.
 */
export function collectExternalIpv4Addresses(
  interfaces: NetworkInterfaces,
): ExternalIpv4Address[] {
  const seenAddresses = new Set<string>();
  const addresses: ExternalIpv4Address[] = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (
        entry.internal
        || entry.family !== 'IPv4'
        || !isAdvertisableIpv4(entry.address)
        || seenAddresses.has(entry.address)
      ) {
        continue;
      }

      seenAddresses.add(entry.address);
      addresses.push({
        interfaceName,
        address: entry.address,
        isTailscale: isTailscaleIpv4(entry.address),
      });
    }
  }

  return addresses.sort((left, right) => Number(right.isTailscale) - Number(left.isTailscale));
}

export function buildRemoteAccessAddressCandidates(
  interfaces: NetworkInterfaces,
  port: number,
): RemoteAccessAddressCandidate[] {
  return collectExternalIpv4Addresses(interfaces).map((candidate) => ({
    ...candidate,
    url: `http://${candidate.address}:${port}`,
  }));
}
