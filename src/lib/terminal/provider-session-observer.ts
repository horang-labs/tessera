import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import type { CliProvider } from '@/lib/cli/providers/types';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import logger from '@/lib/logger';
import type { TerminalProviderSessionIdentity } from './provider-session-identity';

export interface TerminalProviderSessionObservation {
  activation: 'active' | 'background';
  identity: TerminalProviderSessionIdentity;
  /** The provider proved this identity descends from the managed conversation. */
  allowCreate: true;
  /** Where the observed conversation runs, as a path this server can open. */
  workDir?: string;
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
  /** Whose CLI this is. Decides which filesystem the observed paths belong to. */
  userId?: string;
}): TerminalProviderSessionObserver {
  const createObserver = options.provider.createTerminalSessionObserver;
  if (!createObserver) return noopObserver();

  const emit = async (observation: {
    activation: 'active' | 'background';
    providerSessionId: string;
    transcriptPath?: string;
    workDir?: string;
  }): Promise<void> => {
    // The provider named these paths from inside the CLI's own filesystem, so
    // across a bridge they have to be translated before this server stores them.
    const environment = await getAgentEnvironment(options.userId);
    const workDir = observation.workDir
      ? await resolveAgentReportedPath(observation.workDir, environment)
      : '';
    options.onObservation({
      activation: observation.activation,
      allowCreate: true,
      identity: {
        providerId: options.provider.getProviderId(),
        providerSessionId: observation.providerSessionId,
        ...(observation.transcriptPath ? { transcriptPath: observation.transcriptPath } : {}),
      },
      ...(workDir ? { workDir } : {}),
    });
  };

  let observer: TerminalProviderSessionObserver;
  try {
    observer = createObserver({
      currentProviderSessionId: options.currentProviderSessionId,
      ...(options.userId ? { userId: options.userId } : {}),
      onObservation: (observation) => {
        void emit(observation).catch((error) => {
          logger.warn({ error, providerId: options.provider.getProviderId() },
            'Provider session observation could not be translated');
        });
      },
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
