import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import logger from '@/lib/logger';
import {
  readBundledTesseraControlSkillFiles,
  TESSERA_CONTROL_SKILL_NAME,
  type BundledTesseraControlSkillFile,
} from '@/lib/terminal/tessera-control-skill';
import { PROVIDER_SKILL_IDS, type ProviderSkillId } from './provider-skill-id';

export { PROVIDER_SKILL_IDS, type ProviderSkillId } from './provider-skill-id';
export type ProviderSkillOperation = 'install' | 'status' | 'update' | 'remove';

export interface ProviderSkillStatus {
  providerId: ProviderSkillId;
  detected: boolean;
  state: 'absent' | 'ready' | 'stale' | 'conflict' | 'unavailable';
  consent: 'granted' | 'revoked' | 'not-granted';
  ownership: 'none' | 'tessera' | 'user' | 'unknown';
}

export interface ProviderSkillManagementResult {
  success: boolean;
  operation: ProviderSkillOperation;
  agentEnvironment: AgentEnvironment;
  providers: ProviderSkillStatus[];
  error?: {
    code:
      | 'PROVIDER_SKILL_CONFLICT'
      | 'PROVIDER_SKILL_CONSENT_REQUIRED'
      | 'PROVIDER_SKILL_NO_PROVIDERS'
      | 'PROVIDER_SKILL_ENVIRONMENT_CHANGED'
      | 'PROVIDER_SKILL_TRANSACTION_FAILED';
    message: string;
  };
}

export interface ProviderSkillManagementRequest {
  operation: ProviderSkillOperation;
  agentEnvironmentOwner:
    | { kind: 'user'; userId: string }
    | { kind: 'server-default' };
  providerIds?: ProviderSkillId[];
  expectedAgentEnvironment?: AgentEnvironment;
}

export interface ProviderSkillCleanupArtifact {
  providerId: ProviderSkillId;
  agentEnvironment: AgentEnvironment;
  providerHome?: string;
  state: 'removed' | 'absent' | 'conflict' | 'failed';
  message?: string;
}

export interface ProviderSkillCleanupResult {
  artifacts: ProviderSkillCleanupArtifact[];
  discoveryProblems: Array<{
    code: 'KNOWN_STATE_UNREADABLE' | 'LEGACY_HOMES_UNKNOWN';
    message: string;
  }>;
}

export interface ProviderSkillManagerOptions {
  resolveAgentEnvironment: (userId: string) => Promise<AgentEnvironment>;
  resolveDefaultEnvironment: () => Promise<AgentEnvironment>;
  detectSkillProviders: (
    environment: AgentEnvironment,
    providerIds?: ProviderSkillId[],
  ) => Promise<ProviderSkillId[]>;
  resolveProviderSkillHome: (
    providerId: ProviderSkillId,
    environment: AgentEnvironment,
  ) => Promise<string>;
  providerSkillStateDirectory?: string;
  readProviderSkillFiles?: () => BundledTesseraControlSkillFile[];
  renameProviderSkillPath?: (source: string, destination: string) => Promise<void>;
}

interface ProviderLedgerEntry {
  consent: 'granted' | 'revoked';
  /** Provider homes where Tessera has installed this artifact over time. */
  knownHomes?: string[];
  /** A pre-home-ledger installation may still exist at an unrecorded earlier home. */
  unknownEarlierHomes?: true;
}

interface ProviderSkillLedger {
  version: 1;
  environments: Partial<Record<AgentEnvironment, Partial<Record<ProviderSkillId, ProviderLedgerEntry>>>>;
}

const EMPTY_LEDGER: ProviderSkillLedger = { version: 1, environments: {} };
const MARKER_FILE = '.tessera-managed.json';

interface InspectedProviderSkill {
  providerId: ProviderSkillId;
  detected: boolean;
  providerHome: string;
  targetDir: string;
  status: ProviderSkillStatus;
}

interface PreparedMutation {
  targetDir: string;
  stageDir?: string;
  backupDir?: string;
  committed: boolean;
}

interface ProviderSkillManagementExecution {
  agentEnvironment: AgentEnvironment;
  detectedProviderIds: ProviderSkillId[];
}

export interface ProviderSkillManager {
  manage(request: ProviderSkillManagementRequest): Promise<ProviderSkillManagementResult>;
  maintain(
    agentEnvironmentOwner: ProviderSkillManagementRequest['agentEnvironmentOwner'],
    providerId: ProviderSkillId,
    resolvedAgentEnvironment?: AgentEnvironment,
  ): Promise<{ agentEnvironment: AgentEnvironment; status: ProviderSkillStatus }>;
  cleanupKnownArtifacts(): Promise<ProviderSkillCleanupResult>;
}

export async function detectSupportedProviderSkills(
  environment: AgentEnvironment,
  providerIds: ProviderSkillId[] = [...PROVIDER_SKILL_IDS],
): Promise<ProviderSkillId[]> {
  const detected: ProviderSkillId[] = [];
  for (const providerId of providerIds) {
    if (!cliProviderRegistry.hasProvider(providerId)) continue;
    try {
      if (await cliProviderRegistry.getProvider(providerId).isAvailable(environment)) {
        detected.push(providerId);
      }
    } catch {
      // Detection is advisory. An explicitly selected provider is still manageable.
    }
  }
  return detected;
}

export async function resolveOwnedProviderSkillHome(
  providerId: ProviderSkillId,
  environment: AgentEnvironment,
): Promise<string> {
  const provider = cliProviderRegistry.getProvider(providerId);
  if (!provider.resolveSkillHome) {
    throw new Error(`Provider ${providerId} does not declare a global skill home.`);
  }
  return provider.resolveSkillHome(environment);
}

export function createProviderSkillManager(
  options: ProviderSkillManagerOptions,
): ProviderSkillManager {
  const stateDirectory = options.providerSkillStateDirectory
    ?? getTesseraDataPath('provider-skills');
  const readSkillFiles = options.readProviderSkillFiles
    ?? (() => readBundledTesseraControlSkillFiles());
  const renameProviderSkillPath = options.renameProviderSkillPath ?? fs.rename;
  let operationTail: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    cleanupKnownArtifacts: () => serialize(cleanupKnownArtifacts),
    async maintain(agentEnvironmentOwner, providerId, resolvedAgentEnvironment) {
      return serialize(async () => {
        const agentEnvironment = resolvedAgentEnvironment ?? (
          agentEnvironmentOwner.kind === 'user'
            ? await options.resolveAgentEnvironment(agentEnvironmentOwner.userId)
            : await options.resolveDefaultEnvironment()
        );
        const userId = agentEnvironmentOwner.kind === 'user'
          ? agentEnvironmentOwner.userId
          : 'server-default';
        const ledger = await readLedger(stateDirectory, userId);
        const consent = ledger.environments[agentEnvironment]?.[providerId]?.consent
          ?? 'not-granted';
        try {
          const result = await manageResolved({
            operation: consent === 'granted' ? 'update' : 'status',
            agentEnvironmentOwner,
            providerIds: [providerId],
          }, {
            agentEnvironment,
            detectedProviderIds: [providerId],
          });
          return {
            agentEnvironment,
            status: result.providers[0] ?? {
              providerId,
              detected: true,
              state: 'unavailable',
              consent,
              ownership: 'unknown',
            },
          };
        } catch {
          return {
            agentEnvironment,
            status: {
              providerId,
              detected: true,
              state: 'unavailable',
              consent,
              ownership: 'unknown',
            },
          };
        }
      });
    },
    manage: (request) => serialize(() => manageResolved(request)),
  };

  async function cleanupKnownArtifacts(): Promise<ProviderSkillCleanupResult> {
    const discovered = await discoverKnownProviderSkillScopes(stateDirectory);
    const artifacts: ProviderSkillCleanupArtifact[] = [];

    for (const { agentEnvironment, providerId, knownHome } of discovered.scopes) {
      let providerHome: string;
      try {
        // Re-enter the owning Agent Environment even when an earlier validated
        // home is recorded. An unreachable WSL/native boundary must not be
        // mistaken for an absent artifact on the server's filesystem.
        const currentOwnedHome = await options.resolveProviderSkillHome(
          providerId,
          agentEnvironment,
        );
        providerHome = knownHome ?? currentOwnedHome;
      } catch (error) {
        artifacts.push({
          providerId,
          agentEnvironment,
          ...(knownHome ? { providerHome: knownHome } : {}),
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const targetDir = path.join(providerHome, 'skills', TESSERA_CONTROL_SKILL_NAME);

      try {
        const status = await inspectProviderSkill(
          providerId,
          targetDir,
          undefined,
          'not-granted',
        );
        if (status.state === 'absent') {
          artifacts.push({ providerId, agentEnvironment, providerHome, state: 'absent' });
          continue;
        }
        if (status.state === 'conflict' || status.state === 'unavailable') {
          artifacts.push({
            providerId,
            agentEnvironment,
            providerHome,
            state: status.state === 'conflict' ? 'conflict' : 'failed',
            message: status.state === 'conflict'
              ? 'The known tessera-cli skill is user-owned or externally modified.'
              : 'The known tessera-cli skill could not be inspected.',
          });
          continue;
        }
        await fs.rm(targetDir, { recursive: true });
        const verified = await inspectProviderSkill(
          providerId,
          targetDir,
          undefined,
          'not-granted',
        );
        artifacts.push({
          providerId,
          agentEnvironment,
          providerHome,
          state: verified.state === 'absent' ? 'removed' : 'failed',
          ...(verified.state === 'absent'
            ? {}
            : { message: 'The tessera-cli skill remained after cleanup.' }),
        });
      } catch (error) {
        artifacts.push({
          providerId,
          agentEnvironment,
          providerHome,
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { artifacts, discoveryProblems: discovered.problems };
  }

  async function manageResolved(
    request: ProviderSkillManagementRequest,
    execution?: ProviderSkillManagementExecution,
  ): Promise<ProviderSkillManagementResult> {
      const environment = execution?.agentEnvironment ?? (
        request.agentEnvironmentOwner.kind === 'user'
          ? await options.resolveAgentEnvironment(request.agentEnvironmentOwner.userId)
          : await options.resolveDefaultEnvironment()
      );
      if (
        request.expectedAgentEnvironment
        && request.expectedAgentEnvironment !== environment
      ) {
        return {
          success: false,
          operation: request.operation,
          agentEnvironment: environment,
          providers: [],
          error: {
            code: 'PROVIDER_SKILL_ENVIRONMENT_CHANGED',
            message: 'The Agent Environment changed after this provider skill action was offered. '
              + 'Refresh the integration state and consent again for the current environment.',
          },
        };
      }
      const userId = request.agentEnvironmentOwner.kind === 'user'
        ? request.agentEnvironmentOwner.userId
        : 'server-default';
      const requestedProviderIds = request.providerIds
        ? [...new Set(request.providerIds)]
        : undefined;
      const detected = execution?.detectedProviderIds
        ?? await options.detectSkillProviders(environment, requestedProviderIds);
      const selected = requestedProviderIds ?? detected;
      if (request.operation !== 'status' && selected.length === 0) {
        return {
          success: false,
          operation: request.operation,
          agentEnvironment: environment,
          providers: [],
          error: {
            code: 'PROVIDER_SKILL_NO_PROVIDERS',
            message: 'No supported provider was detected in the current Agent Environment. '
              + 'Install Claude Code, Codex, or OpenCode, or select a provider explicitly.',
          },
        };
      }
      const files = readSkillFiles();
      const digest = digestSkillFiles(files);
      const ledger = await readLedger(stateDirectory, userId);

      const inspected: InspectedProviderSkill[] = [];
      try {
        for (const providerId of selected) {
          const ledgerEntry = ledger.environments[environment]?.[providerId];
          const consent = ledgerEntry?.consent ?? 'not-granted';
          const isDetected = detected.includes(providerId);
          try {
            const providerHome = await options.resolveProviderSkillHome(providerId, environment);
            const targetDir = path.join(providerHome, 'skills', TESSERA_CONTROL_SKILL_NAME);
            // An absent artifact is an external-deletion conflict only when Tessera
            // previously installed into this exact home. A newly authoritative home,
            // and a pre-home-ledger installation, must remain installable while the
            // original consent and cleanup uncertainty are preserved in the ledger.
            const inspectionConsent = consent === 'granted'
              && !ledgerEntry?.knownHomes?.includes(providerHome)
              ? 'not-granted'
              : consent;
            inspected.push({
              providerId,
              detected: isDetected,
              providerHome,
              targetDir,
              status: {
                ...await inspectProviderSkill(providerId, targetDir, digest, inspectionConsent),
                detected: isDetected,
                consent,
              },
            });
          } catch (error) {
            if (request.operation !== 'status') throw error;
            inspected.push({
              providerId,
              detected: isDetected,
              providerHome: '',
              targetDir: '',
              status: {
                providerId,
                detected: isDetected,
                state: 'unavailable',
                consent,
                ownership: 'unknown',
              },
            });
          }
        }

        if (request.operation === 'status') {
          return {
            success: true,
            operation: request.operation,
            agentEnvironment: environment,
            providers: inspected.map(({ status }) => status),
          };
        }

        if (
          request.operation === 'update'
          && inspected.some(({ status }) => status.consent !== 'granted')
        ) {
          return {
            success: false,
            operation: request.operation,
            agentEnvironment: environment,
            providers: inspected.map(({ status }) => status),
            error: {
              code: 'PROVIDER_SKILL_CONSENT_REQUIRED',
              message: 'Install the selected provider skill explicitly before updating it.',
            },
          };
        }

        if (inspected.some(({ status }) => status.state === 'conflict')) {
          return {
            success: false,
            operation: request.operation,
            agentEnvironment: environment,
            providers: inspected.map(({ status }) => status),
            error: {
              code: 'PROVIDER_SKILL_CONFLICT',
              message: 'A selected provider has a user-owned or externally modified tessera-cli skill.',
            },
          };
        }

        const prepared = request.operation === 'remove'
          ? await prepareRemoveMutations(inspected)
          : await prepareInstallMutations(inspected, files, digest);
        await commitMutations(prepared, renameProviderSkillPath);
        if (request.operation === 'install' || request.operation === 'update') {
          ledger.environments[environment] ??= {};
          for (const provider of inspected) {
            const existing = ledger.environments[environment]![provider.providerId];
            ledger.environments[environment]![provider.providerId] = {
              consent: 'granted',
              knownHomes: [...new Set([...(existing?.knownHomes ?? []), provider.providerHome])],
              ...(existing && (existing.unknownEarlierHomes || !existing.knownHomes)
                ? { unknownEarlierHomes: true as const }
                : {}),
            };
          }
        } else if (request.operation === 'remove') {
          ledger.environments[environment] ??= {};
          for (const providerId of selected) {
            const existing = ledger.environments[environment]![providerId];
            ledger.environments[environment]![providerId] = {
              consent: 'revoked',
              ...(existing?.knownHomes ? { knownHomes: existing.knownHomes } : {}),
              ...(existing?.unknownEarlierHomes ? { unknownEarlierHomes: true as const } : {}),
            };
          }
        }
        try {
          await writeLedger(stateDirectory, userId, ledger);
        } catch (error) {
          try {
            await rollbackMutations(prepared, renameProviderSkillPath);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Provider skill state could not be committed and rollback was incomplete.',
            );
          }
          throw error;
        }
        await discardCommittedBackups(prepared);
        return {
          success: true,
          operation: request.operation,
          agentEnvironment: environment,
          providers: selected.map((providerId) => ({
            providerId,
            detected: detected.includes(providerId),
            state: request.operation === 'remove' ? 'absent' : 'ready',
            consent: request.operation === 'remove' ? 'revoked' : 'granted',
            ownership: request.operation === 'remove' ? 'none' : 'tessera',
          })),
        };
      } catch (error) {
        return {
          success: false,
          operation: request.operation,
          agentEnvironment: environment,
          providers: [],
          error: {
            code: 'PROVIDER_SKILL_TRANSACTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
}

async function discoverKnownProviderSkillScopes(stateDirectory: string): Promise<{
  scopes: Array<{
    agentEnvironment: AgentEnvironment;
    providerId: ProviderSkillId;
    knownHome?: string;
  }>;
  problems: ProviderSkillCleanupResult['discoveryProblems'];
}> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scopes: [], problems: [] };
    return {
      scopes: [],
      problems: [{
        code: 'KNOWN_STATE_UNREADABLE',
        message: `Known provider skill state could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const known = new Map<string, {
    agentEnvironment: AgentEnvironment;
    providerId: ProviderSkillId;
    knownHome?: string;
  }>();
  const problems: ProviderSkillCleanupResult['discoveryProblems'] = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(stateDirectory, entry.name), 'utf8')) as unknown;
      if (!isProviderSkillLedger(parsed)) {
        throw new Error('the consent ledger has an unsupported shape');
      }
      for (const agentEnvironment of ['native', 'wsl'] as const) {
        for (const providerId of PROVIDER_SKILL_IDS) {
          const ledgerEntry = parsed.environments[agentEnvironment]?.[providerId];
          if (!ledgerEntry) continue;
          if (ledgerEntry.knownHomes?.length) {
            for (const knownHome of ledgerEntry.knownHomes) {
              known.set(
                JSON.stringify([agentEnvironment, providerId, knownHome]),
                { agentEnvironment, providerId, knownHome },
              );
            }
          } else {
            known.set(
              JSON.stringify([agentEnvironment, providerId]),
              { agentEnvironment, providerId },
            );
          }
          if (ledgerEntry.unknownEarlierHomes || !ledgerEntry.knownHomes) {
            problems.push({
              code: 'LEGACY_HOMES_UNKNOWN',
              message: `Legacy ${providerId} skill state for ${agentEnvironment} does not record every `
                + 'previous provider home; earlier installations cannot be verified automatically.',
            });
          }
        }
      }
    } catch (error) {
      problems.push({
        code: 'KNOWN_STATE_UNREADABLE',
        message: `Known provider skill state ${entry.name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    scopes: [...known.values()].sort((left, right) => (
      left.agentEnvironment.localeCompare(right.agentEnvironment)
      || PROVIDER_SKILL_IDS.indexOf(left.providerId) - PROVIDER_SKILL_IDS.indexOf(right.providerId)
      || (left.knownHome ?? '').localeCompare(right.knownHome ?? '')
    )),
    problems,
  };
}

function isProviderSkillLedger(value: unknown): value is ProviderSkillLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ProviderSkillLedger>;
  if (candidate.version !== 1 || !candidate.environments || typeof candidate.environments !== 'object') {
    return false;
  }
  for (const environment of Object.keys(candidate.environments)) {
    if (environment !== 'native' && environment !== 'wsl') return false;
    const providers = candidate.environments[environment];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false;
    for (const [providerId, entry] of Object.entries(providers)) {
      if (!(PROVIDER_SKILL_IDS as readonly string[]).includes(providerId)) return false;
      if (!entry || !['granted', 'revoked'].includes(String(entry.consent))) return false;
      if (
        entry.knownHomes !== undefined
        && (!Array.isArray(entry.knownHomes)
          || entry.knownHomes.some((home) => typeof home !== 'string' || !home))
      ) return false;
      if (entry.unknownEarlierHomes !== undefined && entry.unknownEarlierHomes !== true) return false;
    }
  }
  return true;
}

async function inspectProviderSkill(
  providerId: ProviderSkillId,
  targetDir: string,
  currentDigest: string | undefined,
  consent: ProviderSkillStatus['consent'],
): Promise<ProviderSkillStatus> {
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { providerId, detected: false, state: 'conflict', consent, ownership: 'user' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (consent === 'granted') {
        return { providerId, detected: false, state: 'conflict', consent, ownership: 'tessera' };
      }
      return { providerId, detected: false, state: 'absent', consent, ownership: 'none' };
    }
    throw error;
  }

  let marker: {
    schemaVersion?: unknown;
    owner?: unknown;
    providerId?: unknown;
    artifactDigest?: unknown;
  };
  try {
    marker = JSON.parse(await fs.readFile(path.join(targetDir, MARKER_FILE), 'utf8'));
  } catch {
    return { providerId, detected: false, state: 'conflict', consent, ownership: 'user' };
  }
  if (
    marker.schemaVersion !== 1
    || marker.owner !== 'tessera'
    || marker.providerId !== providerId
    || typeof marker.artifactDigest !== 'string'
  ) {
    return { providerId, detected: false, state: 'conflict', consent, ownership: 'unknown' };
  }

  const actualDigest = await digestSkillDirectory(targetDir);
  if (actualDigest !== marker.artifactDigest) {
    return { providerId, detected: false, state: 'conflict', consent, ownership: 'tessera' };
  }
  return {
    providerId,
    detected: false,
    state: currentDigest === undefined || actualDigest === currentDigest ? 'ready' : 'stale',
    consent,
    ownership: 'tessera',
  };
}

async function prepareInstallMutations(
  inspected: InspectedProviderSkill[],
  files: BundledTesseraControlSkillFile[],
  digest: string,
): Promise<PreparedMutation[]> {
  const prepared: PreparedMutation[] = [];
  try {
    for (const provider of inspected) {
      if (provider.status.state === 'ready') continue;
      const skillsDir = path.dirname(provider.targetDir);
      await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });
      const transactionId = randomUUID();
      const stageDir = path.join(skillsDir, `.${TESSERA_CONTROL_SKILL_NAME}.stage-${transactionId}`);
      await materializeSkill(stageDir, provider.providerId, files, digest);
      prepared.push({
        targetDir: provider.targetDir,
        stageDir,
        ...(provider.status.state === 'stale'
          ? { backupDir: path.join(skillsDir, `.${TESSERA_CONTROL_SKILL_NAME}.backup-${transactionId}`) }
          : {}),
        committed: false,
      });
    }
    return prepared;
  } catch (error) {
    try {
      await cleanupPreparedMutations(prepared);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Provider skill staging failed and temporary-artifact cleanup was incomplete.',
      );
    }
    throw error;
  }
}

async function prepareRemoveMutations(
  inspected: InspectedProviderSkill[],
): Promise<PreparedMutation[]> {
  return inspected.flatMap((provider) => {
    if (provider.status.state === 'absent') return [];
    const transactionId = randomUUID();
    return [{
      targetDir: provider.targetDir,
      backupDir: path.join(
        path.dirname(provider.targetDir),
        `.${TESSERA_CONTROL_SKILL_NAME}.backup-${transactionId}`,
      ),
      committed: false,
    }];
  });
}

async function commitMutations(
  prepared: PreparedMutation[],
  renamePath: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  try {
    for (const mutation of prepared) {
      if (mutation.backupDir) await renamePath(mutation.targetDir, mutation.backupDir);
      if (mutation.stageDir) await renamePath(mutation.stageDir, mutation.targetDir);
      mutation.committed = true;
    }
  } catch (error) {
    try {
      await rollbackMutations(prepared, renamePath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Provider skill commit failed and rollback was incomplete.',
      );
    }
    throw error;
  }
}

async function rollbackMutations(
  prepared: PreparedMutation[],
  renamePath: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  const errors: Error[] = [];
  for (const mutation of [...prepared].reverse()) {
    if (mutation.committed) {
      if (mutation.stageDir) {
        await captureFilesystemError(
          errors,
          `remove committed skill ${mutation.targetDir}`,
          () => fs.rm(mutation.targetDir, { recursive: true, force: true }),
        );
      }
    }
    if (mutation.backupDir) {
      await captureFilesystemError(
          errors,
          `restore provider skill ${mutation.targetDir}`,
          () => renamePath(mutation.backupDir!, mutation.targetDir),
      );
    }
    if (mutation.stageDir) {
      await captureFilesystemError(
        errors,
        `remove staged skill ${mutation.stageDir}`,
        () => fs.rm(mutation.stageDir!, { recursive: true, force: true }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Provider skill rollback was incomplete.');
  }
}

async function cleanupPreparedMutations(prepared: PreparedMutation[]): Promise<void> {
  const errors: Error[] = [];
  await Promise.all(prepared.flatMap((mutation) => [
    mutation.stageDir
      ? captureFilesystemError(
          errors,
          `remove staged skill ${mutation.stageDir}`,
          () => fs.rm(mutation.stageDir!, { recursive: true, force: true }),
        )
      : Promise.resolve(),
    mutation.backupDir
      ? captureFilesystemError(
          errors,
          `remove unused backup ${mutation.backupDir}`,
          () => fs.rm(mutation.backupDir!, { recursive: true, force: true }),
        )
      : Promise.resolve(),
  ]));
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Provider skill staging cleanup was incomplete.');
  }
}

async function discardCommittedBackups(prepared: PreparedMutation[]): Promise<void> {
  const errors: Error[] = [];
  await Promise.all(prepared.map((mutation) => (
    mutation.backupDir
      ? captureFilesystemError(
          errors,
          `remove committed backup ${mutation.backupDir}`,
          () => fs.rm(mutation.backupDir!, { recursive: true, force: true }),
        )
      : Promise.resolve()
  )));
  if (errors.length > 0) {
    // Targets and the consent ledger are already committed. Backup collection
    // is post-commit garbage collection and must not turn a unitary success
    // into a reported failure whose observable provider state is actually ready.
    logger.warn({ errors }, 'Provider skill backup cleanup will need manual recovery');
  }
}

async function captureFilesystemError(
  errors: Error[],
  action: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(new Error(`${action}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function digestSkillFiles(files: BundledTesseraControlSkillFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
  ))) {
    hash.update(file.relativePath).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex');
}

async function digestSkillDirectory(targetDir: string): Promise<string> {
  const files: BundledTesseraControlSkillFile[] = [];
  await collectSkillFiles(targetDir, '', files);
  return digestSkillFiles(files);
}

async function collectSkillFiles(
  root: string,
  relativeDir: string,
  files: BundledTesseraControlSkillFile[],
): Promise<void> {
  const entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDir.replaceAll(path.sep, '/'), entry.name);
    if (!relativeDir && entry.name === MARKER_FILE) continue;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      files.push({ relativePath, content: `__unsupported__:${entry.name}` });
    } else if (entry.isDirectory()) {
      await collectSkillFiles(root, path.join(relativeDir, entry.name), files);
    } else {
      files.push({
        relativePath,
        content: await fs.readFile(path.join(root, relativeDir, entry.name), 'utf8'),
      });
    }
  }
}

async function materializeSkill(
  targetDir: string,
  providerId: ProviderSkillId,
  files: BundledTesseraControlSkillFile[],
  digest: string,
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const targetPath = path.join(targetDir, file.relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(targetPath, file.content, { mode: 0o600 });
  }
  await fs.writeFile(path.join(targetDir, MARKER_FILE), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'tessera',
    providerId,
    artifactDigest: digest,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function readLedger(stateDirectory: string, userId: string): Promise<ProviderSkillLedger> {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath(stateDirectory, userId), 'utf8')) as ProviderSkillLedger;
    return parsed.version === 1 && parsed.environments ? parsed : structuredClone(EMPTY_LEDGER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_LEDGER);
    throw error;
  }
}

async function writeLedger(
  stateDirectory: string,
  userId: string,
  ledger: ProviderSkillLedger,
): Promise<void> {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const targetPath = ledgerPath(stateDirectory, userId);
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
}

function ledgerPath(stateDirectory: string, userId: string): string {
  const key = createHash('sha256').update(userId).digest('hex');
  return path.join(stateDirectory, `${key}.json`);
}
