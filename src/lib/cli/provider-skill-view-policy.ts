import type { ProviderSkillId, ProviderSkillStatus } from './provider-skill-management';

export const PROVIDER_SKILL_DISPLAY_NAMES: Record<ProviderSkillId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function shouldOfferProviderSkillOnboarding(status: ProviderSkillStatus): boolean {
  return status.detected
    && status.state === 'absent'
    && status.consent === 'not-granted'
    && status.ownership === 'none';
}

export function getProviderSkillActions(
  status: ProviderSkillStatus,
): { canInstall: boolean; canUpdate: boolean; canRemove: boolean } {
  const hasConsent = status.consent === 'granted';
  const isConflict = status.state === 'conflict' || status.state === 'unavailable';
  return {
    canInstall: status.detected
      && status.state === 'absent'
      && status.ownership === 'none'
      && !hasConsent,
    canUpdate: hasConsent && !isConflict,
    canRemove: hasConsent && (status.state === 'ready' || status.state === 'stale'),
  };
}
