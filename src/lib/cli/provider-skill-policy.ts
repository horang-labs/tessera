import { providerIntegration } from './provider-integration';
import type {
  ProviderSkillId,
  ProviderSkillManagementResult,
  ProviderSkillOperation,
} from './provider-skill-management';

export interface ProviderSkillGuiRequest {
  operation: ProviderSkillOperation;
  providerIds?: ProviderSkillId[];
}

export function manageProviderSkillsForUser(
  userId: string,
  request: ProviderSkillGuiRequest,
): Promise<ProviderSkillManagementResult> {
  return providerIntegration.manageSkills({
    ...request,
    agentEnvironmentOwner: { kind: 'user', userId },
  });
}
