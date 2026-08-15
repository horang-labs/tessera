export const PAIRING_REQUEST_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'redeemed',
] as const;

export type PairingRequestStatus = typeof PAIRING_REQUEST_STATUSES[number];

export const PAIRING_DECISIONS = ['approve', 'deny'] as const;

export type PairingDecision = typeof PAIRING_DECISIONS[number];

export interface PairingRequest {
  id: string;
  name: string;
  browser: string;
  platform: string;
  remoteAddress: string;
  comparisonCode: string;
  createdAt: string;
  expiresAt: string;
  status: PairingRequestStatus;
}

export function isPairingDecision(value: unknown): value is PairingDecision {
  return value === 'approve' || value === 'deny';
}

export function isPairingRequest(value: unknown): value is PairingRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<PairingRequest>;
  return typeof request.id === 'string'
    && typeof request.name === 'string'
    && typeof request.browser === 'string'
    && typeof request.platform === 'string'
    && typeof request.remoteAddress === 'string'
    && typeof request.comparisonCode === 'string'
    && /^\d{6}$/.test(request.comparisonCode)
    && typeof request.createdAt === 'string'
    && Number.isFinite(Date.parse(request.createdAt))
    && typeof request.expiresAt === 'string'
    && Number.isFinite(Date.parse(request.expiresAt))
    && PAIRING_REQUEST_STATUSES.some((status) => status === request.status);
}
