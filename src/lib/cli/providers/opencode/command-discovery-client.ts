import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { CliEnvironment } from '@/lib/cli/cli-exec';
import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import {
  getAgentEnvironment,
  normalizeCwdForCliEnvironment,
  spawnCli,
} from '@/lib/cli/spawn-cli';
import type { SkillInfo } from '../skill-types';

const DISCOVERY_TIMEOUT_MS = 30_000;
const LOOPBACK_RETRY_DELAY_MS = 100;
const COMPACT_COMMAND: SkillInfo = {
  name: 'compact',
  description: 'compact the session',
};

export interface OpenCodeCommandDiscoveryContext {
  userId?: string;
  workDir?: string | null;
  environment?: CliEnvironment;
}

interface OpenCodeCommandCatalogEntry {
  name?: unknown;
  description?: unknown;
}

export type OpenCodeCommandDiscoveryExecutor = (
  context: OpenCodeCommandDiscoveryContext,
) => Promise<unknown>;

export interface OpenCodeCommandCatalogRequestOptions {
  signal: AbortSignal;
  authorization?: string;
}

let discoveryExecutorOverride: OpenCodeCommandDiscoveryExecutor | null = null;

/** Test seam for the external OpenCode HTTP server boundary. */
export function setOpenCodeCommandDiscoveryExecutorForTests(
  executor: OpenCodeCommandDiscoveryExecutor | null,
): void {
  discoveryExecutorOverride = executor;
}

function killDiscoveryProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // The short-lived server may already have exited between the checks.
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an OpenCode discovery port.'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function buildAuthorizationHeader(): string | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function waitForLoopbackRetry(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, LOOPBACK_RETRY_DELAY_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** HTTP boundary kept separate so bridged localhost readiness is regression-testable. */
export async function fetchOpenCodeCommandCatalog(
  url: URL,
  options: OpenCodeCommandCatalogRequestOptions,
): Promise<unknown> {
  while (true) {
    try {
      const response = await fetch(url, {
        headers: options.authorization ? { Authorization: options.authorization } : undefined,
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenCode command discovery failed with HTTP ${response.status}.`);
      }
      return response.json();
    } catch (error) {
      // In Windows-host + WSL-agent mode, OpenCode can announce that its WSL
      // listener is ready before WSL's localhost proxy has exposed the port to
      // Windows. Node reports those short-lived connection failures as a
      // TypeError. HTTP and payload errors are ordinary Error/SyntaxError
      // instances and remain fail-fast.
      if (options.signal.aborted || !(error instanceof TypeError)) {
        throw error;
      }
      await waitForLoopbackRetry(options.signal);
    }
  }
}

async function requestCatalogFromTransientServer(
  command: string,
  cwd: string,
  environment: CliEnvironment,
  port: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const proc = spawnCli(command, [
      'serve',
      '--hostname', '127.0.0.1',
      '--port', String(port),
    ], {
      cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, environment);
    const abortController = new AbortController();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let requestStarted = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortController.abort();
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
      killDiscoveryProcess(proc);
      callback();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const fetchCatalog = async () => {
      const url = new URL(`http://127.0.0.1:${port}/command`);
      url.searchParams.set('directory', cwd);
      const authorization = buildAuthorizationHeader();
      return fetchOpenCodeCommandCatalog(url, {
        authorization,
        signal: abortController.signal,
      });
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-4_000);
      if (requestStarted || !stdout.includes('opencode server listening on ')) return;
      requestStarted = true;
      void fetchCatalog()
        .then((catalog) => finish(() => resolve(catalog)))
        .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    };
    const onError = (error: Error) => fail(error);
    const onClose = (code: number | null) => {
      fail(new Error(
        `OpenCode discovery server exited before returning commands (code ${code})`
        + (stderr ? `: ${stderr.trim()}` : ''),
      ));
    };
    const timeout = setTimeout(() => {
      fail(new Error('Timed out while discovering OpenCode commands.'));
    }, DISCOVERY_TIMEOUT_MS);

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.once('error', onError);
    proc.once('close', onClose);
  });
}

/** Reads the same command catalog OpenCode reports through ACP, without creating a session. */
async function runOpenCodeCommandDiscovery(
  context: OpenCodeCommandDiscoveryContext,
): Promise<unknown> {
  const environment = context.environment ?? await getAgentEnvironment(context.userId);
  const command = await resolveProviderCliCommand(
    'opencode',
    'opencode',
    environment,
    context.userId,
  );
  const requestedCwd = context.workDir?.trim() || process.cwd();
  const cwd = normalizeCwdForCliEnvironment(requestedCwd, environment);
  const port = await reserveLoopbackPort();
  return requestCatalogFromTransientServer(command, cwd, environment, port);
}

export async function listOpenCodeCommands(
  context: OpenCodeCommandDiscoveryContext,
): Promise<SkillInfo[]> {
  const rawCatalog = await (
    discoveryExecutorOverride
      ? discoveryExecutorOverride(context)
      : runOpenCodeCommandDiscovery(context)
  );
  const catalog = Array.isArray(rawCatalog)
    ? rawCatalog as OpenCodeCommandCatalogEntry[]
    : [];
  const commands = catalog
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name.length > 0)
    .map((entry) => ({
      name: (entry.name as string).slice(0, 100),
      description: typeof entry.description === 'string'
        ? entry.description.slice(0, 500)
        : '',
    }));

  if (!commands.some((command) => command.name === COMPACT_COMMAND.name)) {
    commands.push(COMPACT_COMMAND);
  }
  return commands;
}
