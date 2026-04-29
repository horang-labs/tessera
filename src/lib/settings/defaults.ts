import { UserSettings } from './types';
import { normalizeUserSettings } from './provider-defaults';

export const DEFAULT_SETTINGS: UserSettings = normalizeUserSettings({
  agentEnvironment: 'native',
  lastModified: new Date().toISOString(),
});
