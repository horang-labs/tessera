import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import logger from '@/lib/logger';
import type {
  ProviderTerminalSessionObservation,
  ProviderTerminalSessionObserver,
} from './provider-contract';

export interface ProviderSessionArtifactCandidate extends ProviderTerminalSessionObservation {
  previousProviderSessionId: string;
}

export function createTerminalSessionArtifactObserver(options: {
  /**
   * Where the provider drops its artifacts. Accepts a promise because across a
   * bridge the root lives on the agent's filesystem and locating it costs a
   * probe; watching starts once it resolves, and `ready()` waits for that.
   */
  root: string | Promise<string>;
  matchesPath: (relativePath: string) => boolean;
  readCandidate: (filePath: string) => ProviderSessionArtifactCandidate | null;
  currentProviderSessionId: () => string | undefined;
  onObservation: (observation: ProviderTerminalSessionObservation) => void;
}): ProviderTerminalSessionObserver {
  const emitted = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  let readySettled = false;
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };

  const inspect = (root: string, relativePath: string, attempt = 0): void => {
    if (disposed || emitted.has(relativePath)) return;
    const candidate = options.readCandidate(path.resolve(root, relativePath));
    if (candidate && candidate.previousProviderSessionId === options.currentProviderSessionId()) {
      emitted.add(relativePath);
      options.onObservation({
        activation: candidate.activation,
        providerSessionId: candidate.providerSessionId,
        ...(candidate.transcriptPath ? { transcriptPath: candidate.transcriptPath } : {}),
        ...(candidate.workDir ? { workDir: candidate.workDir } : {}),
      });
      return;
    }
    if (attempt >= 5) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      inspect(root, relativePath, attempt + 1);
    }, 20 * (2 ** attempt));
    retryTimers.add(timer);
  };

  const start = async (): Promise<void> => {
    const root = await options.root;
    if (disposed) return;
    fs.mkdirSync(root, { recursive: true });

    const started = chokidar.watch(root, {
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
      cwd: root,
      followSymlinks: false,
      ignoreInitial: true,
      persistent: true,
    });
    watcher = started;
    // dispose() may have run while the root was still resolving; it could not
    // close a watcher that did not exist yet, so close it here instead.
    if (disposed) {
      void started.close();
      return;
    }
    started.on('add', (relativePath) => {
      const normalized = String(relativePath);
      if (options.matchesPath(normalized)) inspect(root, normalized);
    });
    started.on('change', (relativePath) => {
      const normalized = String(relativePath);
      if (options.matchesPath(normalized)) inspect(root, normalized);
    });
    started.on('ready', markReady);
    started.on('error', (error) => {
      markReady();
      logger.warn({ error, root }, 'Provider session artifact watcher failed');
    });
  };

  // Fail-open: a root that cannot be resolved or created costs fork discovery,
  // never the terminal the caller is awaiting `ready()` for.
  void start().catch((error) => {
    markReady();
    logger.warn({ error }, 'Provider session artifact watcher could not start');
  });

  return {
    ready: () => readyPromise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      markReady();
      void watcher?.close();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}
