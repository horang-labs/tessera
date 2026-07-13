import type { ChildProcess } from 'child_process';
import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import {
  getAgentEnvironment,
  normalizeCwdForCliEnvironment,
  spawnCli,
} from '@/lib/cli/spawn-cli';
import logger from '@/lib/logger';
import { CODEX_THREAD_ID_RE } from '@/lib/validation/path';

const CONTROL_TIMEOUT_MS = 30_000;

interface JsonRpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcResponse {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export interface CodexThreadForkResult {
  threadId: string;
  forkedFromId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface CodexThreadControlContext {
  userId?: string;
  workDir?: string | null;
}

export type CodexThreadControlRequestExecutor = (
  context: CodexThreadControlContext,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

let requestExecutorOverride: CodexThreadControlRequestExecutor | null = null;

/** Test seam for exercising lifecycle ordering without a real Codex process. */
export function setCodexThreadControlRequestExecutorForTests(
  executor: CodexThreadControlRequestExecutor | null,
): void {
  requestExecutorOverride = executor;
}

async function executeCodexThreadControlRequest<T>(
  context: CodexThreadControlContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (requestExecutorOverride) {
    return requestExecutorOverride(context, method, params) as Promise<T>;
  }
  return runCodexThreadControlRequest<T>(context, method, params);
}

export class CodexThreadControlError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super(message);
    this.name = 'CodexThreadControlError';
  }
}

function assertThreadId(threadId: string, field = 'threadId'): void {
  if (!CODEX_THREAD_ID_RE.test(threadId)) {
    throw new CodexThreadControlError(`Codex returned an invalid ${field}.`);
  }
}

function killControlProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // The short-lived process may already have exited between the checks.
  }
}

function getMutationConfirmation(
  method: string,
  params: Record<string, unknown>,
): { method: string; matches: (notification: JsonRpcResponse) => boolean } | null {
  const threadId = params.threadId;
  if (typeof threadId !== 'string') return null;

  const expectedMethod = method === 'thread/name/set'
    ? 'thread/name/updated'
    : method === 'thread/archive'
      ? 'thread/archived'
      : method === 'thread/unarchive'
        ? 'thread/unarchived'
        : method === 'thread/delete'
          ? 'thread/deleted'
          : null;
  if (!expectedMethod) return null;

  return {
    method: expectedMethod,
    matches: (notification) => {
      if (notification.method !== expectedMethod || notification.params?.threadId !== threadId) {
        return false;
      }
      return method !== 'thread/name/set'
        || notification.params?.threadName === params.name;
    },
  };
}

/**
 * Sends one stable app-server request through an isolated, short-lived Codex
 * process. Lifecycle mutations must never share the live session parser: a
 * fork response describes a different thread and would otherwise risk binding
 * that thread to the source Tessera session.
 */
export async function runCodexThreadControlRequest<T>(
  context: CodexThreadControlContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const agentEnvironment = await getAgentEnvironment(context.userId);
  const command = await resolveProviderCliCommand(
    'codex',
    'codex',
    agentEnvironment,
    context.userId,
  );
  const requestedCwd = context.workDir?.trim() || process.cwd();
  const cwd = normalizeCwdForCliEnvironment(requestedCwd, agentEnvironment);

  return new Promise<T>((resolve, reject) => {
    const proc = spawnCli(command, ['app-server'], {
      cwd,
      shell: false,
      env: process.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }, agentEnvironment);
    let buffer = '';
    let stderr = '';
    let settled = false;
    let responseResult: T | undefined;
    let responseReceived = false;
    let confirmationReceived = false;
    const mutationConfirmation = getMutationConfirmation(method, params);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
      killControlProcess(proc);
      callback();
    };

    const fail = (error: Error) => finish(() => reject(error));
    const send = (message: Record<string, unknown>) => {
      if (!proc.stdin?.writable) {
        fail(new CodexThreadControlError('Codex app-server stdin is unavailable.'));
        return;
      }
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const onStdout = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let response: JsonRpcResponse;
        try {
          response = JSON.parse(trimmed) as JsonRpcResponse;
        } catch {
          continue;
        }

        if (mutationConfirmation?.matches(response)) {
          confirmationReceived = true;
          if (responseReceived) {
            finish(() => resolve(responseResult as T));
            return;
          }
          continue;
        }

        if (response.id === 1) {
          if (response.error) {
            fail(new CodexThreadControlError(
              response.error.message || 'Codex initialize failed.',
              response.error.code,
              response.error.data,
            ));
            return;
          }
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method, params });
          continue;
        }

        if (response.id === 2) {
          if (response.error) {
            fail(new CodexThreadControlError(
              response.error.message || `Codex ${method} failed.`,
              response.error.code,
              response.error.data,
            ));
            return;
          }
          responseResult = response.result as T;
          responseReceived = true;
          // Codex emits lifecycle confirmations after the JSON-RPC response.
          // Killing the short-lived process at the response boundary can cancel
          // the metadata write, so wait for the matching notification first.
          if (!mutationConfirmation || confirmationReceived) {
            finish(() => resolve(responseResult as T));
            return;
          }
          // The response and its confirmation are often coalesced into one
          // stdout chunk. Keep consuming the already-split lines so the
          // following notification is not discarded.
          continue;
        }
      }
    };

    const onStderr = (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    };
    const onError = (error: Error) => fail(error);
    const onClose = (code: number | null) => {
      if (settled) return;
      fail(new CodexThreadControlError(
        `Codex app-server exited before ${method} completed (code ${code})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    };
    const timeout = setTimeout(() => {
      fail(new CodexThreadControlError(`Timed out while running Codex ${method}.`));
    }, CONTROL_TIMEOUT_MS);

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.once('error', onError);
    proc.once('close', onClose);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-01-01',
        clientInfo: { name: 'tessera-control', version: '1.0.0' },
      },
    });
  });
}

export async function forkCodexThread(
  context: CodexThreadControlContext,
  sourceThreadId: string,
): Promise<CodexThreadForkResult> {
  assertThreadId(sourceThreadId, 'source thread ID');
  const result = await executeCodexThreadControlRequest<{
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
    throw new CodexThreadControlError('Codex returned the source thread as the fork result.');
  }
  const forkedFromId = typeof result.thread?.forkedFromId === 'string'
    ? result.thread.forkedFromId
    : undefined;
  if (forkedFromId && forkedFromId !== sourceThreadId) {
    throw new CodexThreadControlError('Codex fork ancestry does not match the source thread.');
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
  await executeCodexThreadControlRequest(context, 'thread/name/set', { threadId, name });
}

export async function setCodexThreadArchived(
  context: CodexThreadControlContext,
  threadId: string,
  archived: boolean,
): Promise<void> {
  assertThreadId(threadId);
  await executeCodexThreadControlRequest(
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
    await executeCodexThreadControlRequest(context, 'thread/delete', { threadId });
  } catch (error) {
    if (isAlreadyDeletedThreadError(error)) {
      logger.info({ threadId }, 'Codex thread was already absent during delete');
      return;
    }
    throw error;
  }
}

function isAlreadyDeletedThreadError(error: unknown): boolean {
  if (!(error instanceof CodexThreadControlError)) return false;
  const message = error.message.toLowerCase();
  return message.includes('not found')
    || message.includes('does not exist')
    || message.includes('already deleted');
}
