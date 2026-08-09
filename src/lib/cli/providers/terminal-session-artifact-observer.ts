import fsp from 'node:fs/promises';
import chokidar from 'chokidar';
import { getFilesystemPathModule } from '@/lib/filesystem/host-path';
import logger from '@/lib/logger';
import {
  parseWslUncRoot,
  WslInotifyBridge,
} from '@/lib/workspace-files/wsl-inotify-bridge';
import type {
  ProviderTerminalSessionObservation,
  ProviderTerminalSessionObserver,
} from './provider-contract';

export interface ProviderSessionArtifactCandidate extends ProviderTerminalSessionObservation {
  previousProviderSessionId: string;
}

const DEFAULT_READY_TIMEOUT_MS = 1_000;
const MAX_ARTIFACT_READ_ATTEMPTS = 8;
const NEW_DIRECTORY_SCAN_ATTEMPTS = 3;
const NEW_DIRECTORY_SCAN_MAX_DEPTH = 4;
const NEW_DIRECTORY_SCAN_ENTRY_BUDGET = 512;
const NEW_DIRECTORY_SCAN_BASE_DELAY_MS = 50;

export function createTerminalSessionArtifactObserver(options: {
  /**
   * Where the provider drops its artifacts. Accepts a promise because across a
   * bridge the root lives on the agent's filesystem and locating it costs a
   * probe; watching starts once it resolves, and `ready()` waits for that.
   */
  root: string | Promise<string>;
  /** Maximum time terminal launch may wait for watch setup (tests may override). */
  readyTimeoutMs?: number;
  matchesPath: (relativePath: string) => boolean;
  /** `false` means a completely parsed artifact that can never be a candidate. */
  readCandidate: (filePath: string) => ProviderSessionArtifactCandidate | false | null;
  currentProviderSessionId: () => string | undefined;
  onObservation: (observation: ProviderTerminalSessionObservation) => void;
}): ProviderTerminalSessionObserver {
  const settled = new Set<string>();
  const inspecting = new Set<string>();
  const parsedCandidates = new Map<string, ProviderSessionArtifactCandidate>();
  const pendingWslCreates = new Set<string>();
  const scanningDirectories = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let wslBridge: WslInotifyBridge | null = null;
  let resolvedRoot: string | null = null;
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  let readySettled = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    resolveReady();
  };
  readyTimer = setTimeout(() => {
    readyTimer = null;
    markReady();
    logger.warn({ root: resolvedRoot }, 'Provider session artifact watcher readiness timed out; terminal launch continuing');
  }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

  const inspectAttempt = (root: string, relativePath: string, attempt: number): void => {
    if (disposed || settled.has(relativePath)) {
      inspecting.delete(relativePath);
      pendingWslCreates.delete(relativePath);
      parsedCandidates.delete(relativePath);
      return;
    }
    const cachedCandidate = parsedCandidates.get(relativePath);
    const result = cachedCandidate ?? options.readCandidate(
      getFilesystemPathModule(root).resolve(root, relativePath),
    );
    if (result === false) {
      settled.add(relativePath);
      inspecting.delete(relativePath);
      pendingWslCreates.delete(relativePath);
      return;
    }
    const candidate = result || null;
    if (candidate) {
      parsedCandidates.set(relativePath, candidate);
      if (candidate.previousProviderSessionId === options.currentProviderSessionId()) {
        settled.add(relativePath);
        inspecting.delete(relativePath);
        pendingWslCreates.delete(relativePath);
        parsedCandidates.delete(relativePath);
        options.onObservation({
          activation: candidate.activation,
          providerSessionId: candidate.providerSessionId,
          ...(candidate.transcriptPath ? { transcriptPath: candidate.transcriptPath } : {}),
          ...(candidate.workDir ? { workDir: candidate.workDir } : {}),
        });
        return;
      }
    }
    if (attempt >= MAX_ARTIFACT_READ_ATTEMPTS) {
      inspecting.delete(relativePath);
      pendingWslCreates.delete(relativePath);
      parsedCandidates.delete(relativePath);
      return;
    }
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      inspectAttempt(root, relativePath, attempt + 1);
    }, 20 * (2 ** attempt));
    retryTimers.add(timer);
  };

  const inspect = (root: string, relativePath: string): void => {
    if (disposed || settled.has(relativePath) || inspecting.has(relativePath)) return;
    inspecting.add(relativePath);
    inspectAttempt(root, relativePath, 0);
  };

  const scanDirectoryTree = async (
    root: string,
    relativeDir: string,
    remainingDepth: number,
    budget: { remaining: number },
  ): Promise<void> => {
    if (disposed || remainingDepth < 0 || budget.remaining <= 0) return;
    const pathModule = getFilesystemPathModule(root);
    let entries;
    try {
      entries = await fsp.readdir(pathModule.resolve(root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (disposed || budget.remaining <= 0) return;
      budget.remaining -= 1;
      const relativePath = pathModule.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await scanDirectoryTree(root, relativePath, remainingDepth - 1, budget);
      } else if (entry.isFile() && options.matchesPath(relativePath)) {
        pendingWslCreates.add(relativePath);
        inspect(root, relativePath);
      }
    }
  };

  const scanNewDirectory = (root: string, relativeDir: string, attempt = 0): void => {
    if (disposed || (attempt === 0 && scanningDirectories.has(relativeDir))) return;
    scanningDirectories.add(relativeDir);
    void scanDirectoryTree(
      root,
      relativeDir,
      NEW_DIRECTORY_SCAN_MAX_DEPTH,
      { remaining: NEW_DIRECTORY_SCAN_ENTRY_BUDGET },
    ).finally(() => {
      if (disposed || attempt >= NEW_DIRECTORY_SCAN_ATTEMPTS - 1) {
        scanningDirectories.delete(relativeDir);
        return;
      }
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        scanNewDirectory(root, relativeDir, attempt + 1);
      }, NEW_DIRECTORY_SCAN_BASE_DELAY_MS * (2 ** attempt));
      retryTimers.add(timer);
    });
  };

  const start = async (): Promise<void> => {
    const root = await options.root;
    resolvedRoot = root;
    if (disposed) return;
    await fsp.mkdir(root, { recursive: true });

    const handleEvent = (eventName: string, relativePath: string, fromWslBridge = false): void => {
      const normalizedPath = getFilesystemPathModule(root).normalize(relativePath);
      if (eventName === 'add' && options.matchesPath(normalizedPath)) {
        if (fromWslBridge) pendingWslCreates.add(normalizedPath);
        inspect(root, normalizedPath);
      }
      if (
        eventName === 'change'
        && options.matchesPath(normalizedPath)
        && (!fromWslBridge || pendingWslCreates.has(normalizedPath))
      ) inspect(root, normalizedPath);
      if (eventName === 'addDir') scanNewDirectory(root, normalizedPath);
    };
    const wslRoot = parseWslUncRoot(root);
    if (wslRoot) {
      const started = new WslInotifyBridge({
        root: wslRoot,
        // A provider fork always creates or moves in a new artifact. Ignoring
        // append traffic avoids every active PTY rereading ordinary rollouts.
        eventMask: 'create,move,close_write',
        onEvent: ({ eventName, relativePath }) => handleEvent(eventName, relativePath, true),
        onEstablished: markReady,
        onDown: (reason) => {
          markReady();
          logger.warn({ reason, root }, 'Provider session WSL artifact watcher unavailable');
        },
      });
      wslBridge = started;
      if (disposed) {
        started.stop();
        return;
      }
      started.start();
      return;
    }

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
    started.on('add', (relativePath) => handleEvent('add', String(relativePath)));
    started.on('change', (relativePath) => handleEvent('change', String(relativePath)));
    started.on('ready', markReady);
    let errorReported = false;
    started.on('error', (error) => {
      markReady();
      if (errorReported) return;
      errorReported = true;
      logger.warn({ error, root }, 'Provider session artifact watcher failed');
      if (watcher === started) watcher = null;
      void started.close();
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
      wslBridge?.stop();
      wslBridge = null;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      inspecting.clear();
      parsedCandidates.clear();
      pendingWslCreates.clear();
      scanningDirectories.clear();
    },
  };
}
