import { resolveServerDefaultUserId } from '@/lib/server-default-user';
import { SettingsManager } from '@/lib/settings/manager';
import logger from '@/lib/logger';
import { configureArchivedWorktreeRetention } from './archive-retention-runner';

/** Called after HTTP readiness by both web and packaged Electron servers. */
export async function startArchivedWorktreeRetention(): Promise<void> {
  try {
    const userId = await resolveServerDefaultUserId();
    if (!userId) return;
    const settings = await SettingsManager.load(userId, { strict: true });
    configureArchivedWorktreeRetention(settings.autoDeleteArchivedWorktrees
      ? { userId, retentionDays: settings.archivedWorktreeRetentionDays }
      : null);
  } catch (error) {
    logger.error({ error }, 'Failed to initialize archived Worktree retention');
  }
}
