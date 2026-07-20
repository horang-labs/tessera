import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ProviderTerminalSessionObserver,
  ProviderTerminalSessionObserverOptions,
} from '../provider-contract';
import {
  createTerminalSessionArtifactObserver,
  type ProviderSessionArtifactCandidate,
} from '../terminal-session-artifact-observer';

function resolveJobsDir(jobsDir?: string): string {
  if (jobsDir) return jobsDir;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, 'jobs');
}

function readClaudeFork(filePath: string): ProviderSessionArtifactCandidate | null {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const providerSessionId = typeof state.forkSessionId === 'string'
    ? state.forkSessionId.trim()
    : '';
  const previousProviderSessionId = typeof state.forkParentSessionId === 'string'
    ? state.forkParentSessionId.trim()
    : '';
  if (
    !providerSessionId
    || !previousProviderSessionId
    || providerSessionId === previousProviderSessionId
    || state.interactiveLineage !== true
  ) return null;
  return {
    activation: 'background',
    providerSessionId,
    previousProviderSessionId,
  };
}

export function createClaudeTerminalSessionObserver(
  options: ProviderTerminalSessionObserverOptions & { jobsDir?: string },
): ProviderTerminalSessionObserver {
  return createTerminalSessionArtifactObserver({
    root: resolveJobsDir(options.jobsDir),
    matchesPath: (relativePath) => path.basename(relativePath) === 'state.json',
    readCandidate: readClaudeFork,
    currentProviderSessionId: options.currentProviderSessionId,
    onObservation: options.onObservation,
  });
}

export function isClaudeBackgroundTerminalSessionFork(options: {
  currentProviderSessionId: string;
  observedProviderSessionId: string;
  jobsDir?: string;
}): boolean {
  const jobDir = path.join(resolveJobsDir(options.jobsDir), options.observedProviderSessionId.slice(0, 8));
  const candidate = readClaudeFork(path.join(jobDir, 'state.json'));
  return candidate?.previousProviderSessionId === options.currentProviderSessionId
    && candidate.providerSessionId === options.observedProviderSessionId
    && candidate.activation === 'background';
}
