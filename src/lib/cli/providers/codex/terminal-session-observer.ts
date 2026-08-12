import fs from 'node:fs';
import path from 'node:path';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { resolveCodexAccountHome } from '@/lib/codex-home';
import {
  isBridgedAgentEnvironment,
  type FilesystemBrowseEnvironment,
} from '@/lib/filesystem/path-environment';
import { resolveCodexHomeForEnvironment } from './provider-home';
import { parseWslUncRoot } from '@/lib/workspace-files/wsl-inotify-bridge';
import type {
  ProviderTerminalSessionObserver,
  ProviderTerminalSessionObserverOptions,
} from '../provider-contract';
import {
  createTerminalSessionArtifactObserver,
  type ProviderSessionArtifactCandidate,
} from '../terminal-session-artifact-observer';

function readCodexFork(filePath: string): ProviderSessionArtifactCandidate | false | null {
  let firstLine = '';
  try {
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      firstLine = buffer.subarray(0, size).toString('utf8').split('\n', 1)[0];
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
  if (!firstLine) return null;

  try {
    const entry = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    if (entry.type !== 'session_meta' || !entry.payload) return false;
    const providerSessionId = typeof entry.payload.session_id === 'string'
      ? entry.payload.session_id.trim()
      : typeof entry.payload.id === 'string'
        ? entry.payload.id.trim()
        : '';
    const previousProviderSessionId = typeof entry.payload.forked_from_id === 'string'
      ? entry.payload.forked_from_id.trim()
      : '';
    if (!providerSessionId || !previousProviderSessionId || providerSessionId === previousProviderSessionId) {
      return false;
    }
    return {
      activation: 'active',
      providerSessionId,
      previousProviderSessionId,
      // Watching uses a server-openable path, but persisted provider paths stay
      // in the CLI's filesystem domain and are translated only when opened.
      transcriptPath: parseWslUncRoot(filePath)?.posixPath ?? filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Where Codex records rollouts, as a path *this server* can open. Across a
 * bridge both `os.homedir()` and the server process's `CODEX_HOME` describe the
 * wrong side. Provider-home discovery probes the CLI's login shell so a custom
 * WSL `CODEX_HOME` is observed at the same root where Codex writes rollouts.
 */
export async function resolveCodexSessionsDir(options: {
  environment: FilesystemBrowseEnvironment;
  /** Overrides the sessions root (tests). */
  sessionsDir?: string;
  /** Overrides provider-home discovery (tests). */
  resolveProviderHome?: typeof resolveCodexHomeForEnvironment;
}): Promise<string> {
  if (options.sessionsDir) return options.sessionsDir;
  if (isBridgedAgentEnvironment(options.environment)) {
    return path.join(
      await (options.resolveProviderHome ?? resolveCodexHomeForEnvironment)(options.environment),
      'sessions',
    );
  }
  return path.join(resolveCodexAccountHome(), 'sessions');
}

export function createCodexTerminalSessionObserver(
  options: ProviderTerminalSessionObserverOptions & {
    sessionsDir?: string;
    /** Overrides the resolved environment (tests). */
    environment?: FilesystemBrowseEnvironment;
  },
): ProviderTerminalSessionObserver {
  return createTerminalSessionArtifactObserver({
    root: (async () => resolveCodexSessionsDir({
      environment: options.environment ?? await getAgentEnvironment(options.userId),
      sessionsDir: options.sessionsDir,
    }))(),
    matchesPath: (relativePath) => relativePath.endsWith('.jsonl'),
    readCandidate: readCodexFork,
    currentProviderSessionId: options.currentProviderSessionId,
    onObservation: options.onObservation,
  });
}
