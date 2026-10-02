import type { ProviderModelOption } from '../cli/provider-session-option-types';

/** Frozen automation names differ from Codex's native nullable/priority names. */
export function automationServiceTier(provider: string, nativeTier: unknown, explicitDefault = false): 'default' | 'fast' | null | undefined {
  if (provider === 'claude-code') return nativeTier === null ? null : undefined;
  if (provider !== 'codex') return undefined;
  if (nativeTier === null) return explicitDefault ? 'default' : null;
  if (nativeTier === 'default') return 'default';
  if (nativeTier === 'priority' || nativeTier === 'fast') return 'fast';
  return undefined;
}

export function nativeAutomationServiceTier(provider: string, tier: 'default' | 'fast' | null): string | null {
  // Codex 0.159.2 protocol/config_types.rs: default is explicit standard routing,
  // whereas null inherits account/model configuration (including priority).
  return provider === 'codex' ? tier === 'fast' ? 'priority' : tier : null;
}

/** Default is Codex's standard-routing sentinel; Fast needs an offered priority capability. */
export function automationTierOptions(model: ProviderModelOption | undefined) {
  if (!model) return [];
  const priority = model.serviceTiers?.find(tier => tier.value === 'priority');
  return [{ value: 'default' as const, label: 'Default' }, ...(priority ? [{ value: 'fast' as const, label: priority.label }] : [])];
}
