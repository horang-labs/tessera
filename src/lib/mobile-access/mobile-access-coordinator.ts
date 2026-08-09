import {
  MOBILE_ACCESS_OWNER,
  type MobileAccessOwnership,
  type MobileAccessPersistedState,
  type MobileAccessSetupProgress,
  type MobileAccessStateStore,
} from './mobile-access-state-store';

export type TailscaleNodeStatus =
  | { state: 'missing' }
  | { state: 'needs-login'; authorizationUrl?: string }
  | { state: 'needs-machine-authorization'; authorizationUrl?: string }
  | { state: 'stopped' | 'starting' }
  | { state: 'running'; dnsName: string; httpsReady: boolean }
  | { state: 'unsupported'; backendState: string };

export interface TailscaleServeEndpoint {
  dnsName: string;
  port: number;
  mountPath: string;
  proxyTarget: string;
  scope?: 'background' | 'foreground' | 'service';
}

export interface TailscaleServeStatus {
  endpoints: TailscaleServeEndpoint[];
  occupiedPorts: number[];
  resources: Array<{ key: string; value: string }>;
}

export type TailscaleConfigureResult =
  | { state: 'configured' }
  | { state: 'authorization-required'; authorizationUrl: string };

export interface TailscaleAdapter {
  inspectNode(): Promise<TailscaleNodeStatus>;
  requestSignIn(): Promise<string | null>;
  inspectServe(nodeDnsName: string): Promise<TailscaleServeStatus>;
  configureServe(endpoint: TailscaleServeEndpoint): Promise<TailscaleConfigureResult>;
}

export type MobileAccessStatus =
  | { state: 'not-configured' }
  | { state: 'tailscale-missing'; installUrl: string }
  | { state: 'sign-in-required'; authorizationUrl?: string }
  | { state: 'authorization-required'; authorizationUrl?: string }
  | { state: 'configuring' }
  | {
    state: 'temporarily-unavailable';
    reason: 'missing' | 'signed-out' | 'machine-authorization' | 'stopped' | 'starting';
    message: string;
  }
  | {
    state: 'ownership-conflict';
    reason?: 'origin-changed';
    message: string;
  }
  | { state: 'retryable-failure'; message: string }
  | { state: 'ready'; origin: string };

export const MOBILE_ACCESS_HTTPS_PORT_CANDIDATES = [10_443, 11_443, 12_443, 13_443] as const;

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';

function isSetupProgress(
  state: MobileAccessPersistedState | null,
): state is MobileAccessSetupProgress {
  return state !== null && 'phase' in state && state.phase === 'setup';
}

function normalizeTarget(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function exactEndpoint(
  endpoint: TailscaleServeEndpoint | undefined,
  expected: TailscaleServeEndpoint,
): boolean {
  return Boolean(endpoint
    && endpoint.scope !== 'foreground'
    && endpoint?.scope !== 'service'
    && endpoint.dnsName === expected.dnsName
    && endpoint.port === expected.port
    && endpoint.mountPath === expected.mountPath
    && normalizeTarget(endpoint.proxyTarget) === normalizeTarget(expected.proxyTarget));
}

function endpointAt(
  status: TailscaleServeStatus,
  dnsName: string,
  port: number,
): TailscaleServeEndpoint | undefined {
  return status.endpoints.find((endpoint) => (
    endpoint.scope !== 'foreground'
    && endpoint.scope !== 'service'
    && endpoint.dnsName === dnsName
    && endpoint.port === port
    && endpoint.mountPath === '/'
  ));
}

function rootResourceKey(dnsName: string, port: number): string {
  return `background:web:${dnsName}:${port}:/`;
}

function rootIsOccupied(status: TailscaleServeStatus, dnsName: string, port: number): boolean {
  return status.resources.some((resource) => resource.key === rootResourceKey(dnsName, port));
}

function portCanHostOwnedHttpsRoot(status: TailscaleServeStatus, port: number): boolean {
  if (!status.occupiedPorts.includes(port)) return true;
  const tcp = status.resources.find((resource) => (
    resource.key === `background:tcp:${port}`
  ));
  if (tcp?.value !== '{"HTTPS":true}') return false;

  return !status.resources.some((resource) => (
    resource.key.startsWith('background:allow-funnel:')
      && resource.key.endsWith(`:${port}`)
    || resource.key.startsWith('foreground:')
      && (
        resource.key.endsWith(`:tcp:${port}`)
        || resource.key.includes(`:${port}:/`)
        || resource.key.endsWith(`:${port}`)
      )
  ));
}

function unrelatedResources(
  status: TailscaleServeStatus,
  endpoint: TailscaleServeEndpoint,
): Array<{ key: string; value: string }> {
  const ignored = new Set([
    `background:tcp:${endpoint.port}`,
    rootResourceKey(endpoint.dnsName, endpoint.port),
  ]);
  return status.resources.filter((resource) => (
    !ignored.has(resource.key) && !resource.key.endsWith(':etag')
  ));
}

function sameResources(
  before: Array<{ key: string; value: string }>,
  after: Array<{ key: string; value: string }>,
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function originFor(dnsName: string, port: number): string {
  return `https://${dnsName}${port === 443 ? '' : `:${port}`}`;
}

function retryableFailure(error: unknown): MobileAccessStatus {
  return {
    state: 'retryable-failure',
    message: error instanceof Error ? error.message : String(error),
  };
}

function originChangedStatus(): MobileAccessStatus {
  return {
    state: 'ownership-conflict',
    reason: 'origin-changed',
    message: 'The Tailscale node or tailnet domain changed. Remove the mobile connection, then set it up again.',
  };
}

export class MobileAccessCoordinator {
  private status: MobileAccessStatus = { state: 'not-configured' };
  private configuredConnection = false;
  private setupPromise: Promise<MobileAccessStatus> | null = null;
  private readonly openedAuthorizationUrls = new Set<string>();

  constructor(private readonly dependencies: {
    adapter: TailscaleAdapter;
    stateStore: MobileAccessStateStore;
    checkHealth(origin: string): Promise<void>;
    publishPairingOrigin(origin: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  }) {}

  hasConfiguredConnection(): boolean {
    return this.configuredConnection;
  }

  async getStatus(): Promise<MobileAccessStatus> {
    if (this.setupPromise) return { state: 'configuring' };

    const persisted = await this.dependencies.stateStore.load();
    if (isSetupProgress(persisted)) {
      return this.setup({ loopbackPort: persisted.loopbackPort });
    }
    if (!persisted) {
      try {
        this.status = this.statusForNode(await this.dependencies.adapter.inspectNode());
      } catch (error) {
        this.status = retryableFailure(error);
      }
      return this.status;
    }

    try {
      const node = await this.dependencies.adapter.inspectNode();
      if (node.state !== 'running') {
        this.status = this.statusForConfiguredNode(node);
        return this.status;
      }
      if (node.dnsName !== persisted.nodeDnsName) {
        this.status = originChangedStatus();
        return this.status;
      }
      const serve = await this.dependencies.adapter.inspectServe(node.dnsName);
      const expected = this.endpointFor(
        node.dnsName,
        persisted.servePort,
        persisted.lastLoopbackTarget,
      );
      if (!exactEndpoint(endpointAt(serve, node.dnsName, persisted.servePort), expected)) {
        this.status = {
          state: 'ownership-conflict',
          message: 'The Tessera-owned Tailscale Serve endpoint changed',
        };
        return this.status;
      }
      if (!node.httpsReady) {
        this.status = { state: 'authorization-required' };
        return this.status;
      }
      await this.dependencies.checkHealth(persisted.origin);
      await this.dependencies.publishPairingOrigin(persisted.origin);
      this.status = { state: 'ready', origin: persisted.origin };
    } catch (error) {
      this.status = retryableFailure(error);
    }
    return this.status;
  }

  async reconcileOnLaunch(
    { loopbackPort }: { loopbackPort: number },
  ): Promise<MobileAccessStatus> {
    try {
      const persisted = await this.dependencies.stateStore.load();
      this.configuredConnection = Boolean(persisted && !isSetupProgress(persisted));
      if (!persisted || isSetupProgress(persisted)) return this.status;

      const node = await this.dependencies.adapter.inspectNode();
      if (node.state !== 'running') {
        return this.remember(this.statusForConfiguredNode(node));
      }
      if (node.dnsName !== persisted.nodeDnsName) {
        return this.remember(originChangedStatus());
      }

      const serve = await this.dependencies.adapter.inspectServe(node.dnsName);
      const expected = this.endpointFor(
        node.dnsName,
        persisted.servePort,
        `http://127.0.0.1:${loopbackPort}`,
      );
      const existing = endpointAt(serve, node.dnsName, persisted.servePort);
      const previous = this.endpointFor(
        node.dnsName,
        persisted.servePort,
        persisted.lastLoopbackTarget,
      );
      const endpointIsFree = !existing
        && !rootIsOccupied(serve, node.dnsName, persisted.servePort)
        && portCanHostOwnedHttpsRoot(serve, persisted.servePort);
      if (
        !exactEndpoint(existing, expected)
        && !exactEndpoint(existing, previous)
        && !endpointIsFree
      ) {
        return this.remember({
          state: 'ownership-conflict',
          message: 'The Tessera-owned Tailscale Serve endpoint changed',
        });
      }

      if (!exactEndpoint(existing, expected)) {
        const unrelatedBefore = unrelatedResources(serve, expected);
        const result = await this.dependencies.adapter.configureServe(expected);
        if (result.state === 'authorization-required') {
          return this.remember({
            state: 'authorization-required',
            authorizationUrl: result.authorizationUrl,
          });
        }
        const [verifiedNode, verifiedServe] = await Promise.all([
          this.dependencies.adapter.inspectNode(),
          this.dependencies.adapter.inspectServe(node.dnsName),
        ]);
        if (!sameResources(unrelatedBefore, unrelatedResources(verifiedServe, expected))) {
          return this.remember({
            state: 'retryable-failure',
            message: 'Unrelated Tailscale Serve or Funnel configuration changed',
          });
        }
        if (verifiedNode.state !== 'running') {
          return this.remember(this.statusForConfiguredNode(verifiedNode));
        }
        if (verifiedNode.dnsName !== node.dnsName) {
          return this.remember(originChangedStatus());
        }
        if (!exactEndpoint(
          endpointAt(verifiedServe, node.dnsName, persisted.servePort),
          expected,
        )) {
          return this.remember({
            state: 'retryable-failure',
            message: 'Tailscale Serve did not retain the Tessera endpoint',
          });
        }
        if (persisted.lastLoopbackTarget !== expected.proxyTarget) {
          await this.dependencies.stateStore.save({
            ...persisted,
            lastLoopbackTarget: expected.proxyTarget,
          });
        }
      }

      await this.dependencies.checkHealth(persisted.origin);
      return this.remember({ state: 'ready', origin: persisted.origin });
    } catch (error) {
      return this.remember(retryableFailure(error));
    }
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
      let persisted = await this.dependencies.stateStore.load();
      let progress = this.progressFor(persisted, loopbackPort);
      await this.dependencies.stateStore.save(progress);

      const node = await this.dependencies.adapter.inspectNode();
      const prerequisiteStatus = await this.handleNodePrerequisite(node);
      if (prerequisiteStatus) return this.remember(prerequisiteStatus);
      if (node.state !== 'running') {
        return this.remember({ state: 'retryable-failure', message: 'Invalid Tailscale state' });
      }

      if (progress.nodeDnsName && progress.nodeDnsName !== node.dnsName) {
        return this.remember({
          state: 'ownership-conflict',
          message: 'The Tailscale node changed during setup',
        });
      }

      const loopbackTarget = `http://127.0.0.1:${loopbackPort}`;
      const before = await this.dependencies.adapter.inspectServe(node.dnsName);
      const servePort = this.selectServePort(before, node.dnsName, loopbackTarget, progress);
      if (servePort === null) {
        return this.remember({
          state: 'ownership-conflict',
          message: progress.selectedServePort === undefined
            ? 'No safe Tailscale HTTPS port is available'
            : `Tailscale HTTPS port ${progress.selectedServePort} is no longer safe to configure`,
        });
      }

      progress = {
        ...progress,
        selectedServePort: servePort,
        nodeDnsName: node.dnsName,
      };
      await this.dependencies.stateStore.save(progress);

      const endpoint = this.endpointFor(node.dnsName, servePort, loopbackTarget);
      const existing = endpointAt(before, node.dnsName, servePort);
      const ownsExisting = progress.previousLoopbackTarget !== undefined
        && exactEndpoint(existing, this.endpointFor(
          node.dnsName,
          servePort,
          progress.previousLoopbackTarget,
        ));
      if (
        rootIsOccupied(before, node.dnsName, servePort)
        && !exactEndpoint(existing, endpoint)
        && !ownsExisting
      ) {
        return this.remember({
          state: 'ownership-conflict',
          message: `Tailscale HTTPS port ${servePort} root is owned by another service`,
        });
      }

      const shouldConfigure = !exactEndpoint(existing, endpoint) || !node.httpsReady;
      let verifiedNode: TailscaleNodeStatus = node;
      let verifiedServe = before;
      if (shouldConfigure) {
        const unrelatedBefore = unrelatedResources(before, endpoint);
        const result = await this.dependencies.adapter.configureServe(endpoint);
        if (result.state === 'authorization-required') {
          await this.openAuthorization(result.authorizationUrl);
          return this.remember({
            state: 'authorization-required',
            authorizationUrl: result.authorizationUrl,
          });
        }

        [verifiedNode, verifiedServe] = await Promise.all([
          this.dependencies.adapter.inspectNode(),
          this.dependencies.adapter.inspectServe(node.dnsName),
        ]);
        if (!sameResources(unrelatedBefore, unrelatedResources(verifiedServe, endpoint))) {
          return this.remember({
            state: 'retryable-failure',
            message: 'Unrelated Tailscale Serve or Funnel configuration changed',
          });
        }
      }

      if (verifiedNode.state !== 'running' || verifiedNode.dnsName !== node.dnsName) {
        return this.remember(this.statusForNode(verifiedNode));
      }
      if (!verifiedNode.httpsReady) {
        return this.remember({ state: 'authorization-required' });
      }
      if (!exactEndpoint(endpointAt(verifiedServe, node.dnsName, servePort), endpoint)) {
        return this.remember({
          state: 'retryable-failure',
          message: 'Tailscale Serve did not retain the Tessera endpoint',
        });
      }

      const origin = originFor(node.dnsName, servePort);
      await this.dependencies.checkHealth(origin);
      const ownership: MobileAccessOwnership = {
        schemaVersion: 1,
        owner: MOBILE_ACCESS_OWNER,
        nodeDnsName: node.dnsName,
        origin,
        servePort,
        mountPath: '/',
        lastLoopbackTarget: loopbackTarget,
      };
      await this.dependencies.stateStore.save(ownership);
      this.configuredConnection = true;
      await this.dependencies.publishPairingOrigin(origin);
      return this.remember({ state: 'ready', origin });
    } catch (error) {
      return this.remember(retryableFailure(error));
    }
  }

  private progressFor(
    persisted: MobileAccessPersistedState | null,
    loopbackPort: number,
  ): MobileAccessSetupProgress {
    if (isSetupProgress(persisted) && persisted.loopbackPort === loopbackPort) return persisted;
    return {
      schemaVersion: 1,
      owner: MOBILE_ACCESS_OWNER,
      phase: 'setup',
      loopbackPort,
      ...(!persisted || isSetupProgress(persisted) ? {} : {
        selectedServePort: persisted.servePort,
        nodeDnsName: persisted.nodeDnsName,
        previousLoopbackTarget: persisted.lastLoopbackTarget,
      }),
    };
  }

  private async handleNodePrerequisite(
    node: TailscaleNodeStatus,
  ): Promise<MobileAccessStatus | null> {
    if (node.state === 'running') return null;
    if (node.state === 'needs-login') {
      const authorizationUrl = node.authorizationUrl
        ?? await this.dependencies.adapter.requestSignIn()
        ?? undefined;
      if (authorizationUrl) await this.openAuthorization(authorizationUrl);
      return {
        state: 'sign-in-required',
        ...(authorizationUrl ? { authorizationUrl } : {}),
      };
    }
    return this.statusForNode(node);
  }

  private statusForNode(node: TailscaleNodeStatus): MobileAccessStatus {
    switch (node.state) {
      case 'missing':
        return { state: 'tailscale-missing', installUrl: TAILSCALE_DOWNLOAD_URL };
      case 'needs-login':
        return {
          state: 'sign-in-required',
          ...(node.authorizationUrl ? { authorizationUrl: node.authorizationUrl } : {}),
        };
      case 'needs-machine-authorization':
        return {
          state: 'temporarily-unavailable',
          reason: 'machine-authorization',
          message: 'This Tailscale device is awaiting administrator approval',
        };
      case 'stopped':
        return {
          state: 'temporarily-unavailable',
          reason: 'stopped',
          message: 'Tailscale is stopped',
        };
      case 'starting':
        return {
          state: 'temporarily-unavailable',
          reason: 'starting',
          message: 'Tailscale is starting',
        };
      case 'unsupported':
        return {
          state: 'retryable-failure',
          message: `Unsupported Tailscale state: ${node.backendState}`,
        };
      case 'running':
        return { state: 'not-configured' };
    }
  }

  private statusForConfiguredNode(node: TailscaleNodeStatus): MobileAccessStatus {
    if (node.state === 'missing') {
      return {
        state: 'temporarily-unavailable',
        reason: 'missing',
        message: 'Tailscale is not installed',
      };
    }
    if (node.state === 'needs-login') {
      return {
        state: 'temporarily-unavailable',
        reason: 'signed-out',
        message: 'Tailscale is signed out',
      };
    }
    return this.statusForNode(node);
  }

  private selectServePort(
    serve: TailscaleServeStatus,
    dnsName: string,
    loopbackTarget: string,
    progress: MobileAccessSetupProgress,
  ): number | null {
    if (progress.selectedServePort !== undefined) {
      const retainedPort = progress.selectedServePort;
      const retainedEndpoint = endpointAt(serve, dnsName, retainedPort);
      const ownsRetainedRoot = exactEndpoint(
        retainedEndpoint,
        this.endpointFor(dnsName, retainedPort, loopbackTarget),
      ) || progress.previousLoopbackTarget !== undefined && exactEndpoint(
        retainedEndpoint,
        this.endpointFor(dnsName, retainedPort, progress.previousLoopbackTarget),
      );
      if (!portCanHostOwnedHttpsRoot(serve, retainedPort)) return null;
      if (rootIsOccupied(serve, dnsName, retainedPort) && !ownsRetainedRoot) return null;
      return retainedPort;
    }

    const preferred = this.endpointFor(dnsName, 443, loopbackTarget);
    const existingPreferred = endpointAt(serve, dnsName, 443);
    if (
      exactEndpoint(existingPreferred, preferred)
      || !rootIsOccupied(serve, dnsName, 443) && portCanHostOwnedHttpsRoot(serve, 443)
    ) {
      return 443;
    }
    return MOBILE_ACCESS_HTTPS_PORT_CANDIDATES.find((port) => (
      !serve.occupiedPorts.includes(port)
    )) ?? null;
  }

  private endpointFor(
    dnsName: string,
    port: number,
    proxyTarget: string,
  ): TailscaleServeEndpoint {
    return { dnsName, port, mountPath: '/', proxyTarget, scope: 'background' };
  }

  private async openAuthorization(url: string): Promise<void> {
    if (this.openedAuthorizationUrls.has(url)) return;
    await this.dependencies.openExternal(url);
    this.openedAuthorizationUrls.add(url);
  }

  private remember(status: MobileAccessStatus): MobileAccessStatus {
    this.status = status;
    return status;
  }
}
