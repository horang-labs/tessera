import { issuePairingToken, rotatePairingToken } from './device-registry';
import { normalizeAdvertisedAddress } from './advertised-address';
import { loadMachineSettings } from '../settings/machine-settings';

export type PairingAction = 'issue' | 'rotate';

export interface PairingPresentation {
  pairingLink: string;
  createdAt: string;
  expiresAt: string;
}

export class PairingPresentationError extends Error {
  readonly code = 'address-required';

  constructor() {
    super('An advertised address is required before pairing');
    this.name = 'PairingPresentationError';
  }
}

function buildPairingLink(advertisedAddress: unknown, token: string): string {
  const address = normalizeAdvertisedAddress(advertisedAddress);
  if (!address) throw new PairingPresentationError();

  const pairingUrl = new URL('/pair', address.pairingBaseUrl);
  pairingUrl.hash = new URLSearchParams({ t: token }).toString();
  return pairingUrl.toString();
}

export async function createPairingPresentation(
  action: PairingAction,
): Promise<PairingPresentation> {
  const machineSettings = await loadMachineSettings();
  if (!machineSettings.advertisedAddress) throw new PairingPresentationError();

  const pairing = action === 'rotate'
    ? await rotatePairingToken()
    : await issuePairingToken();

  return {
    pairingLink: buildPairingLink(machineSettings.advertisedAddress, pairing.token),
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
  };
}
