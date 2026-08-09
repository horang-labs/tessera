import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  TailscaleAdapter,
  TailscaleConfigureResult,
  TailscaleNodeStatus,
  TailscaleServeEndpoint,
  TailscaleServeStatus,
} from '../src/lib/mobile-access/mobile-access-coordinator';

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
  authorizationUrl?: string;
}

interface CommandOptions {
  stopOnAuthorizationUrl?: boolean;
}

export type CommandRunner = (
  arguments_: string[],
  options?: CommandOptions,
) => Promise<TailscaleCommandResult>;

class TailscaleCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TailscaleCommandError';
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tailscale returned an invalid JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function parseTailscaleNodeStatus(raw: string): TailscaleNodeStatus {
  const status = parseJsonObject(raw);
  const backendState = typeof status.BackendState === 'string'
    ? status.BackendState
    : 'Unknown';
  const authorizationUrl = typeof status.AuthURL === 'string' && status.AuthURL.startsWith('https://')
    ? status.AuthURL
    : undefined;

  if (backendState === 'NeedsLogin') {
    return { state: 'needs-login', ...(authorizationUrl ? { authorizationUrl } : {}) };
  }
  if (backendState === 'NeedsMachineAuth') {
    return {
      state: 'needs-machine-authorization',
      ...(authorizationUrl ? { authorizationUrl } : {}),
    };
  }
  if (backendState === 'Stopped' || backendState === 'NoState') return { state: 'stopped' };
  if (backendState === 'Starting') return { state: 'starting' };
  if (backendState !== 'Running') return { state: 'unsupported', backendState };

  const self = status.Self && typeof status.Self === 'object'
    ? status.Self as Record<string, unknown>
    : null;
  const rawDnsName = typeof self?.DNSName === 'string' ? self.DNSName : '';
  const dnsName = rawDnsName.replace(/\.+$/, '') || null;
  if (
    status.CertDomains !== undefined
    && status.CertDomains !== null
    && (
      !Array.isArray(status.CertDomains)
      || status.CertDomains.some((value) => typeof value !== 'string')
    )
  ) {
    throw new Error('Tailscale returned invalid CertDomains');
  }
  const certDomains = status.CertDomains ?? [];

  if (!dnsName) return { state: 'unsupported', backendState };
  return {
    state: 'running',
    dnsName,
    httpsReady: Boolean(
      dnsName
      && certDomains.some((domain) => domain.replace(/\.+$/, '') === dnsName),
    ),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Tailscale returned an invalid Serve port: ${value}`);
  }
  return port;
}

function parseHostPort(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) throw new Error(`Tailscale returned an invalid Serve host: ${value}`);
  return { host: value.slice(0, separator), port: parsePort(value.slice(separator + 1)) };
}

interface ServeAccumulator {
  endpoints: TailscaleServeEndpoint[];
  occupiedPorts: Set<number>;
  resources: Array<{ key: string; value: string }>;
}

function collectServeConfig(
  rawConfig: unknown,
  scope: 'background' | 'foreground' | 'service',
  prefix: string,
  accumulator: ServeAccumulator,
): void {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Tailscale returned an invalid Serve configuration');
  }
  const config = rawConfig as Record<string, unknown>;
  const supportedKeys = new Set([
    'TCP',
    'Web',
    ...(scope === 'service' ? ['Tun'] : ['AllowFunnel', 'Foreground', 'Services', 'ETag']),
  ]);
  for (const key of Object.keys(config)) {
    if (!supportedKeys.has(key)) {
      throw new Error(`Tailscale returned an unsupported Serve field: ${key}`);
    }
  }

  if (config.TCP !== undefined) {
    if (!config.TCP || typeof config.TCP !== 'object' || Array.isArray(config.TCP)) {
      throw new Error('Tailscale returned an invalid Serve TCP map');
    }
    for (const [rawPort, value] of Object.entries(config.TCP as Record<string, unknown>)) {
      const port = parsePort(rawPort);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Tailscale returned an invalid Serve TCP entry: ${rawPort}`);
      }
      if (scope !== 'service') accumulator.occupiedPorts.add(port);
      accumulator.resources.push({ key: `${prefix}:tcp:${port}`, value: stableJson(value) });
    }
  }

  if (config.Web !== undefined) {
    if (!config.Web || typeof config.Web !== 'object' || Array.isArray(config.Web)) {
      throw new Error('Tailscale returned an invalid Serve Web map');
    }
    for (const [hostPort, rawServer] of Object.entries(config.Web as Record<string, unknown>)) {
      const { host, port } = parseHostPort(hostPort);
      if (!rawServer || typeof rawServer !== 'object' || Array.isArray(rawServer)) {
        throw new Error(`Tailscale returned an invalid Serve Web entry: ${hostPort}`);
      }
      const server = rawServer as Record<string, unknown>;
      if (!server.Handlers || typeof server.Handlers !== 'object' || Array.isArray(server.Handlers)) {
        throw new Error(`Tailscale returned invalid Serve handlers: ${hostPort}`);
      }
      if (scope !== 'service') accumulator.occupiedPorts.add(port);
      for (const [mountPath, rawHandler] of Object.entries(
        server.Handlers as Record<string, unknown>,
      )) {
        if (!rawHandler || typeof rawHandler !== 'object' || Array.isArray(rawHandler)) {
          throw new Error(`Tailscale returned an invalid Serve handler: ${hostPort}${mountPath}`);
        }
        const handler = rawHandler as Record<string, unknown>;
        accumulator.resources.push({
          key: `${prefix}:web:${hostPort}:${mountPath}`,
          value: stableJson(handler),
        });
        if (typeof handler.Proxy === 'string') {
          accumulator.endpoints.push({
            dnsName: host,
            port,
            mountPath,
            proxyTarget: handler.Proxy,
            scope,
          });
        }
      }
    }
  }

  if (config.AllowFunnel !== undefined) {
    if (!config.AllowFunnel || typeof config.AllowFunnel !== 'object' || Array.isArray(config.AllowFunnel)) {
      throw new Error('Tailscale returned an invalid Funnel map');
    }
    for (const [hostPort, value] of Object.entries(
      config.AllowFunnel as Record<string, unknown>,
    )) {
      const { port } = parseHostPort(hostPort);
      if (typeof value !== 'boolean') throw new Error(`Tailscale returned invalid Funnel state: ${hostPort}`);
      if (scope !== 'service') accumulator.occupiedPorts.add(port);
      accumulator.resources.push({
        key: `${prefix}:allow-funnel:${hostPort}`,
        value: stableJson(value),
      });
    }
  }

  if (config.ETag !== undefined) {
    if (typeof config.ETag !== 'string') throw new Error('Tailscale returned an invalid Serve ETag');
    accumulator.resources.push({ key: `${prefix}:etag`, value: stableJson(config.ETag) });
  }

  if (config.Tun !== undefined) {
    if (scope !== 'service' || typeof config.Tun !== 'boolean') {
      throw new Error('Tailscale returned an invalid Service Tun setting');
    }
    accumulator.resources.push({ key: `${prefix}:tun`, value: stableJson(config.Tun) });
  }

  if (config.Foreground !== undefined) {
    if (!config.Foreground || typeof config.Foreground !== 'object' || Array.isArray(config.Foreground)) {
      throw new Error('Tailscale returned an invalid foreground Serve map');
    }
    for (const [sessionId, value] of Object.entries(
      config.Foreground as Record<string, unknown>,
    )) {
      collectServeConfig(value, 'foreground', `foreground:${sessionId}`, accumulator);
    }
  }

  if (config.Services !== undefined) {
    if (!config.Services || typeof config.Services !== 'object' || Array.isArray(config.Services)) {
      throw new Error('Tailscale returned an invalid Services map');
    }
    for (const [serviceName, value] of Object.entries(
      config.Services as Record<string, unknown>,
    )) {
      collectServeConfig(value, 'service', `service:${serviceName}`, accumulator);
    }
  }
}

export function parseTailscaleServeStatus(raw: string, nodeDnsName: string): TailscaleServeStatus {
  if (!raw.trim() || /^No serve config\.?$/i.test(raw.trim())) {
    return { endpoints: [], occupiedPorts: [], resources: [] };
  }
  const accumulator: ServeAccumulator = {
    endpoints: [],
    occupiedPorts: new Set<number>(),
    resources: [],
  };
  collectServeConfig(parseJsonObject(raw), 'background', 'background', accumulator);
  return {
    endpoints: accumulator.endpoints.sort((left, right) => (
      left.port - right.port || left.mountPath.localeCompare(right.mountPath)
    )),
    occupiedPorts: [...accumulator.occupiedPorts].sort((left, right) => left - right),
    resources: accumulator.resources.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export function parseTailscaleServeEndpoint(
  raw: string,
  nodeDnsName: string,
): TailscaleServeEndpoint | null {
  return parseTailscaleServeStatus(raw, nodeDnsName).endpoints.find((endpoint) => (
    endpoint.scope === 'background'
    && endpoint.dnsName === nodeDnsName
    && endpoint.port === 443
    && endpoint.mountPath === '/'
  )) ?? null;
}

export function buildTailscaleServeArguments(proxyTarget: string, port = 443): string[] {
  return [
    'serve',
    '--bg',
    '--yes',
    `--https=${port}`,
    '--set-path=/',
    proxyTarget,
  ];
}

function resolveTailscaleExecutable(): string {
  if (process.platform !== 'win32') return 'tailscale';

  const candidates = [
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe')
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'tailscale.exe';
}

function authorizationUrlFrom(value: string): string | undefined {
  const matches = value.match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/g) ?? [];
  return matches.map((match) => match.replace(/[),.;]+$/, '')).find((match) => {
    try {
      return new URL(match).protocol === 'https:';
    } catch {
      return false;
    }
  });
}

export function createCommandRunner(executable: string, timeoutMs = 15_000): CommandRunner {
  return (arguments_, options = {}) => new Promise<TailscaleCommandResult>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let authorizationUrl: string | undefined;
    let stoppedForAuthorization = false;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    const maxBuffer = 1024 * 1024;
    let timer: NodeJS.Timeout;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const succeed = (result: TailscaleCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const terminate = () => {
      child.kill('SIGKILL');
    };

    const stopIfNeeded = () => {
      if (stdout.length + stderr.length > maxBuffer) {
        outputExceeded = true;
        terminate();
        fail(new TailscaleCommandError('Tailscale command output exceeded 1 MiB'));
        return;
      }
      authorizationUrl = authorizationUrlFrom(`${stdout}\n${stderr}`);
      if (options.stopOnAuthorizationUrl && authorizationUrl && !child.killed) {
        stoppedForAuthorization = true;
        terminate();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      stopIfNeeded();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      stopIfNeeded();
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
      fail(new TailscaleCommandError(`Tailscale command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(new TailscaleCommandError(error.message, error.code));
    });
    child.once('close', (code, signal) => {
      if (outputExceeded) {
        fail(new TailscaleCommandError('Tailscale command output exceeded 1 MiB'));
        return;
      }
      if (timedOut) {
        fail(new TailscaleCommandError(`Tailscale command timed out after ${timeoutMs}ms`));
        return;
      }
      if (stoppedForAuthorization || code === 0) {
        succeed({ stdout, stderr, ...(authorizationUrl ? { authorizationUrl } : {}) });
        return;
      }
      fail(new TailscaleCommandError(
        stderr.trim() || stdout.trim() || `Tailscale exited with ${signal ?? code}`,
      ));
    });
  });
}

export class TailscaleCliAdapter implements TailscaleAdapter {
  private readonly run: CommandRunner;

  constructor(run: CommandRunner = createCommandRunner(resolveTailscaleExecutable())) {
    this.run = run;
  }

  async inspectNode(): Promise<TailscaleNodeStatus> {
    try {
      const result = await this.run(['status', '--json']);
      return parseTailscaleNodeStatus(result.stdout);
    } catch (error) {
      if (error instanceof TailscaleCommandError && error.code === 'ENOENT') {
        return { state: 'missing' };
      }
      throw error;
    }
  }

  async requestSignIn(): Promise<string | null> {
    const result = await this.run(
      ['up', '--json', '--timeout=10s'],
      { stopOnAuthorizationUrl: true },
    );
    return result.authorizationUrl ?? authorizationUrlFrom(result.stdout) ?? null;
  }

  async inspectServe(nodeDnsName: string): Promise<TailscaleServeStatus> {
    const result = await this.run(['serve', 'status', '--json']);
    return parseTailscaleServeStatus(result.stdout, nodeDnsName);
  }

  async configureServe(endpoint: TailscaleServeEndpoint): Promise<TailscaleConfigureResult> {
    const result = await this.run(
      buildTailscaleServeArguments(endpoint.proxyTarget, endpoint.port),
      { stopOnAuthorizationUrl: true },
    );
    const authorizationUrl = result.authorizationUrl
      ?? authorizationUrlFrom(`${result.stdout}\n${result.stderr}`);
    return authorizationUrl
      ? { state: 'authorization-required', authorizationUrl }
      : { state: 'configured' };
  }
}
