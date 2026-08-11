import {
  CodexAppServerRequestError,
  executeCodexAppServerRequest,
  type CodexAppServerRequestContext,
} from './app-server-request-client';
import type { ProviderSessionResumeInspection } from '../provider-contract';

interface ThreadReadResult {
  thread?: {
    id?: unknown;
    status?: { type?: unknown };
  };
}

function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRequestError)) return false;
  const message = error.message.toLowerCase();
  return message.includes('not found') || message.includes('does not exist');
}

/** Inspect without subscribing; only a not-loaded provider thread is safe to resume. */
export async function inspectCodexManagedSessionResume(
  context: CodexAppServerRequestContext,
  providerSessionId: string,
): Promise<ProviderSessionResumeInspection> {
  try {
    const result = await executeCodexAppServerRequest<ThreadReadResult>(
      context,
      'thread/read',
      { threadId: providerSessionId, includeTurns: false },
    );
    if (result.thread?.id !== providerSessionId) return { state: 'missing' };
    return result.thread.status?.type === 'notLoaded'
      ? { state: 'available' }
      : { state: 'already-loaded' };
  } catch (error) {
    if (isMissingThreadError(error)) return { state: 'missing' };
    throw error;
  }
}
