import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  CliProvider,
  ProviderIntegrationRequirements,
  ProviderLaunchPreparation,
  ProviderSessionRuntimeGuard,
} from './providers/provider-contract';
import { getAgentEnvironmentStrict, resolveDefaultAgentEnvironment } from './spawn-cli';
import type {
  ProviderLifecycleIntegration,
  ProviderLifecycleResult,
} from './providers/provider-contract';
import { cliProviderRegistry } from './providers/registry';
import {
  createProviderSkillManager,
  detectSupportedProviderSkills,
  resolveOwnedProviderSkillHome,
  type ProviderSkillManagementRequest,
  type ProviderSkillManagementResult,
  type ProviderSkillManagerOptions,
  type ProviderSkillStatus,
} from './provider-skill-management';
import {
  assertProviderHomeAuthority,
  ProviderSessionResumeUnavailableError,
} from './provider-session-resume';
import type { ProviderHomeIdentity } from './providers/provider-home-identity';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import { isProviderSkillId, type ProviderSkillId } from './provider-skill-id';

export {
  ProviderSessionResumeUnavailableError,
  isProviderSessionResumeUnavailableError,
} from './provider-session-resume';

export type {
  ProviderSkillId,
  ProviderSkillManagementRequest,
  ProviderSkillManagementResult,
} from './provider-skill-management';

export type ProviderIntegrationArtifactState =
  | 'unchecked'
  | 'ready'
  | 'stale'
  | 'absent'
  | 'installed'
  | 'conflict'
  | 'unavailable'
  | 'not-applicable';

export type ProviderIntegrationConsentState =
  | 'unchecked'
  | 'not-required'
  | 'required'
  | 'granted'
  | 'revoked'
  | 'declined';

export type ProviderIntegrationTrustState =
  | 'unchecked'
  | 'not-required'
  | 'trusted'
  | 'untrusted'
  | 'unavailable';

export interface ProviderIntegrationArtifactPolicy {
  requirement: 'required' | 'optional' | 'not-applicable';
  state: ProviderIntegrationArtifactState;
  consent: ProviderIntegrationConsentState;
  trust: ProviderIntegrationTrustState;
  installedVersion?: string;
  currentVersion?: string;
  message?: string;
}

export interface ProviderIntegrationHealth {
  state: 'unchecked' | 'healthy' | 'degraded' | 'blocked';
}

export interface ManagedSessionIntegrationHealthChange {
  userId: string;
  sessionId: string;
  integrationHealth: 'healthy' | 'degraded' | undefined;
}

export interface ProviderIntegrationLaunchDecision {
  providerHome: {
    owner: 'agent-environment';
    agentEnvironment: AgentEnvironment;
    identity?: ProviderHomeIdentity;
  };
  lifecycle: ProviderIntegrationArtifactPolicy;
  skill: ProviderIntegrationArtifactPolicy;
  health: ProviderIntegrationHealth;
  guidance?: {
    minimumVersion: string;
    updateCommand: string;
    message: string;
  };
  compatibility?: 'exact-legacy-overlay-resume';
}

export interface ProviderSkillIntegrationPolicy {
  onboarding: 'offer' | 'none';
  canInstall: boolean;
  canUpdate: boolean;
  canRemove: boolean;
}

export interface ProviderSkillIntegrationStatus extends ProviderSkillStatus {
  policy: ProviderSkillIntegrationPolicy;
}

export interface ProviderSkillIntegrationResult
  extends Omit<ProviderSkillManagementResult, 'providers'> {
  providers: ProviderSkillIntegrationStatus[];
}

export interface ProviderIntegrationLaunchRequest {
  provider: Pick<
    CliProvider,
    | 'getProviderId'
    | 'getProviderIntegrationRequirements'
    | 'getLifecycleIntegration'
    | 'prepareLaunchIntegration'
  >;
  agentEnvironmentOwner:
    | { kind: 'user'; userId: string }
    | { kind: 'server-default' };
  workDir?: string | null;
  /** Managed Session that will own this runtime after a successful provider spawn. */
  managedSessionId?: string;
  compatibility?: 'exact-legacy-overlay-resume';
  requiredProviderHomeIdentity?: ProviderHomeIdentity;
  resumeProviderSessionId?: string;
}

export interface ProviderIntegrationLifecycleRequest extends ProviderIntegrationLaunchRequest {
  workDir?: string | null;
}

export interface ProviderIntegrationLifecycleInstallRequest
  extends ProviderIntegrationLifecycleRequest {
  consent: 'granted' | 'declined';
}

export interface ProviderHomeResolutionRequest {
  provider: Pick<
    CliProvider,
    'getProviderId' | 'getProviderIntegrationRequirements' | 'prepareLaunchIntegration'
  >;
  agentEnvironment: AgentEnvironment;
  userId?: string;
  workDir?: string | null;
}

export interface ProviderIntegrationCleanupArtifact {
  artifact: 'lifecycle-hook' | 'provider-skill';
  providerId: string;
  agentEnvironment: AgentEnvironment;
  /** Cleanup-only location for actionable recovery; ordinary integration DTOs stay path-free. */
  providerHome?: string;
  state: 'removed' | 'absent' | 'conflict' | 'failed';
  message?: string;
  recovery?: string;
}

export interface ProviderIntegrationCleanupProblem {
  artifact: 'lifecycle-hook' | 'provider-skill';
  message: string;
  recovery: string;
}

export interface ProviderIntegrationCleanupResult {
  complete: boolean;
  artifacts: ProviderIntegrationCleanupArtifact[];
  problems: ProviderIntegrationCleanupProblem[];
}

interface ProviderLifecycleCleanupTarget {
  providerId: string;
  integration?: ProviderLifecycleIntegration;
  discoveryError?: string;
}

export interface ProviderIntegration {
  resolveProviderHome(
    request: ProviderHomeResolutionRequest,
  ): Promise<ProviderIntegrationLaunchDecision['providerHome']>;
  resolveLaunch(
    request: ProviderIntegrationLaunchRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  buildLaunchEnvironment(
    decision: ProviderIntegrationLaunchDecision,
    baseEnvironment: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv | undefined;
  /** Opaque provider guard retained only for the lifetime of this launch decision. */
  getResumeRuntimeGuard?(
    decision: ProviderIntegrationLaunchDecision,
  ): ProviderSessionRuntimeGuard | undefined;
  /** Read history from the provider home captured by this launch decision. */
  readResumeHistory?(
    decision: ProviderIntegrationLaunchDecision,
    providerSessionId: string,
  ): Promise<SessionHistoryEvent[] | null | undefined>;
  inspectLifecycle(
    request: ProviderIntegrationLifecycleRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  installLifecycle(
    request: ProviderIntegrationLifecycleInstallRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  updateLifecycle(
    request: ProviderIntegrationLifecycleRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  /**
   * Removes the artifact from the currently resolved Authoritative Provider Home.
   * Application-uninstall cleanup across every known home is a separate workflow.
   */
  removeLifecycle(
    request: ProviderIntegrationLifecycleRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  getManagedSessionHealth(sessionId: string): 'healthy' | 'degraded' | undefined;
  refreshManagedSessionHealth(sessionId: string): Promise<'healthy' | 'degraded' | undefined>;
  releaseManagedSession(sessionId: string): void;
  subscribeManagedSessionHealth(
    listener: (change: ManagedSessionIntegrationHealthChange) => void,
  ): () => void;
  manageSkills(request: ProviderSkillManagementRequest): Promise<ProviderSkillIntegrationResult>;
  /** Cross-lifecycle cleanup used only by the Tessera application-removal workflow. */
  cleanupOwnedArtifacts(): Promise<ProviderIntegrationCleanupResult>;
}

interface ProviderIntegrationOptions extends Partial<Omit<
  ProviderSkillManagerOptions,
  'resolveAgentEnvironment' | 'resolveDefaultEnvironment'
>> {
  resolveAgentEnvironment?: (userId: string) => Promise<AgentEnvironment>;
  resolveDefaultEnvironment?: () => Promise<AgentEnvironment>;
  lifecycle?: ProviderLifecycleIntegration;
  resolveLifecycleCleanupTargets?: () => ProviderLifecycleCleanupTarget[];
  healthRefreshIntervalMs?: number;
}

export class ProviderIntegrationEnvironmentError extends Error {
  constructor(readonly cause: unknown) {
    super('The current Agent Environment could not be resolved.');
    this.name = 'ProviderIntegrationEnvironmentError';
  }
}

export class ProviderIntegrationLaunchBlockedError extends Error {
  constructor(readonly decision: ProviderIntegrationLaunchDecision, message: string) {
    super(message);
    this.name = 'ProviderIntegrationLaunchBlockedError';
  }
}

function resolveProviderSkillPolicy(status: ProviderSkillStatus): ProviderSkillIntegrationPolicy {
  const hasConsent = status.consent === 'granted';
  const canInstall = status.detected
    && status.state === 'absent'
    && status.ownership === 'none'
    && !hasConsent;
  const blocked = status.state === 'conflict' || status.state === 'unavailable';
  return {
    onboarding: canInstall && status.consent === 'not-granted' ? 'offer' : 'none',
    canInstall,
    canUpdate: hasConsent && !blocked,
    canRemove: hasConsent && (status.state === 'ready' || status.state === 'stale'),
  };
}

function exposeProviderSkillPolicy(
  result: ProviderSkillManagementResult,
): ProviderSkillIntegrationResult {
  return {
    ...result,
    providers: result.providers.map((status) => ({
      ...status,
      policy: resolveProviderSkillPolicy(status),
    })),
  };
}

function resolveArtifactPolicy(
  requirement: ProviderIntegrationArtifactPolicy['requirement'],
): ProviderIntegrationArtifactPolicy {
  return requirement === 'not-applicable'
    ? {
        requirement,
        state: 'not-applicable',
        consent: 'not-required',
        trust: 'not-required',
      }
    : {
        requirement,
        state: 'unchecked',
        consent: 'unchecked',
        trust: 'unchecked',
      };
}

function launchBlockedMessage(
  providerId: string,
  decision: ProviderIntegrationLaunchDecision,
): string {
  const displayName = providerId === 'codex' ? 'Codex' : providerId;
  const lifecycle = decision.lifecycle;
  if (lifecycle.state === 'absent') {
    return `${displayName} launch is blocked because the required Tessera lifecycle hook is not installed in the Authoritative Provider Home. Run \`tessera provider ${providerId} lifecycle install --consent\` and retry.`;
  }
  if (lifecycle.state === 'installed' && lifecycle.trust !== 'trusted') {
    return `${displayName} launch is blocked because the required Tessera lifecycle hook is not trusted. Run \`tessera provider ${providerId} lifecycle install --consent\` and retry.${lifecycle.message ? ` ${lifecycle.message}` : ''}`;
  }
  return `${displayName} launch is blocked because the required Tessera lifecycle hook is unavailable or unhealthy. Run \`tessera provider ${providerId} lifecycle status\` and follow its guidance before retrying.${lifecycle.message ? ` ${lifecycle.message}` : ''}`;
}

/**
 * Shared policy boundary for provider launches.
 *
 * Callers receive domain decisions only. Provider homes, launch environment
 * values, and skill ownership remain behind provider-owned/shared integration
 * seams so this contract stays path-free.
 */
export function createProviderIntegration(
  options: ProviderIntegrationOptions = {},
): ProviderIntegration {
  const launchPreparations = new WeakMap<
    ProviderIntegrationLaunchDecision,
    ProviderLaunchPreparation
  >();
  const resumeRuntimeGuards = new WeakMap<
    ProviderIntegrationLaunchDecision,
    ProviderSessionRuntimeGuard
  >();
  const resolveAgentEnvironment = options.resolveAgentEnvironment ?? getAgentEnvironmentStrict;
  const resolveDefaultEnvironment = options.resolveDefaultEnvironment
    ?? (async () => resolveDefaultAgentEnvironment());
  const skillManager = createProviderSkillManager({
    resolveAgentEnvironment,
    resolveDefaultEnvironment,
    detectSkillProviders: options.detectSkillProviders ?? detectSupportedProviderSkills,
    resolveProviderSkillHome: options.resolveProviderSkillHome ?? resolveOwnedProviderSkillHome,
    ...(options.providerSkillStateDirectory
      ? { providerSkillStateDirectory: options.providerSkillStateDirectory }
      : {}),
    ...(options.readProviderSkillFiles
      ? { readProviderSkillFiles: options.readProviderSkillFiles }
      : {}),
    ...(options.renameProviderSkillPath
      ? { renameProviderSkillPath: options.renameProviderSkillPath }
      : {}),
  });
  const resolveLifecycleCleanupTargets: () => ProviderLifecycleCleanupTarget[] = (
    options.resolveLifecycleCleanupTargets ?? (() => (
      cliProviderRegistry.getProviderIds().flatMap((providerId): ProviderLifecycleCleanupTarget[] => {
        try {
          const provider = cliProviderRegistry.getProvider(providerId);
          if (provider.getProviderIntegrationRequirements().lifecycle === 'not-applicable') return [];
          const integration = provider.getLifecycleIntegration?.();
          return [{
            providerId,
            ...(integration
              ? { integration }
              : { discoveryError: `${providerId} lifecycle cleanup is unavailable.` }),
          }];
        } catch (error) {
          return [{
            providerId,
            discoveryError: error instanceof Error ? error.message : String(error),
          }];
        }
      })
    ))
  );
  type ActiveHealth = 'healthy' | 'degraded';
  interface ManagedSessionScope {
    health: ActiveHealth;
    refresh: () => Promise<ProviderIntegrationLaunchDecision>;
    sessionIds: Set<string>;
    userId: string;
    timer?: NodeJS.Timeout;
  }
  const managedSessionScopes = new Map<string, ManagedSessionScope>();
  const managedSessionScopeKeys = new Map<string, string>();
  const managedSessionHealthListeners = new Set<(
    change: ManagedSessionIntegrationHealthChange,
  ) => void>();
  const healthRefreshIntervalMs = options.healthRefreshIntervalMs ?? 30_000;

  const resolveEnvironment = async (
    request: ProviderIntegrationLaunchRequest,
  ): Promise<AgentEnvironment> => {
    try {
      return request.agentEnvironmentOwner.kind === 'user'
        ? await resolveAgentEnvironment(request.agentEnvironmentOwner.userId)
        : await resolveDefaultEnvironment();
    } catch (error) {
      throw new ProviderIntegrationEnvironmentError(error);
    }
  };

  const notApplicableDecision = (
    agentEnvironment: AgentEnvironment,
    requirements: ProviderIntegrationRequirements,
  ): ProviderIntegrationLaunchDecision => ({
    providerHome: { owner: 'agent-environment', agentEnvironment },
    lifecycle: resolveArtifactPolicy(requirements.lifecycle),
    skill: resolveArtifactPolicy(requirements.skill),
    health: { state: 'healthy' },
  });

  const lifecycleDecision = (
    agentEnvironment: AgentEnvironment,
    requirements: ProviderIntegrationRequirements,
    result: ProviderLifecycleResult,
    fallbackConsent: ProviderIntegrationConsentState,
  ): ProviderIntegrationLaunchDecision => ({
    providerHome: { owner: 'agent-environment', agentEnvironment },
    lifecycle: {
      requirement: requirements.lifecycle,
      state: result.state,
      consent: fallbackConsent === 'granted' || fallbackConsent === 'declined'
        ? fallbackConsent
        : result.consent === 'not-granted'
          ? 'required'
          : result.consent ?? fallbackConsent,
      trust: result.trust,
      ...(result.installedVersion ? { installedVersion: result.installedVersion } : {}),
      ...(result.currentVersion ? { currentVersion: result.currentVersion } : {}),
      ...(result.message ? { message: result.message } : {}),
    },
    skill: resolveArtifactPolicy(requirements.skill),
    health: {
      state: result.state === 'installed'
        && result.trust === 'trusted'
        && result.consent !== 'revoked'
        && result.consent !== 'not-granted'
        ? 'healthy'
        : 'blocked',
    },
    ...(result.guidance ? { guidance: result.guidance } : {}),
  });

  const activeHealth = (decision: ProviderIntegrationLaunchDecision): ActiveHealth => (
    decision.lifecycle.state === 'installed'
      && decision.lifecycle.trust === 'trusted'
      && decision.lifecycle.consent === 'granted'
      ? 'healthy'
      : 'degraded'
  );

  const notifyManagedSessionHealth = (
    userId: string,
    sessionId: string,
    integrationHealth: ActiveHealth | undefined,
  ): void => {
    for (const listener of managedSessionHealthListeners) {
      try {
        listener({ userId, sessionId, integrationHealth });
      } catch {
        // Projection listeners must never affect provider lifecycle policy.
      }
    }
  };

  const setManagedScopeHealth = (
    scope: ManagedSessionScope,
    integrationHealth: ActiveHealth,
  ): void => {
    if (scope.health === integrationHealth) return;
    scope.health = integrationHealth;
    for (const sessionId of scope.sessionIds) {
      notifyManagedSessionHealth(scope.userId, sessionId, integrationHealth);
    }
  };

  const lifecycleScopeKey = (
    request: ProviderIntegrationLifecycleRequest,
    agentEnvironment: AgentEnvironment,
    scopeId: string | undefined,
  ): string | undefined => request.agentEnvironmentOwner.kind === 'user' && scopeId
    ? JSON.stringify([
        request.agentEnvironmentOwner.userId,
        agentEnvironment,
        request.provider.getProviderId(),
        scopeId,
      ])
    : undefined;

  const updateManagedScopeHealth = (
    request: ProviderIntegrationLifecycleRequest,
    decision: ProviderIntegrationLaunchDecision,
    scopeId: string | undefined,
  ): void => {
    const key = lifecycleScopeKey(
      request,
      decision.providerHome.agentEnvironment,
      scopeId,
    );
    const scope = key ? managedSessionScopes.get(key) : undefined;
    if (scope) setManagedScopeHealth(scope, activeHealth(decision));
  };

  const releaseManagedSession = (sessionId: string): void => {
    const key = managedSessionScopeKeys.get(sessionId);
    if (!key) return;
    managedSessionScopeKeys.delete(sessionId);
    const scope = managedSessionScopes.get(key);
    if (!scope) return;
    scope.sessionIds.delete(sessionId);
    notifyManagedSessionHealth(scope.userId, sessionId, undefined);
    if (scope.sessionIds.size > 0) return;
    if (scope.timer) clearInterval(scope.timer);
    managedSessionScopes.delete(key);
  };

  const registerManagedSession = (
    request: ProviderIntegrationLaunchRequest,
    decision: ProviderIntegrationLaunchDecision,
    scopeId: string | undefined,
    refresh: () => Promise<ProviderIntegrationLaunchDecision>,
  ): void => {
    if (!request.managedSessionId || request.compatibility || !scopeId) return;
    if (request.agentEnvironmentOwner.kind !== 'user') return;
    const key = lifecycleScopeKey(request, decision.providerHome.agentEnvironment, scopeId);
    if (!key) return;
    releaseManagedSession(request.managedSessionId);
    let scope = managedSessionScopes.get(key);
    if (!scope) {
      scope = {
        health: activeHealth(decision),
        refresh,
        sessionIds: new Set(),
        userId: request.agentEnvironmentOwner.userId,
      };
      if (healthRefreshIntervalMs > 0) {
        scope.timer = setInterval(() => {
          void scope?.refresh().catch(() => {
            if (scope) setManagedScopeHealth(scope, 'degraded');
          });
        }, healthRefreshIntervalMs);
        scope.timer.unref();
      }
      managedSessionScopes.set(key, scope);
    }
    setManagedScopeHealth(scope, activeHealth(decision));
    scope.refresh = refresh;
    scope.sessionIds.add(request.managedSessionId);
    managedSessionScopeKeys.set(request.managedSessionId, key);
    notifyManagedSessionHealth(scope.userId, request.managedSessionId, scope.health);
  };

  const resolveLifecycleOperation = async (request: ProviderIntegrationLifecycleRequest) => {
    const agentEnvironment = await resolveEnvironment(request);
    const requirements = request.provider.getProviderIntegrationRequirements();
    const lifecycle = options.lifecycle ?? request.provider.getLifecycleIntegration?.();
    return {
      agentEnvironment,
      requirements,
      lifecycle,
      context: {
        environment: agentEnvironment,
        userId: request.agentEnvironmentOwner.kind === 'user'
          ? request.agentEnvironmentOwner.userId
          : undefined,
        workDir: request.workDir,
      },
    };
  };

  return {
    manageSkills: async (request) => exposeProviderSkillPolicy(await skillManager.manage(request)),
    async resolveProviderHome(request) {
      const preparation = await request.provider.prepareLaunchIntegration?.({
        environment: request.agentEnvironment,
        userId: request.userId,
        workDir: request.workDir,
      });
      if (!preparation?.providerHomeIdentity) {
        throw new Error(`${request.provider.getProviderId()} did not provide an Authoritative Provider Home identity.`);
      }
      return {
        owner: 'agent-environment',
        agentEnvironment: request.agentEnvironment,
        identity: preparation.providerHomeIdentity,
      };
    },
    async cleanupOwnedArtifacts() {
      let lifecycleTargets: ReturnType<typeof resolveLifecycleCleanupTargets> = [];
      const lifecycleTargetProblems: ProviderIntegrationCleanupProblem[] = [];
      try {
        lifecycleTargets = resolveLifecycleCleanupTargets();
      } catch (error) {
        lifecycleTargetProblems.push({
          artifact: 'lifecycle-hook',
          message: error instanceof Error ? error.message : String(error),
          recovery: 'Restore provider registration and retry Tessera removal.',
        });
      }
      const [lifecycleAttempts, skillAttempt] = await Promise.all([
        Promise.all(lifecycleTargets.map(async ({ providerId, integration, discoveryError }) => {
          if (discoveryError || !integration?.cleanupKnownArtifacts) {
            return {
              providerId,
              result: {
                artifacts: [],
                discoveryErrors: [discoveryError ?? `${providerId} lifecycle cleanup is unavailable.`],
              },
            };
          }
          try {
            return { providerId, result: await integration.cleanupKnownArtifacts() };
          } catch (error) {
            return {
              providerId,
              result: {
                artifacts: [],
                discoveryErrors: [error instanceof Error ? error.message : String(error)],
              },
            };
          }
        })),
        skillManager.cleanupKnownArtifacts().then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
      ]);
      const skillCleanup = skillAttempt.status === 'fulfilled'
        ? skillAttempt.value
        : {
            artifacts: [],
            discoveryProblems: [{
              code: 'KNOWN_STATE_UNREADABLE' as const,
              message: skillAttempt.reason instanceof Error
                ? skillAttempt.reason.message
                : String(skillAttempt.reason),
            }],
          };
      const artifacts: ProviderIntegrationCleanupArtifact[] = [
        ...lifecycleAttempts.flatMap(({ providerId, result }) => (
          result.artifacts.map((artifact) => ({
            artifact: 'lifecycle-hook' as const,
            providerId,
            agentEnvironment: artifact.environment,
            providerHome: artifact.providerHome,
            state: artifact.state,
            ...(artifact.message ? { message: artifact.message } : {}),
            ...(artifact.state === 'conflict' || artifact.state === 'failed'
              ? {
                  recovery: `Review the ${providerId} lifecycle hook in ${artifact.providerHome}, `
                    + 'preserve user changes, resolve the reported problem, and retry Tessera removal.',
                }
              : {}),
          }))
        )),
        ...skillCleanup.artifacts.map((artifact) => ({
          artifact: 'provider-skill' as const,
          providerId: artifact.providerId,
          agentEnvironment: artifact.agentEnvironment,
          ...(artifact.providerHome ? { providerHome: artifact.providerHome } : {}),
          state: artifact.state,
          ...(artifact.message ? { message: artifact.message } : {}),
          ...(artifact.state === 'conflict' || artifact.state === 'failed'
            ? {
                recovery: `Review the ${artifact.providerId} tessera-cli skill${artifact.providerHome
                  ? ` in ${artifact.providerHome}`
                  : ' in this Agent Environment'}, `
                  + 'preserve user changes, resolve the reported problem, and retry Tessera removal.',
              }
            : {}),
        })),
      ];
      const problems: ProviderIntegrationCleanupProblem[] = [
        ...lifecycleTargetProblems,
        ...lifecycleAttempts.flatMap(({ providerId, result }) => (
          result.discoveryErrors.map((message) => ({
            artifact: 'lifecycle-hook' as const,
            message,
            recovery: `Restore readable Tessera ${providerId} lifecycle state and retry Tessera removal.`,
          }))
        )),
        ...skillCleanup.discoveryProblems.map(({ code, message }) => ({
          artifact: 'provider-skill' as const,
          message,
          recovery: code === 'LEGACY_HOMES_UNKNOWN'
            ? 'Inspect every provider home previously selected in that Agent Environment, preserve '
              + 'user-owned content, remove only a confirmed Tessera-owned skill, and retry Tessera removal.'
            : 'Restore readable Tessera provider-skill state and retry Tessera removal.',
        })),
      ];
      return {
        complete: problems.length === 0
          && artifacts.every(({ state }) => state === 'removed' || state === 'absent'),
        artifacts,
        problems,
      };
    },
    async resolveLaunch(request) {
      const agentEnvironment = await resolveEnvironment(request);
      const requirements = request.provider.getProviderIntegrationRequirements();
      const lifecycle = resolveArtifactPolicy(requirements.lifecycle);
      let skill = resolveArtifactPolicy(requirements.skill);
      let health: ProviderIntegrationHealth = { state: 'unchecked' };
      if (requirements.skill !== 'not-applicable') {
        try {
          const maintained = await skillManager.maintain(
            request.agentEnvironmentOwner,
            normalizeProviderSkillId(request.provider.getProviderId()),
            agentEnvironment,
          );
          skill = {
            requirement: requirements.skill,
            state: maintained.status.state === 'unavailable'
              ? 'conflict'
              : maintained.status.state,
            consent: maintained.status.consent === 'not-granted'
              ? 'declined'
              : maintained.status.consent,
            trust: 'not-required',
          };
          health = maintained.status.state === 'ready'
            ? { state: 'healthy' }
            : maintained.status.state === 'conflict' || maintained.status.state === 'unavailable'
              ? { state: 'degraded' }
              : { state: 'unchecked' };
        } catch {
          // Provider skills are optional. Environment, ownership, and filesystem
          // failures are surfaced by management commands but never block launch.
          skill = {
            requirement: requirements.skill,
            state: 'conflict',
            consent: 'unchecked',
            trust: 'not-required',
          };
          health = { state: 'degraded' };
        }
      }
      if (
        lifecycle.requirement === 'required'
        && lifecycle.state === 'unchecked'
        && health.state === 'healthy'
      ) {
        health = { state: 'unchecked' };
      }
      let decision: ProviderIntegrationLaunchDecision = {
        providerHome: {
          owner: 'agent-environment',
          agentEnvironment,
        },
        lifecycle,
        skill,
        health,
      };

      if (
        request.provider.getProviderId() === 'codex'
        && request.compatibility === 'exact-legacy-overlay-resume'
      ) {
        return {
          ...decision,
          compatibility: request.compatibility,
        };
      }
      let launchPreparation: ProviderLaunchPreparation | undefined;
      let activeLifecycle: ProviderLifecycleIntegration | undefined;
      let activeLifecycleContext: Parameters<ProviderLifecycleIntegration['inspect']>[0] | undefined;
      let activeLifecycleScopeId: string | undefined;
      if (requirements.launchEnvironment === 'required') {
        if (!request.provider.prepareLaunchIntegration) {
          decision.health = { state: 'blocked' };
          throw new ProviderIntegrationLaunchBlockedError(
            decision,
            `${request.provider.getProviderId()} launch is blocked because the provider cannot prepare its Authoritative Provider Home environment. Reinstall or update Tessera, then retry.`,
          );
        }
        try {
          launchPreparation = await request.provider.prepareLaunchIntegration({
            environment: agentEnvironment,
            userId: request.agentEnvironmentOwner.kind === 'user'
              ? request.agentEnvironmentOwner.userId
              : undefined,
            workDir: request.workDir,
          });
        } catch (error) {
          decision.health = { state: 'blocked' };
          throw new ProviderIntegrationLaunchBlockedError(
            decision,
            `${request.provider.getProviderId()} launch is blocked because the Authoritative Provider Home could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (launchPreparation?.providerHomeIdentity) {
        decision = {
          ...decision,
          providerHome: {
            ...decision.providerHome,
            identity: launchPreparation.providerHomeIdentity,
          },
        };
      }
      assertProviderHomeAuthority(
        request.requiredProviderHomeIdentity,
        launchPreparation?.providerHomeIdentity,
      );
      if (requirements.lifecycle === 'required') {
        const lifecycleIntegration = options.lifecycle
          ?? launchPreparation?.lifecycle
          ?? request.provider.getLifecycleIntegration?.();
        const lifecycleContext = {
          environment: agentEnvironment,
          userId: request.agentEnvironmentOwner.kind === 'user'
            ? request.agentEnvironmentOwner.userId
            : undefined,
          workDir: request.workDir,
        };
        let result: ProviderLifecycleResult;
        try {
          result = lifecycleIntegration
            ? await (lifecycleIntegration.maintain ?? lifecycleIntegration.inspect)(lifecycleContext)
            : {
                state: 'unavailable',
                trust: 'unavailable',
                message: 'The provider does not expose required lifecycle management.',
              };
        } catch (error) {
          result = {
            state: 'unavailable',
            trust: 'unavailable',
            message: `Lifecycle status could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const checkedLifecycle = lifecycleDecision(
          agentEnvironment,
          requirements,
          result,
          result.state === 'installed' ? 'granted' : 'required',
        );
        decision = {
          ...decision,
          lifecycle: checkedLifecycle.lifecycle,
          ...(checkedLifecycle.guidance ? { guidance: checkedLifecycle.guidance } : {}),
          health: checkedLifecycle.health.state === 'healthy'
            ? health.state === 'degraded' ? health : checkedLifecycle.health
            : checkedLifecycle.health,
        };
        if (checkedLifecycle.health.state !== 'healthy') {
          throw new ProviderIntegrationLaunchBlockedError(
            decision,
            launchBlockedMessage(request.provider.getProviderId(), decision),
          );
        }
        activeLifecycle = lifecycleIntegration;
        activeLifecycleContext = result.scopeId
          ? { ...lifecycleContext, scopeId: result.scopeId }
          : lifecycleContext;
        activeLifecycleScopeId = result.scopeId;
      }

      if (request.resumeProviderSessionId) {
        const inspection = launchPreparation?.inspectResume
          ? await launchPreparation.inspectResume(request.resumeProviderSessionId)
          : {
              state: 'unavailable' as const,
              reason: 'provider-history-missing' as const,
              message: 'The provider cannot inspect this conversation in its authoritative home.',
            };
        if (inspection.state === 'unavailable') {
          throw new ProviderSessionResumeUnavailableError(
            inspection.reason,
            inspection.message,
          );
        }
        if (inspection.runtimeGuard) {
          resumeRuntimeGuards.set(decision, inspection.runtimeGuard);
        }
      }

      if (launchPreparation) launchPreparations.set(decision, launchPreparation);
      if (activeLifecycle && activeLifecycleContext) {
        const refresh = async (): Promise<ProviderIntegrationLaunchDecision> => {
          let result: ProviderLifecycleResult;
          try {
            result = await activeLifecycle.inspect(activeLifecycleContext);
          } catch (error) {
            result = {
              state: 'unavailable',
              trust: 'unavailable',
              scopeId: activeLifecycleScopeId,
              message: `Lifecycle status could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          const refreshed = lifecycleDecision(
            agentEnvironment,
            requirements,
            result,
            result.state === 'installed' ? 'granted' : 'required',
          );
          updateManagedScopeHealth(request, refreshed, result.scopeId ?? activeLifecycleScopeId);
          return refreshed;
        };
        registerManagedSession(request, decision, activeLifecycleScopeId, refresh);
      }

      return decision;
    },
    buildLaunchEnvironment(decision, baseEnvironment) {
      return launchPreparations.get(decision)?.buildEnvironment(baseEnvironment);
    },
    getResumeRuntimeGuard(decision) {
      return resumeRuntimeGuards.get(decision);
    },
    async readResumeHistory(decision, providerSessionId) {
      return await launchPreparations.get(decision)?.readResumeHistory?.(providerSessionId);
    },
    async inspectLifecycle(request) {
      const { agentEnvironment, requirements, lifecycle, context } =
        await resolveLifecycleOperation(request);
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      const result = lifecycle
        ? await lifecycle.inspect(context)
        : {
            state: 'unavailable' as const,
            trust: 'unavailable' as const,
            message: 'The provider does not expose required lifecycle management.',
          };
      const decision = lifecycleDecision(
        agentEnvironment,
        requirements,
        result,
        result.state === 'installed' ? 'granted' : 'required',
      );
      updateManagedScopeHealth(request, decision, result.scopeId);
      return decision;
    },
    async installLifecycle(request) {
      const { agentEnvironment, requirements, lifecycle, context } =
        await resolveLifecycleOperation(request);
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      if (!lifecycle) {
        return lifecycleDecision(agentEnvironment, requirements, {
          state: 'unavailable',
          trust: 'unavailable',
          message: 'The provider does not expose required lifecycle management.',
        }, request.consent);
      }
      if (request.consent === 'declined') {
        const result = await lifecycle.inspect(context);
        const decision = lifecycleDecision(agentEnvironment, requirements, result, 'declined');
        updateManagedScopeHealth(request, decision, result.scopeId);
        return decision;
      }
      const result = await lifecycle.install(context);
      const decision = lifecycleDecision(agentEnvironment, requirements, result, 'granted');
      updateManagedScopeHealth(request, decision, result.scopeId);
      return decision;
    },
    async updateLifecycle(request) {
      const { agentEnvironment, requirements, lifecycle, context } =
        await resolveLifecycleOperation(request);
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      const result = lifecycle?.update
        ? await lifecycle.update(context)
        : {
            state: 'unavailable' as const,
            trust: 'unavailable' as const,
            message: 'The provider does not expose lifecycle updates.',
          };
      const decision = lifecycleDecision(agentEnvironment, requirements, result, 'required');
      updateManagedScopeHealth(request, decision, result.scopeId);
      return decision;
    },
    async removeLifecycle(request) {
      const { agentEnvironment, requirements, lifecycle, context } =
        await resolveLifecycleOperation(request);
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      const result = lifecycle?.remove
        ? await lifecycle.remove(context)
        : {
            state: 'unavailable' as const,
            trust: 'unavailable' as const,
            message: 'The provider does not expose lifecycle removal.',
          };
      const decision = lifecycleDecision(agentEnvironment, requirements, result, 'revoked');
      updateManagedScopeHealth(request, decision, result.scopeId);
      return decision;
    },
    getManagedSessionHealth(sessionId) {
      const key = managedSessionScopeKeys.get(sessionId);
      return key ? managedSessionScopes.get(key)?.health : undefined;
    },
    async refreshManagedSessionHealth(sessionId) {
      const key = managedSessionScopeKeys.get(sessionId);
      const scope = key ? managedSessionScopes.get(key) : undefined;
      if (!scope) return undefined;
      try {
        await scope.refresh();
      } catch {
        setManagedScopeHealth(scope, 'degraded');
      }
      return scope.health;
    },
    releaseManagedSession,
    subscribeManagedSessionHealth(listener) {
      managedSessionHealthListeners.add(listener);
      return () => managedSessionHealthListeners.delete(listener);
    },
  };
}

function normalizeProviderSkillId(providerId: string): ProviderSkillId {
  if (isProviderSkillId(providerId)) return providerId;
  throw new Error(`Provider ${providerId} does not support the tessera-cli skill.`);
}

export const providerIntegration = createProviderIntegration();
