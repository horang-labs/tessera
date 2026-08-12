import { providerIntegration } from './provider-integration';
import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  ProviderSkillId,
  ProviderSkillOperation,
} from './provider-skill-management';
import type { ProviderSkillIntegrationResult } from './provider-integration';

export interface ProviderSkillGuiRequest {
  operation: ProviderSkillOperation;
  providerIds?: ProviderSkillId[];
  expectedAgentEnvironment?: AgentEnvironment;
}

export function manageProviderSkillsForUser(
  userId: string,
  request: ProviderSkillGuiRequest,
): Promise<ProviderSkillIntegrationResult> {
  return providerIntegration.manageSkills({
    ...request,
    agentEnvironmentOwner: { kind: 'user', userId },
  });
}
