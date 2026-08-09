import fs from 'node:fs/promises';
import path from 'node:path';
import {
  makePathOwnerOnly,
  restrictWindowsPathToCurrentUser,
  type WindowsPathRestrictor,
} from '../filesystem/owner-only-path';

import { getTesseraDataPath } from '../tessera-data-dir';

export const MOBILE_ACCESS_OWNER = 'tessera.mobile-access';

export interface MobileAccessOwnership {
  schemaVersion: 1;
  owner: typeof MOBILE_ACCESS_OWNER;
  nodeDnsName: string;
  origin: string;
  servePort: number;
  mountPath: '/';
  lastLoopbackTarget: string;
}

export interface MobileAccessSetupProgress {
  schemaVersion: 1;
  owner: typeof MOBILE_ACCESS_OWNER;
  phase: 'setup';
  loopbackPort: number;
  selectedServePort?: number;
  nodeDnsName?: string;
  previousLoopbackTarget?: string;
}

export type MobileAccessPersistedState = MobileAccessOwnership | MobileAccessSetupProgress;

export interface MobileAccessStateStore {
  load(): Promise<MobileAccessPersistedState | null>;
  save(state: MobileAccessPersistedState): Promise<void>;
  clear(): Promise<void>;
}

interface FileMobileAccessStateStoreOptions {
  platform?: NodeJS.Platform;
  restrictWindowsPath?: WindowsPathRestrictor;
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= 65_535;
}

function isValidOwnedOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.origin === value;
  } catch {
    return false;
  }
}

function isMobileAccessPersistedState(value: unknown): value is MobileAccessPersistedState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<MobileAccessOwnership & MobileAccessSetupProgress>;
  if (state.schemaVersion !== 1 || state.owner !== MOBILE_ACCESS_OWNER) return false;
  if (state.phase === 'setup') {
    return isValidPort(state.loopbackPort)
      && (state.selectedServePort === undefined || isValidPort(state.selectedServePort))
      && (state.nodeDnsName === undefined || typeof state.nodeDnsName === 'string')
      && (
        state.previousLoopbackTarget === undefined
        || typeof state.previousLoopbackTarget === 'string'
      );
  }
  return typeof state.nodeDnsName === 'string'
    && isValidOwnedOrigin(state.origin)
    && isValidPort(state.servePort)
    && state.mountPath === '/'
    && typeof state.lastLoopbackTarget === 'string';
}

export class FileMobileAccessStateStore implements MobileAccessStateStore {
  private readonly platform: NodeJS.Platform;
  private readonly restrictWindowsPath: (targetPath: string, directory: boolean) => Promise<void>;

  constructor(
    private readonly filePath: string,
    options: FileMobileAccessStateStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.restrictWindowsPath = options.restrictWindowsPath ?? restrictWindowsPathToCurrentUser;
  }

  async load(): Promise<MobileAccessPersistedState | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      return isMobileAccessPersistedState(value) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  async save(state: MobileAccessPersistedState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = path.join(
      directory,
      `.mobile-access.${process.pid}.${Date.now()}.tmp`,
    );

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.makeOwnerOnly(directory, true);
    try {
      await fs.writeFile(tempPath, JSON.stringify(state, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await this.makeOwnerOnly(tempPath, false);
      await fs.rename(tempPath, this.filePath);
      await this.makeOwnerOnly(this.filePath, false);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await fs.unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private async makeOwnerOnly(targetPath: string, directory: boolean): Promise<void> {
    await makePathOwnerOnly(targetPath, directory, {
      platform: this.platform,
      restrictWindowsPath: this.restrictWindowsPath,
    });
  }
}

export function createMobileAccessStateStore(): FileMobileAccessStateStore {
  return new FileMobileAccessStateStore(getTesseraDataPath('mobile-access.json'));
}

export async function loadOwnedMobileAccessOrigin(): Promise<string | null> {
  const state = await createMobileAccessStateStore().load();
  return state && !('phase' in state) ? state.origin : null;
}
