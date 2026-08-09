import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makePathOwnerOnly } from '@/lib/filesystem/owner-only-path';
import logger from '@/lib/logger';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

export interface DevicePushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface StoredDevicePushSubscription {
  deviceId: string;
  subscription: DevicePushSubscription;
}

interface SubscriptionState {
  version: 1;
  subscriptions: Record<string, DevicePushSubscription>;
}

const EMPTY_STATE: SubscriptionState = {
  version: 1,
  subscriptions: {},
};

export function getDevicePushSubscriptionStorePath(): string {
  return getTesseraDataPath('push', 'device-subscriptions.json');
}

export function isDevicePushSubscription(value: unknown): value is DevicePushSubscription {
  if (!value || typeof value !== 'object') return false;
  const subscription = value as Partial<DevicePushSubscription>;
  if (
    typeof subscription.endpoint !== 'string'
    || subscription.endpoint.length > 2_048
    || !subscription.keys
    || typeof subscription.keys.p256dh !== 'string'
    || typeof subscription.keys.auth !== 'string'
    || !PUSH_KEY_PATTERN.test(subscription.keys.p256dh)
    || !PUSH_KEY_PATTERN.test(subscription.keys.auth)
  ) return false;
  try {
    if (new URL(subscription.endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return subscription.expirationTime === null
    || (
      typeof subscription.expirationTime === 'number'
      && Number.isFinite(subscription.expirationTime)
      && subscription.expirationTime > 0
    );
}

function copySubscription(subscription: DevicePushSubscription): DevicePushSubscription {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { ...subscription.keys },
  };
}

function cloneState(state: SubscriptionState): SubscriptionState {
  return {
    version: 1,
    subscriptions: Object.fromEntries(
      Object.entries(state.subscriptions).map(([deviceId, subscription]) => [
        deviceId,
        copySubscription(subscription),
      ]),
    ),
  };
}

function parseState(value: unknown): SubscriptionState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SubscriptionState>;
  if (
    candidate.version !== 1
    || !candidate.subscriptions
    || typeof candidate.subscriptions !== 'object'
    || Array.isArray(candidate.subscriptions)
  ) return null;
  for (const [deviceId, subscription] of Object.entries(candidate.subscriptions)) {
    if (!deviceId || deviceId.length > 128 || !isDevicePushSubscription(subscription)) {
      return null;
    }
  }
  return cloneState(candidate as SubscriptionState);
}

class DevicePushSubscriptionStore {
  private loaded = false;
  private state = cloneState(EMPTY_STATE);
  private mutationQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(deviceId: string): Promise<DevicePushSubscription | null> {
    await this.mutationQueue;
    await this.ensureLoaded();
    const subscription = this.state.subscriptions[deviceId];
    return subscription ? copySubscription(subscription) : null;
  }

  async list(): Promise<StoredDevicePushSubscription[]> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return Object.entries(this.state.subscriptions).map(([deviceId, subscription]) => ({
      deviceId,
      subscription: copySubscription(subscription),
    }));
  }

  replace(deviceId: string, subscription: DevicePushSubscription): Promise<void> {
    return this.mutate((state) => {
      state.subscriptions[deviceId] = copySubscription(subscription);
    });
  }

  delete(deviceId: string, expectedEndpoint?: string): Promise<boolean> {
    return this.mutate((state) => {
      const current = state.subscriptions[deviceId];
      if (!current || (expectedEndpoint && current.endpoint !== expectedEndpoint)) return false;
      delete state.subscriptions[deviceId];
      return true;
    }, (deleted) => deleted);
  }

  clear(): Promise<void> {
    return this.mutate((state) => {
      state.subscriptions = {};
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = parseState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
      if (!parsed) throw new Error('Push subscription store has an invalid shape');
      this.state = parsed;
      await makePathOwnerOnly(path.dirname(this.filePath), true);
      await makePathOwnerOnly(this.filePath, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ error }, 'Push subscription store could not be loaded; failing closed');
      }
      this.state = cloneState(EMPTY_STATE);
    }
    this.loaded = true;
  }

  private async persist(state: SubscriptionState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.device-subscriptions.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await makePathOwnerOnly(directory, true);
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await makePathOwnerOnly(temporaryPath, false);
      await fs.rename(temporaryPath, this.filePath);
      await makePathOwnerOnly(this.filePath, false);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(
    operation: (state: SubscriptionState) => T | Promise<T>,
    shouldPersist: (result: T) => boolean = () => true,
  ): Promise<T> {
    const previousMutation = this.mutationQueue;
    let releaseMutation!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { releaseMutation = resolve; });
    await previousMutation;
    try {
      await this.ensureLoaded();
      const nextState = cloneState(this.state);
      const result = await operation(nextState);
      if (shouldPersist(result)) {
        await this.persist(nextState);
        this.state = nextState;
      }
      return result;
    } finally {
      releaseMutation();
    }
  }
}

const stores = new Map<string, DevicePushSubscriptionStore>();

function subscriptionStore(): DevicePushSubscriptionStore {
  const filePath = getDevicePushSubscriptionStorePath();
  let store = stores.get(filePath);
  if (!store) {
    store = new DevicePushSubscriptionStore(filePath);
    stores.set(filePath, store);
  }
  return store;
}

export function getDevicePushSubscription(
  deviceId: string,
): Promise<DevicePushSubscription | null> {
  return subscriptionStore().get(deviceId);
}

export function listDevicePushSubscriptions(): Promise<StoredDevicePushSubscription[]> {
  return subscriptionStore().list();
}

export async function replaceDevicePushSubscription(
  deviceId: string,
  subscription: DevicePushSubscription,
): Promise<boolean> {
  await subscriptionStore().replace(deviceId, subscription);
  return true;
}

export function deleteDevicePushSubscription(
  deviceId: string,
  expectedEndpoint?: string,
): Promise<boolean> {
  return subscriptionStore().delete(deviceId, expectedEndpoint);
}

export function clearDevicePushSubscriptions(): Promise<void> {
  return subscriptionStore().clear();
}
