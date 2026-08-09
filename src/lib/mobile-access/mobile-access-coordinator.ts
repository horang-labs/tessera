import {
  MOBILE_ACCESS_OWNER,
  type MobileAccessOwnership,
  type MobileAccessStateStore,
} from './mobile-access-state-store';

export interface TailscaleNodeStatus {
  connected: boolean;
  dnsName: string | null;
  httpsReady: boolean;
}

export interface TailscaleServeEndpoint {
  dnsName: string;
  port: 443;
  mountPath: '/';
  proxyTarget: string;
}

export interface TailscaleAdapter {
  inspectNode(): Promise<TailscaleNodeStatus>;
  inspectServe(nodeDnsName: string): Promise<TailscaleServeEndpoint | null>;
  configureServe(endpoint: TailscaleServeEndpoint): Promise<void>;
}

export type MobileAccessErrorCode =
  | 'tailscale-not-connected'
  | 'tailscale-https-unavailable'
  | 'serve-root-in-use'
  | 'serve-verification-failed'
  | 'setup-failed';

export type MobileAccessStatus =
  | { state: 'not-configured'; error?: { code: MobileAccessErrorCode; message: string } }
  | { state: 'configuring' }
  | { state: 'ready'; origin: string };

class MobileAccessSetupError extends Error {
  constructor(readonly code: MobileAccessErrorCode, message: string) {
    super(message);
    this.name = 'MobileAccessSetupError';
  }
}

function exactEndpoint(
  endpoint: TailscaleServeEndpoint | null,
  expected: TailscaleServeEndpoint,
): boolean {
  const normalizeTarget = (value: string) => {
    try {
      return new URL(value).toString();
    } catch {
      return value;
    }
  };
  return endpoint?.dnsName === expected.dnsName
    && endpoint.port === expected.port
    && endpoint.mountPath === expected.mountPath
    && normalizeTarget(endpoint.proxyTarget) === normalizeTarget(expected.proxyTarget);
}

function ownsEndpoint(
  ownership: MobileAccessOwnership | null,
  endpoint: TailscaleServeEndpoint,
): boolean {
  return ownership?.owner === MOBILE_ACCESS_OWNER
    && ownership.nodeDnsName === endpoint.dnsName
    && ownership.servePort === endpoint.port
    && ownership.mountPath === endpoint.mountPath
    && ownership.origin === `https://${endpoint.dnsName}`
    && exactEndpoint(endpoint, {
      dnsName: ownership.nodeDnsName,
      port: ownership.servePort,
      mountPath: ownership.mountPath,
      proxyTarget: ownership.lastLoopbackTarget,
    });
}

export class MobileAccessCoordinator {
  private status: MobileAccessStatus = { state: 'not-configured' };
  private setupPromise: Promise<MobileAccessStatus> | null = null;

  constructor(private readonly dependencies: {
    adapter: TailscaleAdapter;
    stateStore: MobileAccessStateStore;
    checkHealth(origin: string): Promise<void>;
    publishPairingOrigin(origin: string): Promise<void>;
  }) {}

  async getStatus(): Promise<MobileAccessStatus> {
    if (this.status.state === 'configuring') return this.status;

    const ownership = await this.dependencies.stateStore.load();
    if (!ownership) {
      this.status = { state: 'not-configured' };
      return this.status;
    }

    try {
      const node = await this.requireReadyNode();
      if (node.dnsName !== ownership.nodeDnsName) {
        throw new MobileAccessSetupError(
          'serve-verification-failed',
          'The configured Tailscale node changed',
        );
      }
      const endpoint = await this.dependencies.adapter.inspectServe(ownership.nodeDnsName);
      const expected = this.endpointFor(ownership.nodeDnsName, ownership.lastLoopbackTarget);
      if (!exactEndpoint(endpoint, expected)) {
        throw new MobileAccessSetupError(
          'serve-verification-failed',
          'The owned Tailscale Serve endpoint is not active',
        );
      }
      await this.dependencies.checkHealth(ownership.origin);
      await this.dependencies.publishPairingOrigin(ownership.origin);
      this.status = { state: 'ready', origin: ownership.origin };
    } catch (error) {
      this.status = this.failureStatus(error);
    }
    return this.status;
  }

  setup({ loopbackPort }: { loopbackPort: number }): Promise<MobileAccessStatus> {
    if (this.setupPromise) return this.setupPromise;
    this.status = { state: 'configuring' };
    this.setupPromise = this.runSetup(loopbackPort).finally(() => {
      this.setupPromise = null;
    });
    return this.setupPromise;
  }

  private async runSetup(loopbackPort: number): Promise<MobileAccessStatus> {
    try {
      const node = await this.requireReadyNode();
      const dnsName = node.dnsName as string;
      const origin = `https://${dnsName}`;
      const loopbackTarget = `http://127.0.0.1:${loopbackPort}`;
      const endpoint = this.endpointFor(dnsName, loopbackTarget);
      const [existingEndpoint, ownership] = await Promise.all([
        this.dependencies.adapter.inspectServe(dnsName),
        this.dependencies.stateStore.load(),
      ]);

      if (existingEndpoint && !ownsEndpoint(ownership, existingEndpoint)) {
        throw new MobileAccessSetupError(
          'serve-root-in-use',
          'Tailscale HTTPS port 443 root is already in use',
        );
      }

      if (!exactEndpoint(existingEndpoint, endpoint)) {
        await this.dependencies.adapter.configureServe(endpoint);
      }

      const verifiedEndpoint = await this.dependencies.adapter.inspectServe(dnsName);
      if (!exactEndpoint(verifiedEndpoint, endpoint)) {
        throw new MobileAccessSetupError(
          'serve-verification-failed',
          'Tailscale Serve did not retain the Tessera endpoint',
        );
      }

      await this.dependencies.checkHealth(origin);
      await this.dependencies.stateStore.save({
        schemaVersion: 1,
        owner: MOBILE_ACCESS_OWNER,
        nodeDnsName: dnsName,
        origin,
        servePort: 443,
        mountPath: '/',
        lastLoopbackTarget: loopbackTarget,
      });
      await this.dependencies.publishPairingOrigin(origin);
      this.status = { state: 'ready', origin };
    } catch (error) {
      this.status = this.failureStatus(error);
    }
    return this.status;
  }

  private async requireReadyNode(): Promise<TailscaleNodeStatus & { dnsName: string }> {
    const node = await this.dependencies.adapter.inspectNode();
    if (!node.connected || !node.dnsName) {
      throw new MobileAccessSetupError(
        'tailscale-not-connected',
        'Tailscale is not connected',
      );
    }
    if (!node.httpsReady) {
      throw new MobileAccessSetupError(
        'tailscale-https-unavailable',
        'Tailscale HTTPS is not ready for this node',
      );
    }
    return { ...node, dnsName: node.dnsName };
  }

  private endpointFor(dnsName: string, proxyTarget: string): TailscaleServeEndpoint {
    return { dnsName, port: 443, mountPath: '/', proxyTarget };
  }

  private failureStatus(error: unknown): MobileAccessStatus {
    const setupError = error instanceof MobileAccessSetupError
      ? error
      : new MobileAccessSetupError(
          'setup-failed',
          error instanceof Error ? error.message : String(error),
        );
    return {
      state: 'not-configured',
      error: { code: setupError.code, message: setupError.message },
    };
  }
}
