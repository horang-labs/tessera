import logger from '@/lib/logger';
import { CODEX_THREAD_ID_RE } from '@/lib/validation/path';
import {
  CodexAppServerRequestError,
  executeCodexAppServerRequest,
  setCodexAppServerRequestExecutorForTests,
  type CodexAppServerRequestContext,
  type CodexAppServerRequestExecutor,
} from './app-server-request-client';

export interface CodexThreadForkResult {
  threadId: string;
  forkedFromId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export type CodexThreadControlContext = CodexAppServerRequestContext;
export type CodexThreadControlRequestExecutor = CodexAppServerRequestExecutor;
export const setCodexThreadControlRequestExecutorForTests =
  setCodexAppServerRequestExecutorForTests;
export { CodexAppServerRequestError as CodexThreadControlError };

function assertThreadId(threadId: string, field = 'threadId'): void {
  if (!CODEX_THREAD_ID_RE.test(threadId)) {
    throw new CodexAppServerRequestError(`Codex returned an invalid ${field}.`);
  }
}

export async function forkCodexThread(
  context: CodexThreadControlContext,
  sourceThreadId: string,
): Promise<CodexThreadForkResult> {
  assertThreadId(sourceThreadId, 'source thread ID');
  const result = await executeCodexAppServerRequest<{
    model?: unknown;
    reasoningEffort?: unknown;
    serviceTier?: unknown;
    thread?: {
      id?: unknown;
      forkedFromId?: unknown;
    };
  }>(context, 'thread/fork', { threadId: sourceThreadId });
  const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
  assertThreadId(threadId, 'forked thread ID');
  if (threadId === sourceThreadId) {
    throw new CodexAppServerRequestError('Codex returned the source thread as the fork result.');
  }
  const forkedFromId = typeof result.thread?.forkedFromId === 'string'
    ? result.thread.forkedFromId
    : undefined;
  if (forkedFromId && forkedFromId !== sourceThreadId) {
    throw new CodexAppServerRequestError('Codex fork ancestry does not match the source thread.');
  }

  return {
    threadId,
    forkedFromId,
    model: typeof result.model === 'string' ? result.model : undefined,
    reasoningEffort: typeof result.reasoningEffort === 'string'
      ? result.reasoningEffort
      : undefined,
    serviceTier: typeof result.serviceTier === 'string' ? result.serviceTier : undefined,
  };
}

export async function renameCodexThread(
  context: CodexThreadControlContext,
  threadId: string,
  name: string,
): Promise<void> {
  assertThreadId(threadId);
  await executeCodexAppServerRequest(context, 'thread/name/set', { threadId, name });
}

export async function setCodexThreadArchived(
  context: CodexThreadControlContext,
  threadId: string,
  archived: boolean,
): Promise<void> {
  assertThreadId(threadId);
  await executeCodexAppServerRequest(
    context,
    archived ? 'thread/archive' : 'thread/unarchive',
    { threadId },
  );
}

export async function deleteCodexThread(
  context: CodexThreadControlContext,
  threadId: string,
): Promise<void> {
  assertThreadId(threadId);
  try {
    await executeCodexAppServerRequest(context, 'thread/delete', { threadId });
  } catch (error) {
    if (isAlreadyDeletedThreadError(error)) {
      logger.info({ threadId }, 'Codex thread was already absent during delete');
      return;
    }
    throw error;
  }
}

function isAlreadyDeletedThreadError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRequestError)) return false;
  const message = error.message.toLowerCase();
  return message.includes('not found')
    || message.includes('does not exist')
    || message.includes('already deleted');
}
