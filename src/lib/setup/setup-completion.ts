import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import type { SetupState, UserSettings } from '@/lib/settings/types';

interface BuildSetupCompletionSettingsInput {
  setup: SetupState;
  agentExecutionMode: AgentExecutionMode;
  tesseraCliEnabled: boolean;
  isFullyReady: boolean;
  now: string;
}

export function buildSetupCompletionSettings({
  setup,
  agentExecutionMode,
  tesseraCliEnabled,
  isFullyReady,
  now,
}: BuildSetupCompletionSettingsInput): Pick<
  UserSettings,
  'agentExecutionMode' | 'tesseraCliEnabled' | 'setup'
> {
  return {
    agentExecutionMode,
    tesseraCliEnabled,
    setup: {
      ...setup,
      ...(isFullyReady ? { completedAt: now } : { dismissedAt: now }),
    },
  };
}

export function isSetupCompletionPersisted(
  settings: Pick<UserSettings, 'agentExecutionMode' | 'tesseraCliEnabled' | 'setup'>,
  expected: Pick<UserSettings, 'agentExecutionMode' | 'tesseraCliEnabled' | 'setup'>,
): boolean {
  return settings.agentExecutionMode === expected.agentExecutionMode
    && settings.tesseraCliEnabled === expected.tesseraCliEnabled
    && settings.setup.completedAt === expected.setup.completedAt
    && settings.setup.dismissedAt === expected.setup.dismissedAt;
}
