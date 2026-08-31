import type { ChildProcess } from 'child_process';
import type { CliEnvironment } from '@/lib/cli/cli-exec';
import { buildCodexAccountEnvironment } from '@/lib/codex-home';
import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import {
  getAgentEnvironment,
  normalizeCwdForCliEnvironment,
  spawnCli,
} from '@/lib/cli/spawn-cli';

const REQUEST_TIMEOUT_MS = 30_000;

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

export interface CodexAppServerRequestContext {
  userId?: string;
  workDir?: string | null;
  environment?: CliEnvironment;
}

export type CodexAppServerRequestExecutor = (
  context: CodexAppServerRequestContext,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

let requestExecutorOverride: CodexAppServerRequestExecutor | null = null;

/** Test seam for app-server consumers that must not spawn a real Codex process. */
export function setCodexAppServerRequestExecutorForTests(
  executor: CodexAppServerRequestExecutor | null,
): void {
  requestExecutorOverride = executor;
}

export class CodexAppServerRequestError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerRequestError';
  }
}

function killRequestProcess(proc: ChildProcess): void {
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

export async function executeCodexAppServerRequest<T>(
  context: CodexAppServerRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (requestExecutorOverride) {
    return requestExecutorOverride(context, method, params) as Promise<T>;
  }
  return runCodexAppServerRequest<T>(context, method, params);
}

/** Sends one request through an isolated, short-lived Codex app-server process. */
export async function runCodexAppServerRequest<T>(
  context: CodexAppServerRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const agentEnvironment = context.environment ?? await getAgentEnvironment(context.userId);
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
      env: buildCodexAccountEnvironment(process.env, agentEnvironment),
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
      killRequestProcess(proc);
      callback();
    };

    const fail = (error: Error) => finish(() => reject(error));
    const send = (message: Record<string, unknown>) => {
      if (!proc.stdin?.writable) {
        fail(new CodexAppServerRequestError('Codex app-server stdin is unavailable.'));
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
            fail(new CodexAppServerRequestError(
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
            fail(new CodexAppServerRequestError(
              response.error.message || `Codex ${method} failed.`,
              response.error.code,
              response.error.data,
            ));
            return;
          }
          responseResult = response.result as T;
          responseReceived = true;
          if (!mutationConfirmation || confirmationReceived) {
            finish(() => resolve(responseResult as T));
            return;
          }
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
      fail(new CodexAppServerRequestError(
        `Codex app-server exited before ${method} completed (code ${code})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    };
    const timeout = setTimeout(() => {
      fail(new CodexAppServerRequestError(`Timed out while running Codex ${method}.`));
    }, REQUEST_TIMEOUT_MS);

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
