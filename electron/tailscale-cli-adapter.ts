import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  TailscaleAdapter,
  TailscaleNodeStatus,
  TailscaleServeEndpoint,
} from '../src/lib/mobile-access/mobile-access-coordinator';

type CommandRunner = (arguments_: string[]) => Promise<string>;

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tailscale returned an invalid JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function parseTailscaleNodeStatus(raw: string): TailscaleNodeStatus {
  const status = parseJsonObject(raw);
  const self = status.Self && typeof status.Self === 'object'
    ? status.Self as Record<string, unknown>
    : null;
  const rawDnsName = typeof self?.DNSName === 'string' ? self.DNSName : '';
  const dnsName = rawDnsName.replace(/\.+$/, '') || null;
  const certDomains = Array.isArray(status.CertDomains)
    ? status.CertDomains.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    connected: status.BackendState === 'Running',
    dnsName,
    httpsReady: Boolean(
      dnsName
      && certDomains.some((domain) => domain.replace(/\.+$/, '') === dnsName),
    ),
  };
}

function serveConfigs(status: Record<string, unknown>): Record<string, unknown>[] {
  const configs = [status];
  if (status.Foreground && typeof status.Foreground === 'object') {
    for (const value of Object.values(status.Foreground)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        configs.push(value as Record<string, unknown>);
      }
    }
  }
  return configs;
}

export function parseTailscaleServeEndpoint(
  raw: string,
  nodeDnsName: string,
): TailscaleServeEndpoint | null {
  if (!raw.trim() || /^No serve config\.?$/i.test(raw.trim())) return null;
  const status = parseJsonObject(raw);
  const hostPort = `${nodeDnsName}:443`;

  for (const config of serveConfigs(status)) {
    const tcp = config.TCP && typeof config.TCP === 'object'
      ? config.TCP as Record<string, unknown>
      : null;
    const port = tcp?.['443'];
    const portUsesHttps = Boolean(
      port && typeof port === 'object' && (port as Record<string, unknown>).HTTPS === true,
    );
    if (!portUsesHttps) continue;

    const web = config.Web && typeof config.Web === 'object'
      ? config.Web as Record<string, unknown>
      : null;
    const server = web?.[hostPort];
    if (!server || typeof server !== 'object') continue;
    const handlers = (server as Record<string, unknown>).Handlers;
    if (!handlers || typeof handlers !== 'object') continue;
    const root = (handlers as Record<string, unknown>)['/'];
    if (!root || typeof root !== 'object') continue;
    const proxyTarget = (root as Record<string, unknown>).Proxy;
    if (typeof proxyTarget !== 'string') continue;

    return {
      dnsName: nodeDnsName,
      port: 443,
      mountPath: '/',
      proxyTarget,
    };
  }

  return null;
}

export function buildTailscaleServeArguments(proxyTarget: string): string[] {
  return [
    'serve',
    '--bg',
    '--yes',
    '--https=443',
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

function createCommandRunner(executable: string): CommandRunner {
  return (arguments_) => new Promise<string>((resolve, reject) => {
    execFile(executable, arguments_, {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export class TailscaleCliAdapter implements TailscaleAdapter {
  private readonly run: CommandRunner;

  constructor(run: CommandRunner = createCommandRunner(resolveTailscaleExecutable())) {
    this.run = run;
  }

  async inspectNode(): Promise<TailscaleNodeStatus> {
    return parseTailscaleNodeStatus(await this.run(['status', '--json']));
  }

  async inspectServe(nodeDnsName: string): Promise<TailscaleServeEndpoint | null> {
    return parseTailscaleServeEndpoint(
      await this.run(['serve', 'status', '--json']),
      nodeDnsName,
    );
  }

  async configureServe(endpoint: TailscaleServeEndpoint): Promise<void> {
    await this.run(buildTailscaleServeArguments(endpoint.proxyTarget));
  }
}
