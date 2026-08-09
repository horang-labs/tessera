import { getServerPort } from '../server-port';
import { loadOwnedMobileAccessOrigin } from '../mobile-access/mobile-access-state-store';

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
  const mobileAccessOrigin = await loadOwnedMobileAccessOrigin();
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  if (mobileAccessOrigin) {
    origins.add(mobileAccessOrigin);
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
    const url = new URL(input.origin);
    normalizedOrigin = (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
    ) ? url.origin : null;
  } catch {
    return false;
  }

  if (!normalizedOrigin) return false;
  return (await getAllowedOrigins()).has(normalizedOrigin);
}
