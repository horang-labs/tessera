import {
  createProviderLaunchModule,
  type ProviderLaunchModule,
} from './provider-launch-module';
import { observeTerminalProviderSession } from './provider-session-observation';
import { terminalManager } from './shared-terminal-manager';
import type { ControlCliBridgeFactory } from '@/lib/control/cli-bridge';

let sharedProviderLaunchModule: ProviderLaunchModule | null = null;
let controlCliBridgeFactory: ControlCliBridgeFactory | null = null;

export function configureSharedProviderControlCliBridge(
  factory: ControlCliBridgeFactory,
): () => Promise<void> {
  if (controlCliBridgeFactory && controlCliBridgeFactory !== factory) {
    throw new Error('The shared provider Control CLI bridge is already configured.');
  }
  controlCliBridgeFactory = factory;
  let released = false;
  let releaseInFlight: Promise<void> | null = null;
  return async () => {
    if (released) return;
    if (releaseInFlight) return releaseInFlight;
    if (controlCliBridgeFactory === factory) controlCliBridgeFactory = null;
    const release = Promise.resolve()
      .then(() => factory.dispose())
      .then(() => { released = true; });
    releaseInFlight = release;
    try {
      await release;
    } finally {
      if (releaseInFlight === release) releaseInFlight = null;
    }
  };
}

function getSharedProviderLaunchModule(): ProviderLaunchModule {
  sharedProviderLaunchModule ??= createProviderLaunchModule({
    terminalManager,
    observeProviderSession: (options) => {
      observeTerminalProviderSession(options);
    },
    prepareControlCliBridge: async (context) => {
      const factory = controlCliBridgeFactory;
      if (!factory) {
        throw new Error('The exact-instance Tessera CLI bridge is unavailable.');
      }
      return factory.create(context);
    },
  });
  return sharedProviderLaunchModule;
}

/** Production adapter that defers singleton wiring until the first launch. */
export const providerLaunchModule: ProviderLaunchModule = {
  supportsProvider: (providerId) => getSharedProviderLaunchModule().supportsProvider(providerId),
  launch: (request) => getSharedProviderLaunchModule().launch(request),
};
