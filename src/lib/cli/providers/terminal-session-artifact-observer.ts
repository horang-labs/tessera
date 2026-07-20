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
  root: string;
  matchesPath: (relativePath: string) => boolean;
  readCandidate: (filePath: string) => ProviderSessionArtifactCandidate | null;
  currentProviderSessionId: () => string | undefined;
  onObservation: (observation: ProviderTerminalSessionObservation) => void;
}): ProviderTerminalSessionObserver {
  fs.mkdirSync(options.root, { recursive: true });

  const emitted = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  let readySettled = false;
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };

  const inspect = (relativePath: string, attempt = 0): void => {
    if (disposed || emitted.has(relativePath)) return;
    const candidate = options.readCandidate(path.resolve(options.root, relativePath));
    if (candidate && candidate.previousProviderSessionId === options.currentProviderSessionId()) {
      emitted.add(relativePath);
      options.onObservation({
        activation: candidate.activation,
        providerSessionId: candidate.providerSessionId,
        ...(candidate.transcriptPath ? { transcriptPath: candidate.transcriptPath } : {}),
      });
      return;
    }
    if (attempt >= 5) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      inspect(relativePath, attempt + 1);
    }, 20 * (2 ** attempt));
    retryTimers.add(timer);
  };

  const watcher = chokidar.watch(options.root, {
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    cwd: options.root,
    followSymlinks: false,
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on('add', (relativePath) => {
    const normalized = String(relativePath);
    if (options.matchesPath(normalized)) inspect(normalized);
  });
  watcher.on('change', (relativePath) => {
    const normalized = String(relativePath);
    if (options.matchesPath(normalized)) inspect(normalized);
  });
  watcher.on('ready', markReady);
  watcher.on('error', (error) => {
    markReady();
    logger.warn({ error, root: options.root }, 'Provider session artifact watcher failed');
  });

  return {
    ready: () => readyPromise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      markReady();
      void watcher.close();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}
