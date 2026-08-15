import os from 'node:os';
import path from 'node:path';

export const ELECTRON_TEST_INSTANCE_ENV = 'TESSERA_ELECTRON_TEST_INSTANCE';
export const ELECTRON_TEST_ROOT_ENV = 'TESSERA_ELECTRON_TEST_ROOT';
export const ELECTRON_TEST_SERVER_PORT_ENV = 'TESSERA_ELECTRON_TEST_SERVER_PORT';

const SAFE_TEST_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ElectronTestInstanceConfig {
  instanceId: string;
  rootDir: string;
  dataDir: string;
  userDataDir: string;
}

interface ResolveElectronTestInstanceOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tmpDir?: string;
}

interface ElectronAppPathSetter {
  setPath(name: 'userData', value: string): void;
}

export function readElectronTestInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const instanceId = env[ELECTRON_TEST_INSTANCE_ENV]?.trim();
  if (!instanceId) return null;
  if (!SAFE_TEST_INSTANCE_ID.test(instanceId)) {
    throw new Error(
      `${ELECTRON_TEST_INSTANCE_ENV} must match ${SAFE_TEST_INSTANCE_ID.source}`,
    );
  }
  return instanceId;
}

export function resolveElectronTestInstanceConfig(
  options: ResolveElectronTestInstanceOptions = {},
): ElectronTestInstanceConfig | null {
  const env = options.env ?? process.env;
  const instanceId = readElectronTestInstanceId(env);
  if (!instanceId) return null;

  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const configuredRoot = env[ELECTRON_TEST_ROOT_ENV]?.trim();
  const defaultRoot = platform === 'win32' && env.LOCALAPPDATA?.trim()
    ? path.win32.join(env.LOCALAPPDATA.trim(), 'TesseraTestInstances')
    : pathApi.join(options.tmpDir ?? os.tmpdir(), 'tessera-electron-test-instances');
  const rootDir = pathApi.resolve(configuredRoot || defaultRoot, instanceId);

  return {
    instanceId,
    rootDir,
    dataDir: pathApi.join(rootDir, 'data'),
    userDataDir: pathApi.join(rootDir, 'user-data'),
  };
}

/**
 * Configure test-only state before Electron computes any app data paths.
 * A normal launch has no test instance id and remains completely unchanged.
 */
export function configureElectronTestInstance(
  app: ElectronAppPathSetter,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ResolveElectronTestInstanceOptions, 'env'> = {},
): ElectronTestInstanceConfig | null {
  const config = resolveElectronTestInstanceConfig({ ...options, env });
  if (!config) return null;

  env.TESSERA_DATA_DIR = config.dataDir;
  app.setPath('userData', config.userDataDir);
  return config;
}

export function acquireElectronInstanceLock(
  requestSingleInstanceLock: () => boolean,
  testInstance: ElectronTestInstanceConfig | null,
): boolean {
  // Every test instance owns isolated data and userData roots. Bypass the
  // product-wide lock only for this explicit test seam so 4-5 packaged apps
  // can run together. Normal launches still execute Electron's real lock.
  return testInstance ? true : requestSingleInstanceLock();
}

export function resolveElectronServerPort(
  defaultPort: number,
  testInstance: ElectronTestInstanceConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!testInstance) return defaultPort;

  const rawPort = env[ELECTRON_TEST_SERVER_PORT_ENV]?.trim();
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${ELECTRON_TEST_SERVER_PORT_ENV} must be an integer between 1024 and 65535`,
    );
  }
  return port;
}

export function resolveElectronWindowTitle(
  baseTitle: string,
  testInstance: ElectronTestInstanceConfig | null,
): string {
  return testInstance
    ? `${baseTitle} [TEST · ${testInstance.instanceId}]`
    : baseTitle;
}

export function getWslGuestTesseraStateRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const instanceId = readElectronTestInstanceId(env);
  return instanceId
    ? `$HOME/.tessera/test-instances/${instanceId}`
    : '$HOME/.tessera';
}
