import fs from 'node:fs/promises';
import path from 'node:path';

export const MOBILE_ACCESS_OWNER = 'tessera.mobile-access';

export interface MobileAccessOwnership {
  schemaVersion: 1;
  owner: typeof MOBILE_ACCESS_OWNER;
  nodeDnsName: string;
  origin: string;
  servePort: 443;
  mountPath: '/';
  lastLoopbackTarget: string;
}

export interface MobileAccessStateStore {
  load(): Promise<MobileAccessOwnership | null>;
  save(ownership: MobileAccessOwnership): Promise<void>;
}

function isMobileAccessOwnership(value: unknown): value is MobileAccessOwnership {
  if (!value || typeof value !== 'object') return false;
  const ownership = value as Partial<MobileAccessOwnership>;
  return ownership.schemaVersion === 1
    && ownership.owner === MOBILE_ACCESS_OWNER
    && typeof ownership.nodeDnsName === 'string'
    && typeof ownership.origin === 'string'
    && ownership.servePort === 443
    && ownership.mountPath === '/'
    && typeof ownership.lastLoopbackTarget === 'string';
}

export class FileMobileAccessStateStore implements MobileAccessStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MobileAccessOwnership | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      return isMobileAccessOwnership(value) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  async save(ownership: MobileAccessOwnership): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = path.join(
      directory,
      `.mobile-access.${process.pid}.${Date.now()}.tmp`,
    );

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    try {
      await fs.writeFile(tempPath, JSON.stringify(ownership, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
