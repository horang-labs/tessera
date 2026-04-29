import type { UserSettings } from '@/lib/settings/types';

export function hasHandledSetup(settings: Pick<UserSettings, 'setup'>): boolean {
  return Boolean(settings.setup.completedAt || settings.setup.dismissedAt);
}

export function getSetupEntryRoute(settings: Pick<UserSettings, 'setup'>): '/chat' | '/setup' {
  return hasHandledSetup(settings) ? '/chat' : '/setup';
}
