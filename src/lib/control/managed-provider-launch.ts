import * as dbSessions from '@/lib/db/sessions';
import { SettingsManager } from '@/lib/settings/manager';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import {
  createManagedSkillOverlay,
  createManagedSkillOverlayInWsl,
  type ManagedSkillOverlay,
} from './managed-skill-overlay';
import { prepareSharedControlCliBridge } from './shared-cli-bridge';
import type { ManagedCliLaunch } from '@/lib/cli/providers/session-types';

const MANAGED_ENV_KEYS = [
  'TESSERA_ENV',
  'TESSERA_CLI_COMMAND',
  'TESSERA_PROJECT_ID',
  'TESSERA_SESSION_ID',
  'TESSERA_WORKTREE_ID',
  'TESSERA_CONTROL_DESCRIPTOR',
  'TESSERA_CONTROL_DESCRIPTOR_PATH',
  'TESSERA_CLI_CWD',
  'TESSERA_AGENT_ENVIRONMENT',
  'TESSERA_PANE_TOKEN',
  'TESSERA_HOOK_PORT',
  'TESSERA_OPENCODE_CONFIG_DIR',
] as const;

export interface ManagedProviderLaunchResources {
  managedLaunch: ManagedCliLaunch;
  dispose(): Promise<void>;
}

export async function prepareManagedProviderLaunchResources(options: {
  sessionId: string;
  userId: string;
}): Promise<ManagedProviderLaunchResources> {
  const environment = Object.fromEntries(
    MANAGED_ENV_KEYS.map((key) => [key, undefined]),
  ) as Record<string, string | undefined>;
  const settings = await SettingsManager.load(options.userId, { silent: true });
  if (!settings.tesseraCliEnabled) {
    return emptyResources(environment);
  }

  const callerContext = dbSessions.getManagedSessionCallerContext(options.sessionId);
  if (!callerContext) {
    throw new Error('The managed Session caller context is unavailable.');
  }
  const agentEnvironment = settings.agentEnvironment;
  const bridge = await prepareSharedControlCliBridge({
    agentEnvironment,
    projectId: callerContext.projectId,
    sessionId: options.sessionId,
    ...(callerContext.worktreeId ? { worktreeId: callerContext.worktreeId } : {}),
  });

  let overlay: ManagedSkillOverlay | undefined;
  try {
    overlay = getRuntimePlatform() === 'win32' && agentEnvironment === 'wsl'
      ? await createManagedSkillOverlayInWsl(options.sessionId)
      : createManagedSkillOverlay(options.sessionId);
  } catch (error) {
    await bridge.dispose().catch(() => undefined);
    throw error;
  }

  Object.assign(environment, bridge.environment);
  if (!callerContext.worktreeId) environment.TESSERA_WORKTREE_ID = undefined;
  const guestEnvironment = { ...environment };

  let disposed = false;
  return {
    managedLaunch: {
      environment,
      guestEnvironment,
      skillOverlay: {
        rootDir: overlay.rootDir,
        skillsDir: overlay.skillsDir,
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const results = await Promise.allSettled([overlay.dispose(), bridge.dispose()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}

function emptyResources(
  environment: Record<string, string | undefined>,
): ManagedProviderLaunchResources {
  return {
    managedLaunch: {
      environment,
      guestEnvironment: { ...environment },
    },
    async dispose() {},
  };
}
