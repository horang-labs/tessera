import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import webPush from 'web-push';
import {
  makePathOwnerOnly,
  restrictWindowsPathToCurrentUser,
  type WindowsPathRestrictor,
} from '@/lib/filesystem/owner-only-path';
import logger from '@/lib/logger';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

export interface VapidIdentity {
  publicKey: string;
  privateKey: string;
}

interface FileVapidIdentityStoreOptions {
  platform?: NodeJS.Platform;
  restrictWindowsPath?: WindowsPathRestrictor;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const storesByPath = new Map<string, FileVapidIdentityStore>();

export function getVapidIdentityPath(): string {
  return getTesseraDataPath('push', 'vapid-identity.json');
}

function parseIdentity(value: unknown): VapidIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const identity = value as Partial<VapidIdentity>;
  if (
    typeof identity.publicKey !== 'string'
    || typeof identity.privateKey !== 'string'
    || !KEY_PATTERN.test(identity.publicKey)
    || !KEY_PATTERN.test(identity.privateKey)
  ) return null;
  return { publicKey: identity.publicKey, privateKey: identity.privateKey };
}

export class FileVapidIdentityStore {
  private readonly platform: NodeJS.Platform;
  private readonly restrictWindowsPath: WindowsPathRestrictor;
  private pending: Promise<VapidIdentity> | null = null;

  constructor(
    private readonly identityPath: string,
    options: FileVapidIdentityStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.restrictWindowsPath = options.restrictWindowsPath ?? restrictWindowsPathToCurrentUser;
  }

  ensure(): Promise<VapidIdentity> {
    if (this.pending) return this.pending;
    this.pending = this.loadOrCreate().finally(() => { this.pending = null; });
    return this.pending;
  }

  async clear(): Promise<void> {
    await this.pending?.catch(() => undefined);
    await fs.unlink(this.identityPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private async loadOrCreate(): Promise<VapidIdentity> {
    const directory = path.dirname(this.identityPath);
    try {
      const identity = parseIdentity(JSON.parse(await fs.readFile(this.identityPath, 'utf8')));
      if (identity) {
        await this.makeOwnerOnly(directory, true);
        await this.makeOwnerOnly(this.identityPath, false);
        return identity;
      }
      logger.warn('Stored VAPID identity was invalid; replacing it');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ error }, 'Stored VAPID identity could not be loaded; replacing it');
      }
    }

    const temporaryPath = path.join(
      directory,
      `.vapid-identity.${process.pid}.${randomUUID()}.tmp`,
    );
    const identity = webPush.generateVAPIDKeys();

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.makeOwnerOnly(directory, true);
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await this.makeOwnerOnly(temporaryPath, false);
      await fs.rename(temporaryPath, this.identityPath);
      await this.makeOwnerOnly(this.identityPath, false);
      return identity;
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private makeOwnerOnly(targetPath: string, directory: boolean): Promise<void> {
    return makePathOwnerOnly(targetPath, directory, {
      platform: this.platform,
      restrictWindowsPath: this.restrictWindowsPath,
    });
  }
}

export function ensureVapidIdentity(): Promise<VapidIdentity> {
  const identityPath = getVapidIdentityPath();
  let store = storesByPath.get(identityPath);
  if (!store) {
    store = new FileVapidIdentityStore(identityPath);
    storesByPath.set(identityPath, store);
  }
  return store.ensure();
}

export function clearVapidIdentity(): Promise<void> {
  const identityPath = getVapidIdentityPath();
  let store = storesByPath.get(identityPath);
  if (!store) {
    store = new FileVapidIdentityStore(identityPath);
    storesByPath.set(identityPath, store);
  }
  return store.clear();
}
