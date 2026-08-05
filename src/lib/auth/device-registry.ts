import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger';
import { getTesseraDataPath } from '../tessera-data-dir';
import type {
  PairingDecision,
  PairingRequest,
  PairingRequestStatus,
} from './pairing-contract';

export type { PairingRequest, PairingRequestStatus } from './pairing-contract';

const DEVICE_TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONSUMED_PAIRING_TOKENS = 16;
const CONSUMED_PAIRING_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
const PAIRING_REQUEST_RETENTION_MS = 5 * 60 * 1000;
export const PAIRING_TOKEN_TTL_MS = 2 * 60 * 1000;
export const MAX_PAIRED_DEVICES = 8;
export const DEVICE_TOKEN_COOKIE = 'device';
export const PAIRING_REQUEST_COOKIE = 'pairing_pending';

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

interface ConsumedPairingToken {
  tokenHash: string;
  expiresAt: string;
}

interface RegistryState {
  version: 1;
  devices: StoredDevice[];
  pairingToken: StoredPairingToken | null;
  consumedPairingTokens: ConsumedPairingToken[];
}

interface RegistryStore {
  loadedPath: string | null;
  state: RegistryState;
  pairingRequests: Map<string, StoredPairingRequest>;
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

interface StoredPairingRequest extends PairingRequest {
  pairingTokenHash: string;
  pollingCredential: string;
}

export interface PairingClaimInput {
  token: string;
  name: string;
  browser: string;
  platform: string;
  remoteAddress: string;
}

export interface ClaimedPairingRequest {
  request: PairingRequest;
  pollingCredential: string;
  created: boolean;
}

export type PairingDecisionResult =
  | { status: 'pending' | 'denied' | 'expired' | 'used'; expiresAt: string }
  | { status: 'redeemed'; expiresAt: string; device: RedeemedDevice };

export type DeviceRegistryErrorCode =
  | 'capacity-reached'
  | 'pairing-active'
  | 'pairing-expired'
  | 'pairing-used'
  | 'pairing-invalid'
  | 'pairing-request-invalid'
  | 'pairing-request-handled';

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
  consumedPairingTokens: [],
};
const STORE_KEY = Symbol.for('tessera.deviceRegistry');
const registryGlobal = globalThis as typeof globalThis & {
  [STORE_KEY]?: RegistryStore;
};
const store = registryGlobal[STORE_KEY] ??= {
  loadedPath: null,
  state: EMPTY_STATE,
  pairingRequests: new Map(),
  mutationQueue: Promise.resolve(),
};
// The global store survives development module reloads. Initialize fields added
// by newer code without making pending requests persistent across processes.
store.pairingRequests ??= new Map();

function cloneState(state: RegistryState): RegistryState {
  return {
    version: 1,
    devices: state.devices.map((device) => ({ ...device })),
    pairingToken: state.pairingToken ? { ...state.pairingToken } : null,
    consumedPairingTokens: state.consumedPairingTokens.map((token) => ({ ...token })),
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
  const consumedPairingTokens = candidate.consumedPairingTokens ?? [];
  if (
    !Array.isArray(consumedPairingTokens)
    || consumedPairingTokens.length > MAX_CONSUMED_PAIRING_TOKENS
    || !consumedPairingTokens.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const token = value as Partial<ConsumedPairingToken>;
      return TOKEN_PATTERN.test(token.tokenHash ?? '')
        && typeof token.expiresAt === 'string'
        && Number.isFinite(Date.parse(token.expiresAt));
    })
  ) return null;
  return {
    version: 1,
    devices: candidate.devices,
    pairingToken: candidate.pairingToken ?? null,
    consumedPairingTokens,
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
  operation: (
    state: RegistryState,
    pairingRequests: Map<string, StoredPairingRequest>,
  ) => T | Promise<T>,
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
    const nextPairingRequests = new Map(
      [...store.pairingRequests].map(([id, request]) => [id, { ...request }]),
    );
    const value = await operation(nextState, nextPairingRequests);
    if (shouldPersist(value)) {
      await persist(registryPath, nextState);
      store.state = nextState;
    }
    store.pairingRequests = nextPairingRequests;
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

function hashPairingToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function tokenMatches(candidate: string | undefined, storedToken: string): boolean {
  return constantTimeTokenMatch(normalizeCandidateToken(candidate ?? ''), storedToken);
}

function pruneConsumedPairingTokens(state: RegistryState, now: Date): void {
  state.consumedPairingTokens = state.consumedPairingTokens.filter(
    (token) => Date.parse(token.expiresAt) > now.getTime(),
  );
}

function wasPairingTokenConsumed(state: RegistryState, candidate: string): boolean {
  if (!TOKEN_PATTERN.test(candidate)) return false;

  const candidateHash = normalizeCandidateToken(hashPairingToken(candidate));
  let matched = false;
  for (const token of state.consumedPairingTokens) {
    if (constantTimeTokenMatch(candidateHash, token.tokenHash)) {
      matched = true;
    }
  }
  return matched;
}

function publicDevice(device: StoredDevice): PairedDevice {
  return {
    id: device.id,
    name: device.name,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function publicPairingRequest(request: StoredPairingRequest): PairingRequest {
  return {
    id: request.id,
    name: request.name,
    browser: request.browser,
    platform: request.platform,
    remoteAddress: request.remoteAddress,
    comparisonCode: request.comparisonCode,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    status: request.status,
  };
}

function displayValue(value: string, fallback: string, maxLength = 120): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength) || fallback;
}

function markExpiredPairingRequests(
  pairingRequests: Map<string, StoredPairingRequest>,
  now: Date,
): void {
  for (const [requestId, request] of pairingRequests) {
    if (Date.parse(request.expiresAt) + PAIRING_REQUEST_RETENTION_MS <= now.getTime()) {
      pairingRequests.delete(requestId);
      continue;
    }
    if (
      (request.status === 'pending' || request.status === 'approved')
      && Date.parse(request.expiresAt) <= now.getTime()
    ) {
      request.status = 'expired';
    }
  }
}

function expireOpenPairingRequests(
  pairingRequests: Map<string, StoredPairingRequest>,
): void {
  for (const request of pairingRequests.values()) {
    if (request.status === 'pending' || request.status === 'approved') {
      request.status = 'expired';
    }
  }
}

function appendConsumedPairingToken(
  state: RegistryState,
  pairingToken: StoredPairingToken,
  now: Date,
): void {
  state.consumedPairingTokens.push({
    tokenHash: hashPairingToken(pairingToken.token),
    expiresAt: new Date(
      now.getTime() + CONSUMED_PAIRING_TOKEN_RETENTION_MS,
    ).toISOString(),
  });
  state.consumedPairingTokens = state.consumedPairingTokens.slice(
    -MAX_CONSUMED_PAIRING_TOKENS,
  );
}

function createStoredDevice(name: string, now: Date): StoredDevice {
  return {
    id: randomUUID(),
    token: randomBytes(DEVICE_TOKEN_BYTES).toString('base64url'),
    name: displayValue(name, 'Paired device', 80),
    registeredAt: now.toISOString(),
    lastSeenAt: null,
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
  return mutate((state, pairingRequests) => {
    pruneConsumedPairingTokens(state, now);
    markExpiredPairingRequests(pairingRequests, now);
    assertCapacity(state);
    if (
      state.pairingToken
      && Date.parse(state.pairingToken.expiresAt) > now.getTime()
    ) {
      throw new DeviceRegistryError('pairing-active', 'A pairing token is already active');
    }
    expireOpenPairingRequests(pairingRequests);
    state.pairingToken = newPairingToken(now);
    return { ...state.pairingToken };
  });
}

export async function rotatePairingToken(now = new Date()): Promise<IssuedPairingToken> {
  return mutate((state, pairingRequests) => {
    pruneConsumedPairingTokens(state, now);
    assertCapacity(state);
    expireOpenPairingRequests(pairingRequests);
    state.pairingToken = newPairingToken(now);
    return { ...state.pairingToken };
  });
}

export async function claimPairingToken(
  input: PairingClaimInput,
  presentedPollingCredential?: string,
  now = new Date(),
): Promise<ClaimedPairingRequest> {
  const outcome = await mutate((state, pairingRequests):
    | { claim: ClaimedPairingRequest; error?: never }
    | { claim?: never; error: DeviceRegistryError } => {
    pruneConsumedPairingTokens(state, now);
    markExpiredPairingRequests(pairingRequests, now);

    const candidateHash = hashPairingToken(input.token);
    for (const request of pairingRequests.values()) {
      if (
        tokenMatches(candidateHash, request.pairingTokenHash)
        && tokenMatches(presentedPollingCredential, request.pollingCredential)
      ) {
        return {
          claim: {
            request: publicPairingRequest(request),
            pollingCredential: request.pollingCredential,
            created: false,
          },
        };
      }
    }

    const pairingToken = state.pairingToken;
    const candidateToken = normalizeCandidateToken(input.token);
    if (!pairingToken || !constantTimeTokenMatch(candidateToken, pairingToken.token)) {
      if (wasPairingTokenConsumed(state, input.token)) {
        throw new DeviceRegistryError('pairing-used', 'Pairing token has already been used');
      }
      throw new DeviceRegistryError('pairing-invalid', 'Pairing token is invalid');
    }

    state.pairingToken = null;
    if (Date.parse(pairingToken.expiresAt) <= now.getTime()) {
      return {
        error: new DeviceRegistryError('pairing-expired', 'Pairing token has expired'),
      };
    }
    assertCapacity(state);
    appendConsumedPairingToken(state, pairingToken, now);

    const request: StoredPairingRequest = {
      id: randomUUID(),
      name: displayValue(input.name, 'Browser', 80),
      browser: displayValue(input.browser, 'Unknown browser'),
      platform: displayValue(input.platform, 'Unknown platform'),
      remoteAddress: displayValue(input.remoteAddress, 'unknown'),
      comparisonCode: String(
        randomBytes(4).readUInt32BE(0) % 1_000_000,
      ).padStart(6, '0'),
      createdAt: now.toISOString(),
      expiresAt: pairingToken.expiresAt,
      status: 'pending',
      pairingTokenHash: hashPairingToken(pairingToken.token),
      pollingCredential: randomBytes(DEVICE_TOKEN_BYTES).toString('base64url'),
    };
    pairingRequests.set(request.id, request);
    return {
      claim: {
        request: publicPairingRequest(request),
        pollingCredential: request.pollingCredential,
        created: true,
      },
    };
  });
  if (outcome.error) throw outcome.error;
  return outcome.claim;
}

export async function listPairingRequests(now = new Date()): Promise<PairingRequest[]> {
  return mutate((_state, pairingRequests) => {
    markExpiredPairingRequests(pairingRequests, now);
    return [...pairingRequests.values()]
      .map(publicPairingRequest)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }, () => false);
}

export async function decidePairingRequest(
  requestId: string,
  decision: PairingDecision,
  now = new Date(),
): Promise<PairingRequest> {
  return mutate((state, pairingRequests) => {
    markExpiredPairingRequests(pairingRequests, now);
    const request = pairingRequests.get(requestId);
    if (!request) {
      throw new DeviceRegistryError('pairing-request-invalid', 'Pairing request was not found');
    }
    if (request.status === 'expired') {
      throw new DeviceRegistryError('pairing-expired', 'Pairing request has expired');
    }
    if (request.status !== 'pending') {
      throw new DeviceRegistryError('pairing-request-handled', 'Pairing request was already handled');
    }
    if (decision === 'approve') assertCapacity(state);
    request.status = decision === 'approve' ? 'approved' : 'denied';
    return publicPairingRequest(request);
  }, () => false);
}

export async function receivePairingDecision(
  requestId: string,
  pollingCredential: string | undefined,
  now = new Date(),
): Promise<PairingDecisionResult> {
  return mutate((state, pairingRequests) => {
    markExpiredPairingRequests(pairingRequests, now);
    const request = pairingRequests.get(requestId);
    if (!request || !tokenMatches(pollingCredential, request.pollingCredential)) {
      return { status: 'expired', expiresAt: now.toISOString() };
    }
    if (request.status === 'pending') {
      return { status: 'pending', expiresAt: request.expiresAt };
    }
    if (request.status === 'denied') {
      return { status: 'denied', expiresAt: request.expiresAt };
    }
    if (request.status === 'expired') {
      return { status: 'expired', expiresAt: request.expiresAt };
    }
    if (request.status === 'redeemed') {
      return { status: 'used', expiresAt: request.expiresAt };
    }

    assertCapacity(state);
    const device = createStoredDevice(request.name, now);
    state.devices.push(device);
    request.status = 'redeemed';
    return {
      status: 'redeemed',
      expiresAt: request.expiresAt,
      device: { ...publicDevice(device), token: device.token },
    };
  }, (result) => result.status === 'redeemed');
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
  return mutate((state, pairingRequests) => {
    const revokedDeviceIds = state.devices.map((device) => device.id);
    state.devices = [];
    state.pairingToken = null;
    state.consumedPairingTokens = [];
    pairingRequests.clear();
    return revokedDeviceIds;
  });
}
