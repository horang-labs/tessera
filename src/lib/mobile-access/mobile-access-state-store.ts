import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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

interface FileMobileAccessStateStoreOptions {
  platform?: NodeJS.Platform;
  restrictWindowsPath?(targetPath: string, directory: boolean): Promise<void>;
}

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_ACL_SCRIPT = [
  '$targetPath = $env:TESSERA_MOBILE_ACCESS_ACL_TARGET',
  '$directoryFlag = $env:TESSERA_MOBILE_ACCESS_ACL_DIRECTORY',
  '$currentAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
  '$item = Get-Item -LiteralPath $targetPath -Force',
  '$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($entry in @($acl.Access)) { $acl.PurgeAccessRules($entry.IdentityReference) }',
  '$inheritance = if ($directoryFlag -eq "1") { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }',
  '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($currentAccount, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
  '$acl.SetAccessRule($rule)',
  '$item.SetAccessControl($acl)',
].join('; ');

async function restrictWindowsPath(targetPath: string, directory: boolean): Promise<void> {
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PRIVATE_ACL_SCRIPT,
  ], {
    env: {
      ...process.env,
      TESSERA_MOBILE_ACCESS_ACL_TARGET: targetPath,
      TESSERA_MOBILE_ACCESS_ACL_DIRECTORY: directory ? '1' : '0',
    },
    windowsHide: true,
  });
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
  private readonly platform: NodeJS.Platform;
  private readonly restrictWindowsPath: (targetPath: string, directory: boolean) => Promise<void>;

  constructor(
    private readonly filePath: string,
    options: FileMobileAccessStateStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.restrictWindowsPath = options.restrictWindowsPath ?? restrictWindowsPath;
  }

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
    await this.makeOwnerOnly(directory, true);
    try {
      await fs.writeFile(tempPath, JSON.stringify(ownership, null, 2), {
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

  private async makeOwnerOnly(targetPath: string, directory: boolean): Promise<void> {
    if (this.platform === 'win32') {
      await this.restrictWindowsPath(targetPath, directory);
      return;
    }
    await fs.chmod(targetPath, directory ? 0o700 : 0o600);
  }
}
