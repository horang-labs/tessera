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
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import { getServerHostInfo } from '@/lib/system/server-host';
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
  stateDirectory?: string;
  readTesseraVersion?: () => string;
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

interface CodexHookLedgerEntry {
  home: string;
  consent: 'granted' | 'revoked';
  managedVersion?: string;
}

interface CodexHookLedger {
  version: 1;
  environments: Partial<Record<CliEnvironment, CodexHookLedgerEntry[]>>;
}

const EMPTY_LEDGER: CodexHookLedger = { version: 1, environments: {} };
let lifecycleOperationTail: Promise<void> = Promise.resolve();

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

async function writeHookDocument(
  snapshot: InspectedHookDocument,
  style: HookCommandStyle,
  operation: 'install' | 'update' | 'remove' = 'install',
): Promise<void> {
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
    const groups = Array.isArray(hooks[event])
      ? hooks[event].filter((group) => !groupLooksTesseraOwned(group))
      : [];
    if (operation !== 'remove') groups.push(desiredGroup(style, event));
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

async function readLedger(stateDirectory: string): Promise<CodexHookLedger> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(stateDirectory, 'lifecycle.json'), 'utf8'),
    ) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.environments)) {
      throw new Error('Codex hook lifecycle state has an unsupported shape.');
    }
    const ledger: CodexHookLedger = { version: 1, environments: {} };
    for (const environment of ['native', 'wsl'] as const) {
      const entries = parsed.environments[environment];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.some((entry) => (
        !isRecord(entry)
        || typeof entry.home !== 'string'
        || !entry.home
        || !['granted', 'revoked'].includes(String(entry.consent))
        || !(entry.managedVersion === undefined || typeof entry.managedVersion === 'string')
      ))) {
        throw new Error(`Codex hook lifecycle state for ${environment} is invalid.`);
      }
      ledger.environments[environment] = entries as unknown as CodexHookLedgerEntry[];
    }
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_LEDGER);
    throw error;
  }
}

async function writeLedger(stateDirectory: string, ledger: CodexHookLedger): Promise<void> {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const targetPath = path.join(stateDirectory, 'lifecycle.json');
  const temporaryPath = path.join(
    stateDirectory,
    `.lifecycle.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function findLedgerEntry(
  ledger: CodexHookLedger,
  environment: CliEnvironment,
  home: string,
): CodexHookLedgerEntry | undefined {
  return ledger.environments[environment]?.find((entry) => entry.home === home);
}

async function updateLedgerEntry(
  stateDirectory: string,
  environment: CliEnvironment,
  home: string,
  patch: { consent: 'granted' | 'revoked'; managedVersion?: string | null },
): Promise<void> {
  const ledger = await readLedger(stateDirectory);
  const entries = ledger.environments[environment] ?? [];
  const entry = entries.find((candidate) => candidate.home === home);
  if (entry) {
    entry.consent = patch.consent;
    if (patch.managedVersion === null) {
      delete entry.managedVersion;
    } else if (patch.managedVersion !== undefined) {
      entry.managedVersion = patch.managedVersion;
    }
  } else {
    entries.push({
      home,
      consent: patch.consent,
      ...(typeof patch.managedVersion === 'string'
        ? { managedVersion: patch.managedVersion }
        : {}),
    });
    ledger.environments[environment] = entries;
  }
  await writeLedger(stateDirectory, ledger);
}

function serializeLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleOperationTail.then(operation);
  lifecycleOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
  const stateDirectory = dependencies.stateDirectory
    ?? getTesseraDataPath('provider-integrations', 'codex');
  const readTesseraVersion = dependencies.readTesseraVersion
    ?? (() => getServerHostInfo().appVersion);
  const hookCwds = (context: CodexLifecycleRequestContext) => [
    normalizeCwdForCliEnvironment(
      context.workDir?.trim() || process.cwd(),
      context.environment,
    ),
  ];

  interface Scope {
    home: string;
    style: HookCommandStyle;
    entry?: CodexHookLedgerEntry;
    currentVersion: string;
  }

  const lifecycleResult = (
    scope: Scope,
    result: CodexLifecycleResult,
  ): CodexLifecycleResult => ({
    ...result,
    consent: scope.entry?.consent ?? 'not-granted',
    ...(scope.entry?.managedVersion
      ? { installedVersion: scope.entry.managedVersion }
      : {}),
    currentVersion: scope.currentVersion,
  });

  async function resolveScope(
    context: CodexLifecycleRequestContext,
  ): Promise<Scope | CodexLifecycleResult> {
    let home: string;
    try {
      home = await resolveProviderHome(context.environment);
    } catch (error) {
      return unavailableResult((error as Error).message);
    }

    let ledger: CodexHookLedger;
    try {
      ledger = await readLedger(stateDirectory);
    } catch (error) {
      return unavailableResult(`Codex hook consent state could not be read: ${(error as Error).message}`);
    }
    return {
      home,
      style: resolveHookCommandStyle(context.environment),
      entry: findLedgerEntry(ledger, context.environment, home),
      currentVersion: readTesseraVersion(),
    };
  }

  async function preflight(
    context: CodexLifecycleRequestContext,
    scope: Scope,
  ): Promise<{ hooksResponse: unknown } | CodexLifecycleResult> {

    const version = await readVersion(context.environment, context.userId).catch(() => null);
    if (!version || !versionAtLeast(version, MINIMUM_CODEX_HOOK_TRUST_VERSION)) {
      return lifecycleResult(
        scope,
        unsupportedResult(version
          ? `Installed version: ${version}.`
          : 'The installed version could not be read.'),
      );
    }

    try {
      const hooksResponse = await request({
        ...context,
        providerHomeFilesystemPath: scope.home,
      }, 'hooks/list', {
        cwds: hookCwds(context),
      });
      return { hooksResponse };
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return lifecycleResult(
          scope,
          unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`),
        );
      }
      return lifecycleResult(
        scope,
        unavailableResult(`Codex hook status could not be read: ${(error as Error).message}`),
      );
    }
  }

  async function inspect(context: CodexLifecycleRequestContext): Promise<CodexLifecycleResult> {
    const resolved = await resolveScope(context);
    if ('state' in resolved) return resolved;
    const document = await inspectHookDocument(resolved.home, resolved.style);
    if (document.state === 'conflict') {
      return lifecycleResult(resolved, {
        state: 'conflict',
        trust: 'unavailable',
        message: document.message,
      });
    }
    if (document.state === 'absent') {
      if (resolved.entry?.consent === 'granted' && !resolved.entry.managedVersion) {
        const ready = await preflight(context, resolved);
        if ('state' in ready) return ready;
      }
      return lifecycleResult(
        resolved,
        resolved.entry?.consent === 'granted' && resolved.entry.managedVersion
        ? {
            state: 'conflict',
            trust: 'unavailable',
            message: 'The consented Tessera lifecycle hook was removed outside Tessera.',
          }
        : { state: 'absent', trust: 'unchecked' },
      );
    }
    const ready = await preflight(context, resolved);
    if ('state' in ready) return ready;
    const metadata = managedMetadata(ready.hooksResponse, document.command);
    if (!metadata) {
      return lifecycleResult(resolved, {
        state: 'conflict',
        trust: 'unavailable',
        message: 'Codex did not discover the complete Tessera lifecycle hook in the user home.',
      });
    }
    return lifecycleResult(resolved, {
      state: resolved.entry?.consent === 'granted'
        && resolved.entry.managedVersion !== resolved.currentVersion
        ? 'stale'
        : 'installed',
      trust: metadata.every((hook) => hook.trustStatus === 'trusted') ? 'trusted' : 'untrusted',
    });
  }

  async function trustInstalledHook(
    context: CodexLifecycleRequestContext,
    scope: Scope,
    document: InspectedHookDocument,
  ): Promise<CodexLifecycleResult> {
    let discovered: unknown;
    try {
      discovered = await request({
        ...context,
        providerHomeFilesystemPath: scope.home,
      }, 'hooks/list', {
        cwds: hookCwds(context),
      });
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return lifecycleResult(
          scope,
          unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`),
        );
      }
      return lifecycleResult(scope, {
        state: 'installed',
        trust: 'unavailable',
        message: `Codex hook discovery failed after install: ${(error as Error).message}`,
      });
    }
    const metadata = managedMetadata(discovered, document.command);
    if (!metadata) {
      return lifecycleResult(scope, {
        state: 'conflict',
        trust: 'unavailable',
        message: 'Codex did not discover the complete Tessera lifecycle hook after install.',
      });
    }

    const authoritativeContext = {
      ...context,
      providerHomeFilesystemPath: scope.home,
    };
    try {
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
        return lifecycleResult(scope, {
          state: 'installed',
          trust: 'untrusted',
          message: 'Codex did not verify the Tessera lifecycle hook as trusted.',
        });
      }
    } catch (error) {
      if (isUnavailableHookApi(error)) {
        return lifecycleResult(
          scope,
          unsupportedResult(`Codex hook trust API is unavailable: ${(error as Error).message}`),
        );
      }
      return lifecycleResult(scope, {
        state: 'installed',
        trust: 'untrusted',
        message: `Codex hook trust failed: ${(error as Error).message}`,
      });
    }
    try {
      await updateLedgerEntry(stateDirectory, context.environment, scope.home, {
        consent: 'granted',
        managedVersion: scope.currentVersion,
      });
    } catch (error) {
      return {
        state: 'unavailable',
        trust: 'trusted',
        consent: 'granted',
        currentVersion: scope.currentVersion,
        message: `Codex hook consent state could not be recorded: ${(error as Error).message}`,
      };
    }
    return {
      state: 'installed',
      trust: 'trusted',
      consent: 'granted',
      installedVersion: scope.currentVersion,
      currentVersion: scope.currentVersion,
    };
  }

  async function installOrUpdate(
    context: CodexLifecycleRequestContext,
    operation: 'install' | 'update' | 'maintain',
  ): Promise<CodexLifecycleResult> {
    const resolved = await resolveScope(context);
    if ('state' in resolved) return resolved;
    if (operation !== 'install' && resolved.entry?.consent !== 'granted') {
      return lifecycleResult(resolved, {
        state: 'absent',
        trust: 'unchecked',
        message: 'Explicit consent is required before Tessera can manage this Codex lifecycle hook.',
      });
    }

    let document = await inspectHookDocument(resolved.home, resolved.style);
    let materialized = false;
    if (document.state === 'conflict') {
      const mayResolve = operation !== 'maintain'
        && resolved.entry !== undefined
        && document.document !== undefined
        && document.originalText !== undefined;
      if (!mayResolve) {
        return lifecycleResult(resolved, {
          state: 'conflict', trust: 'unavailable', message: document.message,
        });
      }
    }
    if (operation === 'install') {
      try {
        await updateLedgerEntry(stateDirectory, context.environment, resolved.home, {
          consent: 'granted',
          ...(document.state === 'installed' && resolved.entry?.managedVersion
            ? { managedVersion: resolved.entry.managedVersion }
            : { managedVersion: null }),
        });
      } catch (error) {
        return lifecycleResult(resolved, {
          state: 'unavailable',
          trust: 'unavailable',
          message: `Codex hook consent could not be recorded: ${(error as Error).message}`,
        });
      }
      resolved.entry = {
        home: resolved.home,
        consent: 'granted',
        ...(document.state === 'installed' && resolved.entry?.managedVersion
          ? { managedVersion: resolved.entry.managedVersion }
          : {}),
      };
    }
    const ready = await preflight(context, resolved);
    if ('state' in ready) return ready;
    if (
      operation === 'maintain'
      && document.state === 'absent'
      && resolved.entry?.consent === 'granted'
      && resolved.entry.managedVersion
    ) {
      return lifecycleResult(resolved, {
        state: 'conflict',
        trust: 'unavailable',
        message: 'The consented Tessera lifecycle hook was removed outside Tessera.',
      });
    }
    if (document.state !== 'installed') {
      try {
        await writeHookDocument(
          document,
          resolved.style,
          document.state === 'conflict' ? 'update' : 'install',
        );
        materialized = true;
      } catch (error) {
        return lifecycleResult(resolved, {
          state: 'conflict', trust: 'unavailable', message: (error as Error).message,
        });
      }
      document = await inspectHookDocument(resolved.home, resolved.style);
      if (document.state !== 'installed') {
        return lifecycleResult(resolved, {
          state: 'conflict',
          trust: 'unavailable',
          message: document.message ?? 'The Tessera lifecycle hook could not be verified after install.',
        });
      }
    } else if (
      operation === 'maintain'
      && resolved.entry?.managedVersion === resolved.currentVersion
    ) {
      const metadata = managedMetadata(ready.hooksResponse, document.command);
      if (metadata?.every((hook) => hook.trustStatus === 'trusted')) {
        return lifecycleResult(resolved, { state: 'installed', trust: 'trusted' });
      }
    }

    if (
      document.state === 'installed'
      && !materialized
      && (operation === 'update' || resolved.entry?.managedVersion !== resolved.currentVersion)
    ) {
      try {
        await writeHookDocument(document, resolved.style, 'update');
      } catch (error) {
        return lifecycleResult(resolved, {
          state: 'conflict', trust: 'unavailable', message: (error as Error).message,
        });
      }
      document = await inspectHookDocument(resolved.home, resolved.style);
      if (document.state !== 'installed') {
        return lifecycleResult(resolved, {
          state: 'conflict',
          trust: 'unavailable',
          message: document.message ?? 'The Tessera lifecycle hook could not be verified after update.',
        });
      }
    }

    return trustInstalledHook(context, resolved, document);
  }

  async function remove(context: CodexLifecycleRequestContext): Promise<CodexLifecycleResult> {
    const resolved = await resolveScope(context);
    if ('state' in resolved) return resolved;
    const document = await inspectHookDocument(resolved.home, resolved.style);
    const knownManagedHome = resolved.entry !== undefined;
    const removable = document.state === 'installed'
      || (document.state === 'conflict'
        && knownManagedHome
        && document.document !== undefined
        && document.originalText !== undefined);
    if (document.state === 'conflict' && !removable) {
      return lifecycleResult(resolved, {
        state: 'conflict', trust: 'unavailable', message: document.message,
      });
    }
    if (removable) {
      try {
        await writeHookDocument(document, resolved.style, 'remove');
      } catch (error) {
        return lifecycleResult(resolved, {
          state: 'conflict', trust: 'unavailable', message: (error as Error).message,
        });
      }
    }
    try {
      await updateLedgerEntry(stateDirectory, context.environment, resolved.home, {
        consent: 'revoked',
        managedVersion: null,
      });
    } catch (error) {
      return lifecycleResult(resolved, {
        state: 'unavailable',
        trust: 'unavailable',
        message: `Codex hook revocation could not be recorded: ${(error as Error).message}`,
      });
    }
    return {
      state: 'absent',
      trust: 'unchecked',
      consent: 'revoked',
      currentVersion: resolved.currentVersion,
    };
  }

  return {
    inspect: (context) => serializeLifecycleOperation(() => inspect(context)),
    install: (context) => serializeLifecycleOperation(() => installOrUpdate(context, 'install')),
    update: (context) => serializeLifecycleOperation(() => installOrUpdate(context, 'update')),
    maintain: (context) => serializeLifecycleOperation(() => installOrUpdate(context, 'maintain')),
    remove: (context) => serializeLifecycleOperation(() => remove(context)),
  };
}
