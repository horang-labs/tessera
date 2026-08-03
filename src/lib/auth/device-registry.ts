import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger';
import { getTesseraDataPath } from '../tessera-data-dir';

const DEVICE_TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PAIRING_TOKEN_TTL_MS = 2 * 60 * 1000;
export const MAX_PAIRED_DEVICES = 8;
export const DEVICE_TOKEN_COOKIE = 'device';

export function getDeviceRegistryPath(): string {
  return getTesseraDataPath('auth', 'device-registry.json');
}

interface StoredDevice {
  id: string;
  token: string;
  name: string;
  registeredAt: string;
  lastSeenAt: string | null;
}

interface StoredPairingToken {
  token: string;
  createdAt: string;
  expiresAt: string;
}

interface RegistryState {
  version: 1;
  devices: StoredDevice[];
  pairingToken: StoredPairingToken | null;
}

interface RegistryStore {
  loadedPath: string | null;
  state: RegistryState;
  mutationQueue: Promise<void>;
}

export interface PairedDevice {
  id: string;
  name: string;
  registeredAt: string;
  lastSeenAt: string | null;
}

export interface IssuedPairingToken {
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface RedeemedDevice extends PairedDevice {
  token: string;
}

export type DeviceRegistryErrorCode =
  | 'capacity-reached'
  | 'pairing-active'
  | 'pairing-expired'
  | 'pairing-invalid';

export class DeviceRegistryError extends Error {
  constructor(public readonly code: DeviceRegistryErrorCode, message: string) {
    super(message);
    this.name = 'DeviceRegistryError';
  }
}

const EMPTY_STATE: RegistryState = {
  version: 1,
  devices: [],
  pairingToken: null,
};
const STORE_KEY = Symbol.for('tessera.deviceRegistry');
const registryGlobal = globalThis as typeof globalThis & {
  [STORE_KEY]?: RegistryStore;
};
const store = registryGlobal[STORE_KEY] ??= {
  loadedPath: null,
  state: EMPTY_STATE,
  mutationQueue: Promise.resolve(),
};

function cloneState(state: RegistryState): RegistryState {
  return {
    version: 1,
    devices: state.devices.map((device) => ({ ...device })),
    pairingToken: state.pairingToken ? { ...state.pairingToken } : null,
  };
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<StoredDevice>;
  return typeof device.id === 'string'
    && TOKEN_PATTERN.test(device.token ?? '')
    && typeof device.name === 'string'
    && device.name.length > 0
    && device.name.length <= 80
    && typeof device.registeredAt === 'string'
    && Number.isFinite(Date.parse(device.registeredAt))
    && (
      device.lastSeenAt === null
      || (
        typeof device.lastSeenAt === 'string'
        && Number.isFinite(Date.parse(device.lastSeenAt))
      )
    );
}

function parseRegistryState(value: unknown): RegistryState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RegistryState>;
  if (
    candidate.version !== 1
    || !Array.isArray(candidate.devices)
    || candidate.devices.length > MAX_PAIRED_DEVICES
  ) return null;
  if (!candidate.devices.every(isStoredDevice)) return null;
  const deviceIds = new Set(candidate.devices.map((device) => device.id));
  const deviceTokens = new Set(candidate.devices.map((device) => device.token));
  if (
    deviceIds.size !== candidate.devices.length
    || deviceTokens.size !== candidate.devices.length
  ) return null;
  if (candidate.pairingToken !== null) {
    const pairing = candidate.pairingToken as Partial<StoredPairingToken> | undefined;
    if (
      !pairing
      || !TOKEN_PATTERN.test(pairing.token ?? '')
      || typeof pairing.createdAt !== 'string'
      || typeof pairing.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(pairing.createdAt))
      || !Number.isFinite(Date.parse(pairing.expiresAt))
      || Date.parse(pairing.expiresAt) <= Date.parse(pairing.createdAt)
    ) return null;
  }
  return {
    version: 1,
    devices: candidate.devices,
    pairingToken: candidate.pairingToken ?? null,
  };
}

async function ensureLoaded(): Promise<string> {
  const registryPath = getDeviceRegistryPath();
  if (store.loadedPath === registryPath) return registryPath;
  try {
    const parsed = parseRegistryState(
      JSON.parse(await fs.readFile(registryPath, 'utf8')),
    );
    if (!parsed) throw new Error('Device registry has an invalid shape');
    store.state = parsed;
    await fs.chmod(registryPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ error }, 'Device registry could not be loaded; failing closed');
    }
    store.state = cloneState(EMPTY_STATE);
  }
  store.loadedPath = registryPath;
  return registryPath;
}

async function persist(registryPath: string, nextState: RegistryState): Promise<void> {
  const directory = path.dirname(registryPath);
  const temporaryPath = path.join(
    directory,
    `.device-registry.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, registryPath);
    await fs.chmod(registryPath, 0o600);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function mutate<T>(
  operation: (state: RegistryState) => T | Promise<T>,
  shouldPersist: (value: T) => boolean = () => true,
): Promise<T> {
  const previousMutation = store.mutationQueue;
  let releaseMutation!: () => void;
  store.mutationQueue = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await previousMutation;
  try {
    const registryPath = await ensureLoaded();
    const nextState = cloneState(store.state);
    const value = await operation(nextState);
    if (shouldPersist(value)) {
      await persist(registryPath, nextState);
      store.state = nextState;
    }
    return value;
  } finally {
    releaseMutation();
  }
}

interface CandidateToken {
  buffer: Buffer;
  hasExpectedLength: boolean;
}

function normalizeCandidateToken(candidate: string): CandidateToken {
  const candidateBytes = Buffer.from(candidate);
  const buffer = Buffer.alloc(TOKEN_LENGTH);
  candidateBytes.copy(buffer, 0, 0, TOKEN_LENGTH);
  return {
    buffer,
    hasExpectedLength: candidateBytes.length === TOKEN_LENGTH,
  };
}

function constantTimeTokenMatch(candidate: CandidateToken, storedToken: string): boolean {
  const storedBuffer = Buffer.from(storedToken);
  const equal = timingSafeEqual(candidate.buffer, storedBuffer);
  return candidate.hasExpectedLength && equal;
}

function publicDevice(device: StoredDevice): PairedDevice {
  return {
    id: device.id,
    name: device.name,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function newPairingToken(now: Date): StoredPairingToken {
  return {
    token: randomBytes(DEVICE_TOKEN_BYTES).toString('base64url'),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PAIRING_TOKEN_TTL_MS).toISOString(),
  };
}

function assertCapacity(state: RegistryState): void {
  if (state.devices.length >= MAX_PAIRED_DEVICES) {
    throw new DeviceRegistryError('capacity-reached', 'Paired device limit reached');
  }
}

export async function issuePairingToken(now = new Date()): Promise<IssuedPairingToken> {
  return mutate((state) => {
    assertCapacity(state);
    if (
      state.pairingToken
      && Date.parse(state.pairingToken.expiresAt) > now.getTime()
    ) {
      throw new DeviceRegistryError('pairing-active', 'A pairing token is already active');
    }
    state.pairingToken = newPairingToken(now);
    return { ...state.pairingToken };
  });
}

export async function rotatePairingToken(now = new Date()): Promise<IssuedPairingToken> {
  return mutate((state) => {
    assertCapacity(state);
    state.pairingToken = newPairingToken(now);
    return { ...state.pairingToken };
  });
}

export async function getPairingStatus(now = new Date()): Promise<{
  createdAt: string;
  expiresAt: string;
} | null> {
  await store.mutationQueue;
  await ensureLoaded();
  const pairingToken = store.state.pairingToken;
  if (!pairingToken || Date.parse(pairingToken.expiresAt) <= now.getTime()) return null;
  return {
    createdAt: pairingToken.createdAt,
    expiresAt: pairingToken.expiresAt,
  };
}

export async function redeemPairingToken(
  candidate: string,
  deviceName: string,
  now = new Date(),
): Promise<RedeemedDevice> {
  const outcome = await mutate((state):
    | { device: RedeemedDevice; error?: never }
    | { device?: never; error: DeviceRegistryError } => {
    const pairingToken = state.pairingToken;
    const candidateToken = normalizeCandidateToken(candidate);
    if (
      !pairingToken
      || !constantTimeTokenMatch(candidateToken, pairingToken.token)
    ) {
      throw new DeviceRegistryError('pairing-invalid', 'Pairing token is invalid');
    }
    state.pairingToken = null;
    if (Date.parse(pairingToken.expiresAt) <= now.getTime()) {
      return {
        error: new DeviceRegistryError('pairing-expired', 'Pairing token has expired'),
      };
    }
    assertCapacity(state);

    const registeredAt = now.toISOString();
    const device: StoredDevice = {
      id: randomUUID(),
      token: randomBytes(DEVICE_TOKEN_BYTES).toString('base64url'),
      name: deviceName.trim().slice(0, 80) || 'Paired device',
      registeredAt,
      lastSeenAt: null,
    };
    state.devices.push(device);
    return { device: { ...publicDevice(device), token: device.token } };
  });
  if (outcome.error) throw outcome.error;
  return outcome.device;
}

export async function resolveDeviceToken(
  candidate: string | undefined,
  now = new Date(),
): Promise<PairedDevice | null> {
  if (!candidate) return null;
  return mutate((state) => {
    const candidateToken = normalizeCandidateToken(candidate);
    let matchedDevice: StoredDevice | null = null;
    for (const device of state.devices) {
      if (constantTimeTokenMatch(candidateToken, device.token)) {
        matchedDevice = device;
      }
    }
    if (!matchedDevice) return null;
    matchedDevice.lastSeenAt = now.toISOString();
    return publicDevice(matchedDevice);
  }, (device) => device !== null);
}

export async function listDevices(): Promise<PairedDevice[]> {
  await store.mutationQueue;
  await ensureLoaded();
  return store.state.devices.map(publicDevice);
}

/**
 * Synchronous registration guard for a Device WebSocket that already passed
 * token resolution. Call immediately before adding the socket to the live set.
 */
export function isDeviceRegistered(deviceId: string): boolean {
  return store.state.devices.some((device) => device.id === deviceId);
}

export async function revokeDevice(deviceId: string): Promise<boolean> {
  return mutate((state) => {
    const previousLength = state.devices.length;
    state.devices = state.devices.filter((device) => device.id !== deviceId);
    return state.devices.length !== previousLength;
  }, (revoked) => revoked);
}

export async function clearDeviceRegistry(): Promise<string[]> {
  return mutate((state) => {
    const revokedDeviceIds = state.devices.map((device) => device.id);
    state.devices = [];
    state.pairingToken = null;
    return revokedDeviceIds;
  });
}
