import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';

export const CONTROL_API_VERSION = 1 as const;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_ACL_SCRIPT = [
  '$targetPath = $env:TESSERA_ACL_TARGET',
  '$directoryFlag = $env:TESSERA_ACL_DIRECTORY',
  '$currentAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
  '$acl = Get-Acl -LiteralPath $targetPath',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($entry in @($acl.Access)) { $acl.PurgeAccessRules($entry.IdentityReference) }',
  '$inheritance = if ($directoryFlag -eq "1") { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }',
  '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($currentAccount, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
  '$acl.SetAccessRule($rule)',
  'Set-Acl -LiteralPath $targetPath -AclObject $acl',
].join('; ');

export interface RuntimeDescriptor {
  runtimeId: string;
  pid: number;
  appVersion: string;
  controlApiVersion: typeof CONTROL_API_VERSION;
  origin: string;
  token: string;
}

export interface RuntimeDescriptorHandle {
  descriptor: RuntimeDescriptor;
  path: string;
  cleanup(): Promise<void>;
}

export interface PublishRuntimeDescriptorOptions {
  appVersion: string;
  origin: string;
  runtimeDirectory?: string;
  descriptorPath?: string;
}

export class RuntimeDescriptorError extends Error {
  readonly code = 'INSTANCE_UNAVAILABLE';

  constructor(message = 'The selected Tessera runtime is unavailable.') {
    super(message);
    this.name = 'RuntimeDescriptorError';
  }
}

export async function publishRuntimeDescriptor(
  options: PublishRuntimeDescriptorOptions,
): Promise<RuntimeDescriptorHandle> {
  const runtimeId = randomUUID();
  const descriptor: RuntimeDescriptor = {
    runtimeId,
    pid: process.pid,
    appVersion: requireNonEmpty(options.appVersion, 'appVersion'),
    controlApiVersion: CONTROL_API_VERSION,
    origin: normalizeLoopbackOrigin(options.origin),
    token: randomBytes(32).toString('base64url'),
  };
  const descriptorPath = path.resolve(
    options.descriptorPath
      ?? path.join(
        options.runtimeDirectory ?? getTesseraDataPath('control-runtimes'),
        `runtime-${runtimeId}.json`,
      ),
  );
  const runtimeDirectory = path.dirname(descriptorPath);

  await ensurePrivateDirectory(runtimeDirectory);
  await removeStaleTarget(descriptorPath);
  await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  try {
    await restrictDescriptorFile(descriptorPath);
  } catch (error) {
    await fs.unlink(descriptorPath).catch(() => undefined);
    throw error;
  }

  let cleaned = false;
  let cleanupInFlight: Promise<void> | null = null;
  return {
    descriptor,
    path: descriptorPath,
    cleanup: async () => {
      if (cleaned) return;
      if (cleanupInFlight) return cleanupInFlight;
      const cleanup = removeOwnedDescriptor(descriptorPath, runtimeId)
        .then(() => { cleaned = true; });
      cleanupInFlight = cleanup;
      try {
        await cleanup;
      } finally {
        if (cleanupInFlight === cleanup) cleanupInFlight = null;
      }
    },
  };
}

export async function readLiveRuntimeDescriptor(
  descriptorPath: string,
): Promise<RuntimeDescriptor> {
  try {
    const resolvedPath = path.resolve(descriptorPath);
    await assertPrivateDescriptorPath(resolvedPath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES) {
      throw new RuntimeDescriptorError();
    }

    const parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8')) as unknown;
    const descriptor = parseRuntimeDescriptor(parsed);
    if (!isProcessAlive(descriptor.pid)) {
      throw new RuntimeDescriptorError();
    }
    return descriptor;
  } catch (error) {
    if (error instanceof RuntimeDescriptorError) throw error;
    throw new RuntimeDescriptorError();
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function parseRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  if (!isRecord(value)) throw new RuntimeDescriptorError();
  const { runtimeId, pid, appVersion, controlApiVersion, origin, token } = value;
  if (
    typeof runtimeId !== 'string'
    || !runtimeId.trim()
    || !Number.isInteger(pid)
    || (pid as number) <= 0
    || typeof appVersion !== 'string'
    || !appVersion.trim()
    || controlApiVersion !== CONTROL_API_VERSION
    || typeof origin !== 'string'
    || typeof token !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || Buffer.from(token, 'base64url').byteLength !== 32
  ) {
    throw new RuntimeDescriptorError();
  }

  return {
    runtimeId,
    pid: pid as number,
    appVersion,
    controlApiVersion,
    origin: normalizeLoopbackOrigin(origin),
    token,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function normalizeLoopbackOrigin(value: string): string {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'http:'
      || !isLoopbackHostname(origin.hostname)
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
    ) {
      throw new RuntimeDescriptorError();
    }
    return origin.origin;
  } catch (error) {
    if (error instanceof RuntimeDescriptorError) throw error;
    throw new RuntimeDescriptorError();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeDescriptorError();

  if (process.platform === 'win32') {
    await restrictWindowsAcl(directoryPath, true);
  } else {
    await fs.chmod(directoryPath, 0o700);
  }
}

async function restrictDescriptorFile(descriptorPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await restrictWindowsAcl(descriptorPath, false);
  } else {
    await fs.chmod(descriptorPath, 0o600);
  }
}

async function restrictWindowsAcl(targetPath: string, directory: boolean): Promise<void> {
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PRIVATE_ACL_SCRIPT,
  ], {
    env: {
      ...process.env,
      TESSERA_ACL_TARGET: targetPath,
      TESSERA_ACL_DIRECTORY: directory ? '1' : '0',
    },
    windowsHide: true,
  });
}

async function assertPrivateDescriptorPath(descriptorPath: string): Promise<void> {
  const fileStat = await fs.lstat(descriptorPath);
  const parentStat = await fs.lstat(path.dirname(descriptorPath));
  if (
    !fileStat.isFile()
    || fileStat.isSymbolicLink()
    || !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
  ) {
    throw new RuntimeDescriptorError();
  }

  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.();
    if (
      (fileStat.mode & 0o077) !== 0
      || (parentStat.mode & 0o077) !== 0
      || (currentUid !== undefined && (fileStat.uid !== currentUid || parentStat.uid !== currentUid))
    ) {
      throw new RuntimeDescriptorError();
    }
  }
}

async function removeStaleTarget(descriptorPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(descriptorPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('The Control descriptor path is already occupied.');
    }
    const parsed = stat.size <= MAX_DESCRIPTOR_BYTES
      ? JSON.parse(await fs.readFile(descriptorPath, 'utf8')) as { pid?: unknown }
      : null;
    if (parsed && Number.isInteger(parsed.pid) && isProcessAlive(parsed.pid as number)) {
      throw new Error('A live Tessera runtime already owns the descriptor path.');
    }
    await fs.unlink(descriptorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof SyntaxError) {
      await fs.unlink(descriptorPath);
      return;
    }
    throw error;
  }
}

async function removeOwnedDescriptor(descriptorPath: string, runtimeId: string): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) as { runtimeId?: unknown };
    if (parsed.runtimeId === runtimeId) await fs.unlink(descriptorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
