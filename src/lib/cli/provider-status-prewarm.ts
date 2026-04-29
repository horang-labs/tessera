import logger from '@/lib/logger';
import { SettingsManager } from '@/lib/settings/manager';
import { readUsersFile } from '@/lib/users';
import { cliProviderRegistry } from './providers/registry';

export function prewarmProviderStatusCache(source: string): void {
  void (async () => {
    try {
      const startedAt = Date.now();
      const users = await readUsersFile();
      const userId = users.users[0]?.id;

      if (!userId) {
        logger.info({ source }, 'Provider status cache prewarm skipped: no users');
        return;
      }

      const settings = await SettingsManager.load(userId, { silent: true });
      const providers = await cliProviderRegistry.refreshStatuses(settings.agentEnvironment);

      logger.info({
        source,
        userId,
        agentEnvironment: settings.agentEnvironment,
        providerCount: providers.length,
        durationMs: Date.now() - startedAt,
      }, 'Provider status cache prewarmed');
    } catch (error) {
      logger.warn({ source, error }, 'Provider status cache prewarm failed');
    }
  })();
}
