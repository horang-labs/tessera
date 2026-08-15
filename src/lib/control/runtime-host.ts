import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { configureSharedProviderControlCliBridge } from '@/lib/terminal/shared-provider-launch-module';
import { createControlCliBridgeFactory } from './cli-bridge';
import { createDatabaseControlProjectSource } from './database-project-source';
import { createDatabaseControlSessionSource } from './database-session-source';
import { createDatabaseControlWorktreeSource } from './database-worktree-source';
import { createControlHttpHandler } from './http-handler';
import { createRequiredControlUserIdResolver } from './required-user-context';
import { publishRuntimeDescriptor } from './runtime-descriptor';
import { createControlService } from './service';
import { createTerminalControlSessionController } from './session-controller';
import { createDatabaseControlSessionMutator } from './session-mutator';
import { createTerminalControlSessionObserver } from './session-observer';
import { resolveControlUserId } from './user-context';
import { createDatabaseControlWorktreeCreator } from './worktree-creator';
import { SettingsManager } from '@/lib/settings/manager';
import { captureServerTelemetryEvent } from '@/lib/telemetry/server';

export interface ControlRuntimeHost {
  runtimeId: string;
  close(): Promise<void>;
}

export interface StartControlRuntimeHostOptions {
  appVersion: string;
  appRoot: string;
  runtimeDirectory?: string;
  descriptorPath?: string;
  bridgeArtifactRoot?: string;
  hostExecutablePath?: string;
  cliEntryPath?: string;
  resolveUserId?: () => Promise<string | undefined>;
}

export async function startControlRuntimeHost(
  options: StartControlRuntimeHostOptions,
): Promise<ControlRuntimeHost> {
  const server = createServer();
  let requestHandler: ReturnType<typeof createControlHttpHandler> | null = null;
  server.on('request', (request, response) => {
    if (!requestHandler) {
      response.writeHead(503).end();
      return;
    }
    void requestHandler(request, response).then((handled) => {
      if (!handled && !response.headersSent) response.writeHead(404).end();
    });
  });

  let descriptorHandle: Awaited<ReturnType<typeof publishRuntimeDescriptor>> | null = null;
  let releaseBridge: (() => Promise<void>) | null = null;
  try {
    const port = await listenOnLoopback(server);
    descriptorHandle = await publishRuntimeDescriptor({
      appVersion: options.appVersion,
      origin: `http://127.0.0.1:${port}`,
      runtimeDirectory: options.runtimeDirectory,
      descriptorPath: options.descriptorPath,
    });
    const bridgeFactory = createControlCliBridgeFactory({
      runtimeId: descriptorHandle.descriptor.runtimeId,
      descriptorPath: descriptorHandle.path,
      cliEntryPath: options.cliEntryPath ?? path.join(options.appRoot, 'bin', 'tessera.mjs'),
      hostExecutablePath: options.hostExecutablePath ?? process.execPath,
      artifactRoot: options.bridgeArtifactRoot,
    });
    releaseBridge = configureSharedProviderControlCliBridge(bridgeFactory);
    const requireUserId = createRequiredControlUserIdResolver({
      resolveUserId: options.resolveUserId ?? resolveControlUserId,
    });
    requestHandler = createControlHttpHandler({
      descriptor: descriptorHandle.descriptor,
      captureTelemetry: async ({ operation, result }) => {
        const userId = await requireUserId();
        const settings = await SettingsManager.load(userId, { silent: true });
        if (!settings.telemetry.enabled) return;
        await captureServerTelemetryEvent('tessera_cli_command', { operation, result });
      },
      service: createControlService({
        appVersion: options.appVersion,
        runtimeId: descriptorHandle.descriptor.runtimeId,
        projects: createDatabaseControlProjectSource(),
        worktrees: createDatabaseControlWorktreeSource(),
        worktreeCreator: createDatabaseControlWorktreeCreator({
          resolveUserId: requireUserId,
        }),
        sessions: createDatabaseControlSessionSource(),
        sessionMutator: createDatabaseControlSessionMutator({
          resolveUserId: requireUserId,
        }),
        sessionObserver: createTerminalControlSessionObserver({
          resolveUserId: requireUserId,
        }),
        sessionController: createTerminalControlSessionController({
          resolveUserId: requireUserId,
        }),
      }),
    });
  } catch (error) {
    await releaseBridge?.().catch(() => undefined);
    await descriptorHandle?.cleanup().catch(() => undefined);
    await closeHttpServer(server).catch(() => undefined);
    throw error;
  }

  const activeDescriptor = descriptorHandle;
  const activeReleaseBridge = releaseBridge;
  let closed = false;
  let closeInFlight: Promise<void> | null = null;
  return {
    runtimeId: activeDescriptor.descriptor.runtimeId,
    async close(): Promise<void> {
      if (closed) return;
      if (closeInFlight) return closeInFlight;
      requestHandler = null;
      const closing = (async () => {
        let firstError: unknown;
        for (const cleanup of [
          () => closeHttpServer(server),
          activeReleaseBridge,
          () => activeDescriptor.cleanup(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError) throw firstError;
        closed = true;
      })();
      closeInFlight = closing;
      try {
        await closing;
      } finally {
        if (closeInFlight === closing) closeInFlight = null;
      }
    },
  };
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
