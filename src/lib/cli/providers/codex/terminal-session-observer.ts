import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexAccountHome } from '@/lib/codex-home';
import type {
  ProviderTerminalSessionObserver,
  ProviderTerminalSessionObserverOptions,
} from '../provider-contract';
import {
  createTerminalSessionArtifactObserver,
  type ProviderSessionArtifactCandidate,
} from '../terminal-session-artifact-observer';

function readCodexFork(filePath: string): ProviderSessionArtifactCandidate | null {
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
    if (entry.type !== 'session_meta' || !entry.payload) return null;
    const providerSessionId = typeof entry.payload.session_id === 'string'
      ? entry.payload.session_id.trim()
      : typeof entry.payload.id === 'string'
        ? entry.payload.id.trim()
        : '';
    const previousProviderSessionId = typeof entry.payload.forked_from_id === 'string'
      ? entry.payload.forked_from_id.trim()
      : '';
    if (!providerSessionId || !previousProviderSessionId || providerSessionId === previousProviderSessionId) {
      return null;
    }
    return {
      activation: 'active',
      providerSessionId,
      previousProviderSessionId,
      transcriptPath: filePath,
    };
  } catch {
    return null;
  }
}

export function createCodexTerminalSessionObserver(
  options: ProviderTerminalSessionObserverOptions & { sessionsDir?: string },
): ProviderTerminalSessionObserver {
  return createTerminalSessionArtifactObserver({
    root: options.sessionsDir ?? path.join(resolveCodexAccountHome(), 'sessions'),
    matchesPath: (relativePath) => relativePath.endsWith('.jsonl'),
    readCandidate: readCodexFork,
    currentProviderSessionId: options.currentProviderSessionId,
    onObservation: options.onObservation,
  });
}
