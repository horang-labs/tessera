import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { SettingsManager } from '@/lib/settings/manager';
import type { UserSettings } from '@/lib/settings/types';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import {
  requiresArchivedWorktreeRetentionConfirmation,
  shouldPruneArchivedWorktreesForSettingsUpdate,
} from '@/lib/settings/archived-worktree-retention';
import { invalidateAgentEnvironmentCache } from '@/lib/cli/spawn-cli';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { invalidateProviderSessionOptionsCache } from '@/lib/cli/provider-session-options';
import { pruneExpiredArchivedWorktrees } from '@/lib/archive/archive-service';
import { getServerHostInfo } from '@/lib/system/server-host';
import logger from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;

    const settings = await SettingsManager.load(userId);

    return NextResponse.json({ settings, serverHostInfo: getServerHostInfo() });
  } catch (error) {
    logger.error({ error }, 'GET /api/settings error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;

    const previousSettings = await SettingsManager.load(userId, { silent: true });
    const body = await request.json() as Partial<UserSettings> & { confirmArchivedWorktreePrune?: unknown };
    const {
      confirmArchivedWorktreePrune,
      ...settingsBody
    } = body;

    const settings = normalizeUserSettings({
      ...previousSettings,
      ...settingsBody,
      lastModified: new Date().toISOString(),
    });

    const requiresRetentionConfirmation = requiresArchivedWorktreeRetentionConfirmation(
      previousSettings,
      settings,
    );
    if (requiresRetentionConfirmation && confirmArchivedWorktreePrune !== true) {
      return NextResponse.json(
        {
          error: 'Archived worktree retention confirmation required',
          code: 'archived_worktree_retention_confirmation_required',
        },
        { status: 409 },
      );
    }

    await SettingsManager.save(userId, settings);
    invalidateAgentEnvironmentCache(userId);
    // agentEnvironment change can flip which providers are reachable; drop
    // every cached status so the next list_providers probes fresh.
    cliProviderRegistry.invalidateStatusCache();
    if (previousSettings.agentEnvironment !== settings.agentEnvironment) {
      invalidateProviderSessionOptionsCache(userId);
    }
    if (shouldPruneArchivedWorktreesForSettingsUpdate(previousSettings, settings)) {
      await pruneExpiredArchivedWorktrees(settings.archivedWorktreeRetentionDays);
    }

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    logger.error({ error }, 'PUT /api/settings error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
