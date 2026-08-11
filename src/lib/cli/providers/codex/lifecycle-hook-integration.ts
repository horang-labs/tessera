import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  CodexAppServerRequestError,
  executeCodexAppServerRequest,
} from './app-server-request-client';
import { resolveProviderCliCommand } from '@/lib/cli/provider-command';
import { execCli, parseVersion, type CliEnvironment } from '@/lib/cli/cli-exec';
import { buildCodexHookSettings } from '@/lib/terminal/codex-hook-settings';
import type { HookCommandStyle } from '@/lib/terminal/hook-command';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { isRunningInWsl } from '@/lib/cli/cli-exec';
import { resolveCodexHomeForEnvironment } from './provider-home';
import { normalizeCwdForCliEnvironment } from '@/lib/cli/spawn-cli';
import type {
  ProviderLifecycleContext,
  ProviderLifecycleIntegration,
  ProviderLifecycleResult,
} from '@/lib/cli/providers/provider-contract';

export const MINIMUM_CODEX_HOOK_TRUST_VERSION = '0.146.0';
export const CODEX_UPDATE_COMMAND = 'codex update';

const MANAGED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const;

const MANAGED_CODEX_EVENT_NAMES = new Set([
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'permissionRequest',
  'postToolUse',
  'stop',
]);

type ManagedEvent = typeof MANAGED_EVENTS[number];

interface HookHandler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: unknown;
  [key: string]: unknown;
}

interface HookDocument {
  hooks?: unknown;
  [key: string]: unknown;
}

interface CodexHookMetadata {
  key?: unknown;
  eventName?: unknown;
  command?: unknown;
  source?: unknown;
  currentHash?: unknown;
  trustStatus?: unknown;
  enabled?: unknown;
}

interface CodexHooksListResponse {
  data?: Array<{
    hooks?: CodexHookMetadata[];
    warnings?: unknown;
    errors?: unknown;
  }>;
}

export interface CodexLifecycleRequestContext extends ProviderLifecycleContext {
  providerHomeFilesystemPath?: string;
}

export interface CodexLifecycleDependencies {
  resolveProviderHome?: (environment: CliEnvironment) => Promise<string>;
  readVersion?: (environment: CliEnvironment, userId?: string) => Promise<string | null>;
  request?: (
    context: CodexLifecycleRequestContext,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export type CodexLifecycleResult = ProviderLifecycleResult;

interface InspectedHookDocument {
  state: 'absent' | 'installed' | 'conflict';
  filePath: string;
  document?: HookDocument;
  originalText?: string;
  mode?: number;
  command: string;
  message?: string;
}

interface ManagedHookMetadata {
  key: string;
  currentHash: string;
  trustStatus: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(/[.-]/, 3).map(Number);
  const minimumParts = minimum.split('.', 3).map(Number);
  if (actualParts.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

function unsupportedResult(detail?: string): CodexLifecycleResult {
  const message = [
    `Codex ${MINIMUM_CODEX_HOOK_TRUST_VERSION} or newer is required for supported hook trust.`,
    `Run \`${CODEX_UPDATE_COMMAND}\` and retry.`,
    detail,
  ].filter(Boolean).join(' ');
  return {
    state: 'unavailable',
    trust: 'unavailable',
    message,
    guidance: {
      minimumVersion: MINIMUM_CODEX_HOOK_TRUST_VERSION,
      updateCommand: CODEX_UPDATE_COMMAND,
      message,
    },
  };
}

function unavailableResult(message: string): CodexLifecycleResult {
  return { state: 'unavailable', trust: 'unavailable', message };
}

function isUnavailableHookApi(error: unknown): boolean {
  return (error instanceof CodexAppServerRequestError && error.rpcCode === -32601)
    || /(?:method|rpc).*(?:not found|unknown)|(?:not found|unknown).*(?:method|rpc)/i
      .test(error instanceof Error ? error.message : String(error));
}

function resolveHookCommandStyle(environment: CliEnvironment): HookCommandStyle {
  if (
    environment === 'native'
    && (getRuntimePlatform() === 'win32' || isRunningInWsl())
  ) {
    return 'windows-cmd';
  }
  return 'posix';
}

function desiredGroup(style: HookCommandStyle, event: ManagedEvent): HookGroup {
  return buildCodexHookSettings(style).hooks[event][0] as unknown as HookGroup;
}

function groupIsExact(group: unknown, expected: HookGroup): boolean {
  return JSON.stringify(group) === JSON.stringify(expected);
}

function groupLooksTesseraOwned(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((handler) => {
    if (!isRecord(handler) || typeof handler.command !== 'string') return false;
    return handler.command.includes('/__tessera/hook')
      || handler.command.includes('X-Tessera-Pane-Token');
  });
}

async function resolveHookFilePath(hooksPath: string): Promise<string> {
  try {
    const stat = await fs.lstat(hooksPath);
    return stat.isSymbolicLink() ? await fs.realpath(hooksPath) : hooksPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hooksPath;
    throw error;
  }
}

async function inspectHookDocument(home: string, style: HookCommandStyle): Promise<InspectedHookDocument> {
  const configuredPath = path.join(home, 'hooks.json');
  let filePath: string;
  try {
    filePath = await resolveHookFilePath(configuredPath);
  } catch (error) {
    return {
      state: 'conflict',
      filePath: configuredPath,
      command: String(desiredGroup(style, 'SessionStart').hooks),
      message: `Codex hooks.json cannot be resolved safely: ${(error as Error).message}`,
    };
  }

  let originalText = '';
  let mode = 0o600;
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(filePath, 'utf8'),
      fs.stat(filePath),
    ]);
    originalText = text;
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        state: 'conflict',
        filePath,
        command: String(desiredGroup(style, 'SessionStart').hooks),
        message: `Codex hooks.json cannot be read: ${(error as Error).message}`,
      };
    }
  }

  let document: HookDocument = { hooks: {} };
  if (originalText.trim()) {
    try {
      const parsed = JSON.parse(originalText) as unknown;
      if (!isRecord(parsed)) throw new Error('the document root is not an object');
      document = parsed;
    } catch (error) {
      return {
        state: 'conflict',
        filePath,
        originalText,
        mode,
        command: String(desiredGroup(style, 'SessionStart').hooks),
        message: `Codex hooks.json is not valid JSON: ${(error as Error).message}`,
      };
    }
  }

  if (document.hooks !== undefined && !isRecord(document.hooks)) {
    return {
      state: 'conflict',
      filePath,
      document,
      originalText,
      mode,
      command: String(desiredGroup(style, 'SessionStart').hooks),
      message: 'Codex hooks.json has a non-object hooks field.',
    };
  }

  const hooks = (document.hooks ?? {}) as Record<string, unknown>;
  let installedEvents = 0;
  let managedCommand = '';
  for (const event of MANAGED_EVENTS) {
    const expected = desiredGroup(style, event);
    const handler = (expected.hooks as HookHandler[])[0];
    managedCommand = typeof handler.command === 'string' ? handler.command : managedCommand;
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      return {
        state: 'conflict', filePath, document, originalText, mode, command: managedCommand,
        message: `Codex hooks.json has a non-array ${event} hook list.`,
      };
    }
    const tesseraGroups = (groups ?? []).filter(groupLooksTesseraOwned);
    const exactGroups = (groups ?? []).filter((group) => groupIsExact(group, expected));
    if (tesseraGroups.length !== exactGroups.length || exactGroups.length > 1) {
      return {
        state: 'conflict', filePath, document, originalText, mode, command: managedCommand,
        message: `The Tessera ${event} hook differs from the managed definition.`,
      };
    }
    if (exactGroups.length === 1) installedEvents += 1;
  }

  if (installedEvents !== 0 && installedEvents !== MANAGED_EVENTS.length) {
    return {
      state: 'conflict', filePath, document, originalText, mode, command: managedCommand,
      message: 'Only part of the Tessera lifecycle hook is installed.',
    };
  }

  return {
    state: installedEvents === MANAGED_EVENTS.length ? 'installed' : 'absent',
    filePath,
    document,
    originalText,
    mode,
    command: managedCommand,
  };
}

async function writeHookDocument(snapshot: InspectedHookDocument, style: HookCommandStyle): Promise<void> {
  if (!snapshot.document || snapshot.originalText === undefined || snapshot.mode === undefined) {
    throw new Error('The Codex hook document is not writable.');
  }

  const currentText = await fs.readFile(snapshot.filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (currentText !== snapshot.originalText) {
    throw new Error('Codex hooks.json changed while Tessera was preparing the install.');
  }

  const nextDocument = structuredClone(snapshot.document);
  const hooks = isRecord(nextDocument.hooks) ? nextDocument.hooks : {};
  nextDocument.hooks = hooks;
  for (const event of MANAGED_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    groups.push(desiredGroup(style, event));
    hooks[event] = groups;
  }

  await fs.mkdir(path.dirname(snapshot.filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(snapshot.filePath),
    `.${path.basename(snapshot.filePath)}.tessera-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
      encoding: 'utf8',
      mode: snapshot.mode,
      flag: 'wx',
    });
    await fs.chmod(temporaryPath, snapshot.mode);
    await fs.rename(temporaryPath, snapshot.filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function managedMetadata(response: unknown, command: string): ManagedHookMetadata[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const metadata: ManagedHookMetadata[] = [];
  const seenEvents = new Set<string>();
  const entries = response.data as NonNullable<CodexHooksListResponse['data']>;
  for (const entry of entries) {
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
      if (
        hook.command !== command
        || hook.source !== 'user'
        || typeof hook.key !== 'string'
        || !hook.key
        || typeof hook.currentHash !== 'string'
        || !hook.currentHash
        || typeof hook.eventName !== 'string'
        || !MANAGED_CODEX_EVENT_NAMES.has(hook.eventName)
        || typeof hook.trustStatus !== 'string'
        || hook.enabled !== true
      ) continue;
      if (seenEvents.has(hook.eventName)) return null;
      seenEvents.add(hook.eventName);
      metadata.push({
        key: hook.key,
        currentHash: hook.currentHash,
        trustStatus: hook.trustStatus,
      });
    }
  }
  return metadata.length === MANAGED_EVENTS.length ? metadata : null;
}

async function defaultReadVersion(environment: CliEnvironment, userId?: string): Promise<string | null> {
  const command = await resolveProviderCliCommand('codex', 'codex', environment, userId);
  const result = await execCli(command, ['--version'], environment, 5_000);
  return result.ok ? parseVersion(result.stdout) ?? null : null;
}

export function createCodexLifecycleHookIntegration(
  dependencies: CodexLifecycleDependencies = {},
): ProviderLifecycleIntegration {
  const resolveProviderHome = dependencies.resolveProviderHome ?? resolveCodexHomeForEnvironment;
  const readVersion = dependencies.readVersion ?? defaultReadVersion;
  const request = dependencies.request ?? executeCodexAppServerRequest;
  const hookCwds = (context: CodexLifecycleRequestContext) => [
    normalizeCwdForCliEnvironment(
      context.workDir?.trim() || process.cwd(),
      context.environment,
    ),
  ];

  async function preflight(context: CodexLifecycleRequestContext): Promise<{
    home: string;
    hooksResponse: unknown;
    style: HookCommandStyle;
  } | CodexLifecycleResult> {
    let home: string;
    try {
      home = await resolveProviderHome(context.environment);
    } catch (error) {
      return unavailableResult((error as Error).message);
    }

    const version = await readVersion(context.environment, context.userId).catch(() => null);
    if (!version || !versionAtLeast(version, MINIMUM_CODEX_HOOK_TRUST_VERSION)) {
      return unsupportedResult(version ? `Installed version: ${version}.` : 'The installed version could not be read.');
    }

    try {
      const hooksResponse = await request({
        ...context,
        providerHomeFilesystemPath: home,
      }, 'hooks/list', {
        cwds: hookCwds(context),
      });
      return { home, hooksResponse, style: resolveHookCommandStyle(context.environment) };
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`);
      }
      return unavailableResult(`Codex hook status could not be read: ${(error as Error).message}`);
    }
  }

  async function inspect(context: CodexLifecycleRequestContext): Promise<CodexLifecycleResult> {
    const ready = await preflight(context);
    if ('state' in ready) return ready;
    const document = await inspectHookDocument(ready.home, ready.style);
    if (document.state === 'conflict') {
      return { state: 'conflict', trust: 'unavailable', message: document.message };
    }
    if (document.state === 'absent') {
      return { state: 'absent', trust: 'unchecked' };
    }
    const metadata = managedMetadata(ready.hooksResponse, document.command);
    if (!metadata) {
      return {
        state: 'conflict',
        trust: 'unavailable',
        message: 'Codex did not discover the complete Tessera lifecycle hook in the user home.',
      };
    }
    return {
      state: 'installed',
      trust: metadata.every((hook) => hook.trustStatus === 'trusted') ? 'trusted' : 'untrusted',
    };
  }

  async function install(context: CodexLifecycleRequestContext): Promise<CodexLifecycleResult> {
    const ready = await preflight(context);
    if ('state' in ready) return ready;
    let document = await inspectHookDocument(ready.home, ready.style);
    if (document.state === 'conflict') {
      return { state: 'conflict', trust: 'unavailable', message: document.message };
    }
    if (document.state === 'absent') {
      try {
        await writeHookDocument(document, ready.style);
      } catch (error) {
        return { state: 'conflict', trust: 'unavailable', message: (error as Error).message };
      }
      document = await inspectHookDocument(ready.home, ready.style);
      if (document.state !== 'installed') {
        return {
          state: 'conflict',
          trust: 'unavailable',
          message: document.message ?? 'The Tessera lifecycle hook could not be verified after install.',
        };
      }
    }

    let discovered: unknown;
    try {
      discovered = await request({
        ...context,
        providerHomeFilesystemPath: ready.home,
      }, 'hooks/list', {
        cwds: hookCwds(context),
      });
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`);
      }
      return {
        state: 'installed',
        trust: 'unavailable',
        message: `Codex hook discovery failed after install: ${(error as Error).message}`,
      };
    }
    const metadata = managedMetadata(discovered, document.command);
    if (!metadata) {
      return {
        state: 'conflict',
        trust: 'unavailable',
        message: 'Codex did not discover the complete Tessera lifecycle hook after install.',
      };
    }

    try {
      const authoritativeContext = {
        ...context,
        providerHomeFilesystemPath: ready.home,
      };
      await request(authoritativeContext, 'config/batchWrite', {
        edits: [{
          keyPath: 'hooks.state',
          value: Object.fromEntries(metadata.map((hook) => [
            hook.key,
            { trusted_hash: hook.currentHash },
          ])),
          mergeStrategy: 'upsert',
        }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      });
      const verified = await request(authoritativeContext, 'hooks/list', {
        cwds: hookCwds(context),
      });
      const verifiedMetadata = managedMetadata(verified, document.command);
      if (!verifiedMetadata || !verifiedMetadata.every((hook) => hook.trustStatus === 'trusted')) {
        return {
          state: 'installed',
          trust: 'untrusted',
          message: 'Codex did not verify the Tessera lifecycle hook as trusted.',
        };
      }
      return { state: 'installed', trust: 'trusted' };
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`);
      }
      return {
        state: 'installed',
        trust: 'untrusted',
        message: `Codex hook trust failed: ${(error as Error).message}`,
      };
    }
  }

  return { inspect, install };
}
