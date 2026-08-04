import {
  createProviderLaunchModule,
  type ProviderLaunchModule,
} from './provider-launch-module';
import { observeTerminalProviderSession } from './provider-session-observation';
import { terminalManager } from './shared-terminal-manager';

let sharedProviderLaunchModule: ProviderLaunchModule | null = null;

function getSharedProviderLaunchModule(): ProviderLaunchModule {
  sharedProviderLaunchModule ??= createProviderLaunchModule({
    terminalManager,
    observeProviderSession: (options) => {
      observeTerminalProviderSession(options);
    },
  });
  return sharedProviderLaunchModule;
}

/** Production adapter that defers singleton wiring until the first launch. */
export const providerLaunchModule: ProviderLaunchModule = {
  supportsProvider: (providerId) => getSharedProviderLaunchModule().supportsProvider(providerId),
  launch: (request) => getSharedProviderLaunchModule().launch(request),
};
