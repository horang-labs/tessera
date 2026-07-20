import type { CliProvider } from '@/lib/cli/providers/types';
import logger from '@/lib/logger';
import type { TerminalProviderSessionIdentity } from './provider-session-identity';

export interface TerminalProviderSessionObservation {
  activation: 'active' | 'background';
  identity: TerminalProviderSessionIdentity;
}

export interface TerminalProviderSessionObserver {
  ready(): Promise<void>;
  dispose(): void;
}

const noopObserver = (): TerminalProviderSessionObserver => ({
  ready: async () => {},
  dispose: () => {},
});

/**
 * Provider-neutral bridge from an optional CLI-provider capability to
 * Tessera's shared session identity and reconciliation flow.
 */
export function createTerminalProviderSessionObserver(options: {
  provider: CliProvider;
  currentProviderSessionId: () => string | undefined;
  onObservation: (observation: TerminalProviderSessionObservation) => void;
}): TerminalProviderSessionObserver {
  const createObserver = options.provider.createTerminalSessionObserver;
  if (!createObserver) return noopObserver();
  let observer: TerminalProviderSessionObserver;
  try {
    observer = createObserver({
      currentProviderSessionId: options.currentProviderSessionId,
      onObservation: (observation) => options.onObservation({
        activation: observation.activation,
        identity: {
          providerId: options.provider.getProviderId(),
          providerSessionId: observation.providerSessionId,
          ...(observation.transcriptPath ? { transcriptPath: observation.transcriptPath } : {}),
        },
      }),
    });
  } catch (error) {
    logger.warn({ error, providerId: options.provider.getProviderId() },
      'Provider session observer could not start');
    return noopObserver();
  }
  return {
    ready: () => observer.ready(),
    dispose: () => observer.dispose(),
  };
}
