export interface AdvertisedAddress {
  origin: string;
  pairingBaseUrl: string;
}

export class InvalidAdvertisedAddressError extends Error {
  constructor(message = 'Advertised address must be an absolute HTTP or HTTPS URL') {
    super(message);
    this.name = 'InvalidAdvertisedAddressError';
  }
}

/**
 * Convert the user-entered direct or tunneled URL into the single browser
 * origin that is safe to compare and use as the base of a pairing link.
 */
export function normalizeAdvertisedAddress(value: unknown): AdvertisedAddress | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidAdvertisedAddressError();
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidAdvertisedAddressError();
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || !url.hostname
    || url.username
    || url.password
  ) {
    throw new InvalidAdvertisedAddressError();
  }

  if (url.hostname === '0.0.0.0') {
    throw new InvalidAdvertisedAddressError(
      'Wildcard listener addresses cannot be advertised',
    );
  }

  return {
    origin: url.origin,
    pairingBaseUrl: url.origin,
  };
}
