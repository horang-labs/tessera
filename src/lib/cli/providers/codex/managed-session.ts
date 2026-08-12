import path from 'node:path';
import type { CodexAppServerRequestContext } from './app-server-request-client';
import type {
  ProviderSessionResumeInspection,
  ProviderSessionRuntimeGuard,
} from '../provider-contract';
import { resolveCodexTranscriptPath } from './transcript-path';
import {
  isCodexRolloutOpenByAnotherRuntime,
  watchCodexRolloutRuntimeOwners,
} from './provider-runtime-ownership';

function unavailableHistory(): ProviderSessionResumeInspection {
  return {
    state: 'unavailable',
    reason: 'provider-history-missing',
    message: 'The provider conversation is missing from its origin home. Tessera kept the management record but cannot resume it.',
  };
}

function unavailableConcurrentRuntime(): ProviderSessionResumeInspection {
  return {
    state: 'unavailable',
    reason: 'provider-session-already-running',
    message: 'This provider conversation is already open in another runtime. Fork it to work in parallel.',
  };
}

/** Inspect durable provider history and the OS handle ordinary Codex holds while active. */
export async function inspectCodexManagedSessionResume(
  context: CodexAppServerRequestContext,
  providerSessionId: string,
): Promise<ProviderSessionResumeInspection> {
  if (!context.providerHomeFilesystemPath || !context.environment) {
    throw new Error('Codex resume inspection requires a prepared provider home and Agent Environment.');
  }
  const rolloutPath = await resolveCodexTranscriptPath({
    providerSessionId,
    environment: context.environment,
    sessionsDir: path.join(context.providerHomeFilesystemPath, 'sessions'),
  });
  if (!rolloutPath) {
    return unavailableHistory();
  }
  if (await isCodexRolloutOpenByAnotherRuntime(rolloutPath, context.environment)) {
    return unavailableConcurrentRuntime();
  }
  const runtimeGuard: ProviderSessionRuntimeGuard = {
    reinspect: async () => await isCodexRolloutOpenByAnotherRuntime(
      rolloutPath,
      context.environment!,
    )
      ? unavailableConcurrentRuntime()
      : { state: 'available' },
    start: (onConflict) => watchCodexRolloutRuntimeOwners(
      rolloutPath,
      context.environment!,
      onConflict,
    ),
  };
  return { state: 'available', runtimeGuard };
}
