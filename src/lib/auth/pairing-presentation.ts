import { issuePairingToken, rotatePairingToken } from './device-registry';
import { loadOwnedMobileAccessOrigin } from '../mobile-access/mobile-access-state-store';

export type PairingAction = 'issue' | 'rotate';

export interface PairingPresentation {
  pairingLink: string;
  createdAt: string;
  expiresAt: string;
}

export class PairingPresentationError extends Error {
  readonly code = 'mobile-access-required';

  constructor() {
    super('Mobile Connection Setup must be ready before pairing');
    this.name = 'PairingPresentationError';
  }
}

function buildPairingLink(origin: string, token: string): string {
  const pairingUrl = new URL('/pair', origin);
  pairingUrl.hash = new URLSearchParams({ t: token }).toString();
  return pairingUrl.toString();
}

export async function createPairingPresentation(
  action: PairingAction,
): Promise<PairingPresentation> {
  const mobileAccessOrigin = await loadOwnedMobileAccessOrigin();
  if (!mobileAccessOrigin) throw new PairingPresentationError();

  const pairing = action === 'rotate'
    ? await rotatePairingToken()
    : await issuePairingToken();

  return {
    pairingLink: buildPairingLink(mobileAccessOrigin, pairing.token),
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
  };
}
