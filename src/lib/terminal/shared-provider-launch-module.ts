import {
  createProviderLaunchModule,
  type ProviderLaunchModule,
} from './provider-launch-module';
import { observeTerminalProviderSession } from './provider-session-observation';
import { terminalManager } from './shared-terminal-manager';
import type { ControlCliBridgeFactory } from '@/lib/control/cli-bridge';
import {
  configureSharedControlCliBridge,
  prepareSharedControlCliBridge,
} from '@/lib/control/shared-cli-bridge';
import { SettingsManager } from '@/lib/settings/manager';

let sharedProviderLaunchModule: ProviderLaunchModule | null = null;

export function configureSharedProviderControlCliBridge(
  factory: ControlCliBridgeFactory,
): () => Promise<void> {
  return configureSharedControlCliBridge(factory);
}

function getSharedProviderLaunchModule(): ProviderLaunchModule {
  sharedProviderLaunchModule ??= createProviderLaunchModule({
    terminalManager,
    observeProviderSession: (options) => {
      observeTerminalProviderSession(options);
    },
    prepareControlCliBridge: async (context) => {
      return prepareSharedControlCliBridge(context);
    },
    resolveTesseraCliEnabled: async (userId) => (
      await SettingsManager.load(userId, { silent: true })
    ).tesseraCliEnabled,
  });
  return sharedProviderLaunchModule;
}

/** Production adapter that defers singleton wiring until the first launch. */
export const providerLaunchModule: ProviderLaunchModule = {
  supportsProvider: (providerId) => getSharedProviderLaunchModule().supportsProvider(providerId),
  launch: (request) => getSharedProviderLaunchModule().launch(request),
};
