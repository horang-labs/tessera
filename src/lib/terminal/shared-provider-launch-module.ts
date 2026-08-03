import { createProviderLaunchModule } from './provider-launch-module';
import { observeTerminalProviderSession } from './provider-session-observation';
import { terminalManager } from './shared-terminal-manager';

/** Production adapter for the process-wide TerminalManager. */
export const providerLaunchModule = createProviderLaunchModule({
  terminalManager,
  observeProviderSession: (options) => {
    observeTerminalProviderSession(options);
  },
});
