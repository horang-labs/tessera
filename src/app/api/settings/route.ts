import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { SettingsManager } from '@/lib/settings/manager';
import type { UserSettings } from '@/lib/settings/types';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import {
  requiresArchivedWorktreeRetentionConfirmation,
  shouldPruneArchivedWorktreesForSettingsUpdate,
} from '@/lib/settings/archived-worktree-retention';
import { configureArchivedWorktreeRetention } from '@/lib/archive/archive-retention-runner';
import { invalidateAgentEnvironmentCache } from '@/lib/cli/spawn-cli';
import { invalidateCliStatusSnapshot } from '@/lib/cli/connection-checker';
import { invalidateProviderSessionOptionsCache } from '@/lib/cli/provider-session-options';
import { invalidateTerminalProviderDetection } from '@/lib/terminal/provider-detection';
import { getServerHostInfo } from '@/lib/system/server-host';
import {
  InvalidAdvertisedAddressError,
  normalizeAdvertisedAddress,
} from '@/lib/auth/advertised-address';
import {
  loadMachineSettings,
  saveMachineSettings,
  type MachineSettings,
} from '@/lib/settings/machine-settings';
import { directListeners } from '@/lib/http/direct-listeners';
import logger from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }
    const { userId } = auth;

    const [settings, machineSettings] = await Promise.all([
      SettingsManager.load(userId),
      loadMachineSettings(),
    ]);

    return NextResponse.json({ settings, machineSettings, serverHostInfo: getServerHostInfo() });
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
    const body = await request.json() as Partial<UserSettings> & {
      confirmArchivedWorktreePrune?: unknown;
      machineSettings?: unknown;
    };
    const {
      confirmArchivedWorktreePrune,
      machineSettings: requestedMachineSettingsUpdate,
      ...settingsBody
    } = body;
    // A paired device keeps full access to ordinary settings, but it must not
    // be able to remove the address it depends on to get back into Tessera.
    const machineSettingsUpdate = auth.kind === 'device'
      ? undefined
      : requestedMachineSettingsUpdate;

    if (
      machineSettingsUpdate !== undefined
      && (
        !machineSettingsUpdate
        || typeof machineSettingsUpdate !== 'object'
        || Array.isArray(machineSettingsUpdate)
      )
    ) {
      throw new InvalidAdvertisedAddressError('Machine settings must be an object');
    }
    const hasAdvertisedAddressUpdate = machineSettingsUpdate !== undefined
      && Object.prototype.hasOwnProperty.call(machineSettingsUpdate, 'advertisedAddress');
    const advertisedAddressUpdate = hasAdvertisedAddressUpdate
      ? normalizeAdvertisedAddress(
          (machineSettingsUpdate as Partial<MachineSettings>).advertisedAddress,
        )?.pairingBaseUrl ?? null
      : undefined;
    let machineSettings = await loadMachineSettings();

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
    if (hasAdvertisedAddressUpdate) {
      machineSettings = await saveMachineSettings({
        advertisedAddress: advertisedAddressUpdate,
      });
      // Bind or release the direct listener right away, so turning remote
      // access on or off takes effect without restarting the app.
      await directListeners.sync();
    }
    invalidateAgentEnvironmentCache(userId);
    // Settings changes can flip which providers are reachable; the next
    // list_providers/check_cli_status should probe fresh.
    invalidateCliStatusSnapshot();
    const agentEnvironmentChanged = previousSettings.agentEnvironment !== settings.agentEnvironment;
    const providerCustomModelsChanged = JSON.stringify(previousSettings.providerCustomModels)
      !== JSON.stringify(settings.providerCustomModels);
    if (agentEnvironmentChanged || providerCustomModelsChanged) {
      invalidateProviderSessionOptionsCache(userId);
    }
    if (agentEnvironmentChanged) {
      // PTY 감지 캐시는 환경(native/wsl)별 PATH 세계라 환경 전환 시 재프로브.
      invalidateTerminalProviderDetection();
    }
    configureArchivedWorktreeRetention(
      settings.autoDeleteArchivedWorktrees
        ? { retentionDays: settings.archivedWorktreeRetentionDays, userId }
        : null,
      {
        runImmediately: shouldPruneArchivedWorktreesForSettingsUpdate(previousSettings, settings),
      },
    );
    return NextResponse.json({ success: true, settings, machineSettings });
  } catch (error) {
    if (error instanceof InvalidAdvertisedAddressError) {
      return NextResponse.json(
        { error: error.message, code: 'invalid_advertised_address' },
        { status: 400 },
      );
    }
    logger.error({ error }, 'PUT /api/settings error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
