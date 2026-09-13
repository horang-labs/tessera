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

  // Concurrent worktree dev servers share machine settings. Keep each explicit
  // browser origin process-local so configuring one port cannot disconnect another.
  // Also support an explicitly opted-out local production-mode preview.
  if ((process.env.NODE_ENV === 'development' || process.env.TESSERA_PRODUCTION_DB === '0')
    && process.env.TESSERA_DEV_ORIGIN) {
    try {
      const devAddress = normalizeAdvertisedAddress(process.env.TESSERA_DEV_ORIGIN);
      if (devAddress) origins.add(devAddress.origin);
    } catch {
      // An invalid development override must not expand the allowlist.
    }
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
