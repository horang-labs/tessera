import type { ProviderModelOption, ProviderServiceTierOption } from '@/lib/cli/provider-session-option-types';

export const CODEX_FAST_COMMAND_NAME = 'fast';
export const CODEX_FAST_COMMAND = `/${CODEX_FAST_COMMAND_NAME}`;
export const CODEX_DEFAULT_SERVICE_TIER = 'default';
export const CODEX_FAST_BUILTIN_COMMAND = 'codex-fast';
export const CODEX_FAST_COMMAND_DESCRIPTION = 'Toggle Codex fast mode';

export function getCodexFastServiceTier(
  model: ProviderModelOption | null | undefined,
): ProviderServiceTierOption | null {
  return model?.serviceTiers?.find((tier) => tier.label.trim().toLowerCase() === 'fast') ?? null;
}

export function isCodexFastModeEnabled(
  configuredServiceTier: string | null | undefined,
  model: ProviderModelOption | null | undefined,
): boolean {
  const fastTier = getCodexFastServiceTier(model);
  if (!fastTier || configuredServiceTier === CODEX_DEFAULT_SERVICE_TIER) return false;
  if (configuredServiceTier == null) {
    return model?.defaultServiceTier === fastTier.value;
  }
  return configuredServiceTier === fastTier.value;
}

export function getCodexFastToggleServiceTier(
  configuredServiceTier: string | null | undefined,
  model: ProviderModelOption | null | undefined,
): string | null {
  const fastTier = getCodexFastServiceTier(model);
  if (!fastTier) return null;
  return isCodexFastModeEnabled(configuredServiceTier, model)
    ? CODEX_DEFAULT_SERVICE_TIER
    : fastTier.value;
}

/**
 * Preserve the configured preference, but never send a tier a selected model
 * does not advertise. `default` is Codex's explicit opt-out sentinel.
 */
export function resolveCodexServiceTierForModel(
  configuredServiceTier: string | null | undefined,
  model: ProviderModelOption | null | undefined,
): string | undefined {
  if (configuredServiceTier == null) return undefined;
  if (configuredServiceTier === CODEX_DEFAULT_SERVICE_TIER) {
    return CODEX_DEFAULT_SERVICE_TIER;
  }
  return model?.serviceTiers?.some((tier) => tier.value === configuredServiceTier)
    ? configuredServiceTier
    : CODEX_DEFAULT_SERVICE_TIER;
}

export interface CodexFastCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isCodexFastCommandSkill(skill: CodexFastCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CODEX_FAST_BUILTIN_COMMAND;
}
