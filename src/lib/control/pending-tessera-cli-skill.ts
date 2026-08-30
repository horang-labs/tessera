import type { SkillInfo } from '@/lib/cli/providers/skill-types';
import { readBundledTesseraControlSkillMetadata } from '@/lib/terminal/tessera-control-skill';

const SUPPORTED_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

export interface PendingTesseraCliSkillOptions {
  providerId?: string | null;
  enabled: boolean;
  hasProcess: boolean;
}

/**
 * Advertises the skill that will be injected when a fresh GUI session starts.
 * Running sessions stay authoritative because changing the setting does not
 * mutate an already-running provider process.
 */
export function prependPendingTesseraCliSkill(
  skills: SkillInfo[],
  options: PendingTesseraCliSkillOptions,
): SkillInfo[] {
  if (
    !options.enabled
    || options.hasProcess
    || !options.providerId
    || !SUPPORTED_PROVIDERS.has(options.providerId)
  ) {
    return skills;
  }

  const metadata = readBundledTesseraControlSkillMetadata();
  const name = options.providerId === 'claude-code'
    ? `tessera:${metadata.name}`
    : metadata.name;

  return [
    { name, description: metadata.description },
    ...skills.filter((skill) => skill.name !== name),
  ];
}
