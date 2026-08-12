import type { AgentEnvironment } from '@/lib/settings/types';
import type { ProviderSkillIntegrationResult } from './provider-integration';
import type { ProviderSkillId } from './provider-skill-management';

const ENDPOINT = '/api/provider-integrations/skills';

async function readProviderSkillResult(response: Response): Promise<ProviderSkillIntegrationResult> {
  const body = await response.json() as ProviderSkillIntegrationResult | { error?: unknown };
  if (!response.ok && !('providers' in body)) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `Provider skill request failed (${response.status}).`,
    );
  }
  return body as ProviderSkillIntegrationResult;
}

export function inspectProviderSkills(options: {
  providerId?: ProviderSkillId;
  all?: boolean;
}): Promise<ProviderSkillIntegrationResult> {
  const query = options.all
    ? 'all=1'
    : `provider=${encodeURIComponent(options.providerId ?? '')}`;
  return fetch(`${ENDPOINT}?${query}`, { cache: 'no-store' }).then(readProviderSkillResult);
}

export function mutateProviderSkill(options: {
  operation: 'install' | 'update' | 'remove';
  providerId: ProviderSkillId;
  expectedAgentEnvironment: AgentEnvironment;
}): Promise<ProviderSkillIntegrationResult> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: options.operation,
      providerIds: [options.providerId],
      expectedAgentEnvironment: options.expectedAgentEnvironment,
    }),
  }).then(readProviderSkillResult);
}
