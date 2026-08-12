import type { ProviderIntegrationLaunchDecision } from './provider-integration';

export function getCodexLifecycleActions(
  decision: ProviderIntegrationLaunchDecision | null,
): { canInstall: boolean; canUpdate: boolean; canRemove: boolean } {
  const hasConsent = decision?.lifecycle.consent === 'granted';
  return {
    canInstall: !hasConsent,
    canUpdate: hasConsent,
    canRemove: hasConsent,
  };
}
