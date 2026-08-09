import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

export type WindowsPathRestrictor = (
  targetPath: string,
  directory: boolean,
) => Promise<void>;

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_ACL_SCRIPT = [
  '$targetPath = $env:TESSERA_OWNER_ONLY_ACL_TARGET',
  '$directoryFlag = $env:TESSERA_OWNER_ONLY_ACL_DIRECTORY',
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

export async function restrictWindowsPathToCurrentUser(
  targetPath: string,
  directory: boolean,
): Promise<void> {
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PRIVATE_ACL_SCRIPT,
  ], {
    env: {
      ...process.env,
      TESSERA_OWNER_ONLY_ACL_TARGET: targetPath,
      TESSERA_OWNER_ONLY_ACL_DIRECTORY: directory ? '1' : '0',
    },
    windowsHide: true,
  });
}

export async function makePathOwnerOnly(
  targetPath: string,
  directory: boolean,
  options: {
    platform?: NodeJS.Platform;
    restrictWindowsPath?: WindowsPathRestrictor;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) === 'win32') {
    await (options.restrictWindowsPath ?? restrictWindowsPathToCurrentUser)(targetPath, directory);
    return;
  }
  await fs.chmod(targetPath, directory ? 0o700 : 0o600);
}
