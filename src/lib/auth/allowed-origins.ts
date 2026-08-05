import { getServerPort } from '../server-port';
import { loadMachineSettings } from '../settings/machine-settings';
import { normalizeAdvertisedAddress } from './advertised-address';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresOriginCheck(input: {
  purpose: 'http' | 'ws-upgrade';
  method: string;
}): boolean {
  return input.purpose === 'ws-upgrade'
    || !SAFE_HTTP_METHODS.has(input.method.trim().toUpperCase());
}

export async function getAllowedOrigins(): Promise<Set<string>> {
  const port = getServerPort();
  const machineSettings = await loadMachineSettings();
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  if (machineSettings.advertisedAddress) {
    origins.add(machineSettings.advertisedAddress);
  }

  return origins;
}

export async function isOriginAllowed(input: {
  purpose: 'http' | 'ws-upgrade';
  method: string;
  origin: string;
}): Promise<boolean> {
  if (!requiresOriginCheck(input)) return true;

  let normalizedOrigin: string | null;
  try {
    normalizedOrigin = normalizeAdvertisedAddress(input.origin)?.origin ?? null;
  } catch {
    return false;
  }

  if (!normalizedOrigin) return false;
  return (await getAllowedOrigins()).has(normalizedOrigin);
}
