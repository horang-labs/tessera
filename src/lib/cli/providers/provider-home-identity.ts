declare const providerHomeIdentityBrand: unique symbol;

/** Opaque, provider-owned identity for one authoritative provider home. */
export type ProviderHomeIdentity = string & {
  readonly [providerHomeIdentityBrand]: 'ProviderHomeIdentity';
};

export function asProviderHomeIdentity(value: string): ProviderHomeIdentity {
  const normalized = value.trim();
  if (!normalized) throw new Error('Provider home identity is required');
  return normalized as ProviderHomeIdentity;
}
