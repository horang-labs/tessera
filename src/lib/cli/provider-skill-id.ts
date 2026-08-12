import providerSkillManifest from '../../../bin/provider-skill-ids.json';

export type ProviderSkillId = keyof typeof providerSkillManifest;

export const PROVIDER_SKILL_IDS: readonly ProviderSkillId[] = Object.keys(
  providerSkillManifest,
) as ProviderSkillId[];

export function isProviderSkillId(providerId: string): providerId is ProviderSkillId {
  return (PROVIDER_SKILL_IDS as readonly string[]).includes(providerId);
}
