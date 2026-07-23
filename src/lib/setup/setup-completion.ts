import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import type { SetupState, UserSettings } from '@/lib/settings/types';

interface BuildSetupCompletionSettingsInput {
  setup: SetupState;
  agentExecutionMode: AgentExecutionMode;
  isFullyReady: boolean;
  now: string;
}

export function buildSetupCompletionSettings({
  setup,
  agentExecutionMode,
  isFullyReady,
  now,
}: BuildSetupCompletionSettingsInput): Pick<UserSettings, 'agentExecutionMode' | 'setup'> {
  return {
    agentExecutionMode,
    setup: {
      ...setup,
      ...(isFullyReady ? { completedAt: now } : { dismissedAt: now }),
    },
  };
}

export function isSetupCompletionPersisted(
  settings: Pick<UserSettings, 'agentExecutionMode' | 'setup'>,
  expected: Pick<UserSettings, 'agentExecutionMode' | 'setup'>,
): boolean {
  return settings.agentExecutionMode === expected.agentExecutionMode
    && settings.setup.completedAt === expected.setup.completedAt
    && settings.setup.dismissedAt === expected.setup.dismissedAt;
}
