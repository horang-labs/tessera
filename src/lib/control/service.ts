import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import type {
  ProviderIntegration,
  ProviderSkillId,
  ProviderSkillManagementResult,
} from '@/lib/cli/provider-integration';
import {
  validateProjectEnvironment,
  type ProjectFilesystemKind,
} from '@/lib/projects/environment-policy';
import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  TerminalLaunchRuntimeState,
  TerminalSessionSnapshot,
  TerminalSessionWaitCondition,
} from '@/lib/terminal/terminal-manager';
import {
  isTerminalNamedKey,
  type TerminalNamedKey,
} from '@/lib/terminal/session-control-input';
import type {
  PreparationPhase,
  PreparationStatus,
} from '@/lib/projects/preparation-status-policy';
import type { WorktreeCreationSource } from '@/lib/worktrees/create';
import { CONTROL_API_VERSION } from './runtime-descriptor';
import type {
  ControlAuthorityContext,
  ControlAuthoritySource,
} from './authority';
import {
  auditControlMutation,
  type ControlAuditHistory,
  type ControlAuditOperation,
  type ControlAuditTarget,
  type PublicControlAuditRecord,
} from './audit';
import type { ProviderIntegrationLaunchDecision } from '@/lib/cli/provider-integration';
import type { ControlProviderIntegrationManager } from './provider-integration-manager';

export type ControlErrorCode =
  | 'BRANCH_REQUIRED'
  | 'BRANCH_ALREADY_EXISTS'
  | 'BRANCH_ALREADY_CHECKED_OUT'
  | 'BRANCH_NOT_FOUND'
  | 'CONTROL_AUTHORITY_DENIED'
  | 'CONTROL_VERSION_MISMATCH'
  | 'INSTANCE_UNAVAILABLE'
  | 'INVALID_USAGE'
  | 'INVALID_START_POINT'
  | 'PROJECT_ENVIRONMENT_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'START_POINT_REQUIRED'
  | 'PREPARATION_FAILED'
  | 'PREPARATION_TIMEOUT'
  | 'PROVIDER_NOT_SUPPORTED'
  | 'PROVIDER_SKILL_CONFLICT'
  | 'PROVIDER_SKILL_CONSENT_REQUIRED'
  | 'PROVIDER_SKILL_GLOBAL_AUTHORITY_REQUIRED'
  | 'PROVIDER_SKILL_NO_PROVIDERS'
  | 'PROVIDER_SKILL_TRANSACTION_FAILED'
  | 'INITIAL_PROMPT_TOO_LARGE'
  | 'INPUT_NOT_ACCEPTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_FRESH'
  | 'SESSION_RUNTIME_ALREADY_RUNNING'
  | 'SESSION_RUNTIME_NOT_RUNNING'
  | 'WAIT_TIMEOUT'
  | 'WORKTREE_CREATE_FAILED'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_PERSIST_FAILED'
  | 'UNAUTHORIZED';

export interface ControlCallerContext {
  authorityToken?: string;
  agentEnvironment: AgentEnvironment;
  projectId?: string;
  sessionId?: string;
  worktreeId?: string;
}

export interface ControlProjectRecord {
  id: string;
  decodedPath: string;
  displayName: string;
  visible: boolean;
}

export interface PublicProjectDto {
  id: string;
  displayName: string;
  path: string;
  visible: boolean;
  agentEnvironmentCompatibility: {
    agentEnvironment: AgentEnvironment;
    filesystemKind: ProjectFilesystemKind;
    compatible: boolean;
  };
}

export interface ControlProjectSource {
  list(): ControlProjectRecord[];
  get(projectId: string): ControlProjectRecord | undefined;
}

export interface ControlWorktreeSessionRecord {
  sessionId: string;
  title: string;
  provider: string;
  updatedAt: string;
}

export interface ControlWorktreeRecord {
  worktreeId: string;
  projectId: string;
  title: string;
  branch: string | null;
  filesystemPath: string | null;
  preparationStatus: PreparationStatus;
  preparationPhase: PreparationPhase;
  sessions: ControlWorktreeSessionRecord[];
}

export interface ControlWorktreeSource {
  list(projectId: string): ControlWorktreeRecord[];
  get(worktreeId: string): ControlWorktreeRecord | undefined;
}

export interface ControlSessionRecord {
  sessionId: string;
  worktreeId: string;
  projectId: string;
  title: string;
  provider: string;
  providerState: string | null;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  updatedAt: string;
}

export type PublicSessionDto = Omit<ControlSessionRecord, 'providerState'>;

export interface ControlSessionSource {
  list(worktreeId: string): ControlSessionRecord[];
  get(sessionId: string): ControlSessionRecord | undefined;
}

export const CONTROL_CODEX_SERVICE_TIERS = ['fast', 'default'] as const;
export type ControlCodexServiceTier = typeof CONTROL_CODEX_SERVICE_TIERS[number];

export function isControlCodexServiceTier(value: unknown): value is ControlCodexServiceTier {
  return typeof value === 'string'
    && CONTROL_CODEX_SERVICE_TIERS.some((serviceTier) => serviceTier === value);
}

export interface ControlSessionCreationRequest {
  worktreeId: string;
  provider: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: ControlCodexServiceTier;
}

export interface ControlSessionStartRequest {
  sessionId: string;
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
}

export interface ControlSessionLaunchRequest extends ControlSessionCreationRequest {
  initialPrompt?: string;
  allowPreparationFailure?: boolean;
}

export interface ControlSessionMutator {
  create(request: ControlSessionCreationRequest): Promise<ControlSessionRecord>;
  start(request: ControlSessionStartRequest): Promise<{ terminalId: string }>;
  removeCreated(sessionId: string): Promise<void>;
}

export interface ControlSessionObserver {
  read(sessionId: string): Promise<TerminalSessionSnapshot>;
  wait(
    sessionId: string,
    condition: TerminalSessionWaitCondition,
    timeoutMs: number,
  ): Promise<TerminalSessionSnapshot>;
}

export interface ControlSessionRuntimeController {
  prompt(sessionId: string, text: string): Promise<TerminalSessionSnapshot>;
  sendKeys(sessionId: string, keys: TerminalNamedKey[]): Promise<TerminalSessionSnapshot>;
  stop(sessionId: string): Promise<TerminalSessionSnapshot>;
}

export interface ControlSessionPromptRequest {
  sessionId: string;
  text: string;
}

export interface ControlSessionKeysRequest {
  sessionId: string;
  keys: TerminalNamedKey[];
}

export interface ControlSessionWaitRequest {
  sessionId: string;
  condition: TerminalSessionWaitCondition;
  timeoutSeconds?: number;
}

export interface ControlWorktreeCreationRequest {
  project: ControlProjectRecord;
  branch: string;
  startPoint: string;
  source?: WorktreeCreationSource;
  title?: string;
}

export interface ControlCreatedWorktreeRecord {
  worktree: ControlWorktreeRecord;
  startPoint: string;
}

export interface ControlWorktreeCreator {
  create(request: ControlWorktreeCreationRequest): Promise<ControlCreatedWorktreeRecord>;
}

export class ControlWorktreeCreationError extends Error {
  constructor(
    readonly code: Extract<ControlErrorCode,
      | 'BRANCH_ALREADY_EXISTS'
      | 'BRANCH_ALREADY_CHECKED_OUT'
      | 'BRANCH_NOT_FOUND'
      | 'INVALID_START_POINT'
      | 'PREPARATION_FAILED'
      | 'PREPARATION_TIMEOUT'
      | 'WORKTREE_CREATE_FAILED'
      | 'WORKTREE_PERSIST_FAILED'>,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    readonly worktree?: ControlWorktreeRecord,
    readonly startPoint?: string,
  ) {
    super(message);
    this.name = 'ControlWorktreeCreationError';
  }
}

export type ControlProjectSelector =
  | { kind: 'current' }
  | { kind: 'project'; projectId: string };

export interface PublicWorktreeDto {
  worktreeId: string;
  projectId: string;
  title: string;
  branch: string | null;
  path: string | null;
  preparation: {
    status: PreparationStatus;
    phase: PreparationPhase;
    afterRunning: boolean;
  };
  sessions: ControlWorktreeSessionRecord[];
}

export interface PublicCreatedWorktreeDto extends PublicWorktreeDto {
  startPoint: string;
}

export interface ControlStatusDto {
  appVersion: string;
  controlVersion: typeof CONTROL_API_VERSION;
  instanceId: string;
  connectionState: 'connected';
  callerContext: PublicControlCallerContext;
}

export type PublicControlCallerContext = Omit<ControlAuthorityContext, 'agentEnvironment'>;

export interface ControlService {
  assertAuthority(context: ControlCallerContext): void;
  status(context: ControlCallerContext): Promise<ControlStatusDto>;
  inspectCodexLifecycle(
    context: ControlCallerContext,
  ): Promise<ProviderIntegrationLaunchDecision>;
  installCodexLifecycle(
    request: { consent: 'granted' },
    context: ControlCallerContext,
  ): Promise<ProviderIntegrationLaunchDecision>;
  updateCodexLifecycle(
    context: ControlCallerContext,
  ): Promise<ProviderIntegrationLaunchDecision>;
  removeCodexLifecycle(
    context: ControlCallerContext,
  ): Promise<ProviderIntegrationLaunchDecision>;
  manageProviderSkills(
    request: { operation: 'install' | 'status' | 'update' | 'remove'; providerIds?: ProviderSkillId[] },
    context: ControlCallerContext,
  ): Promise<ProviderSkillManagementResult>;
  listProjects(context: ControlCallerContext): Promise<{ projects: PublicProjectDto[] }>;
  showProject(projectId: string, context: ControlCallerContext): Promise<PublicProjectDto>;
  listProjectAudit(
    selector: ControlProjectSelector,
    context: ControlCallerContext,
  ): Promise<{ records: PublicControlAuditRecord[] }>;
  listWorktrees(
    selector: ControlProjectSelector,
    context: ControlCallerContext,
  ): Promise<{ worktrees: PublicWorktreeDto[] }>;
  showWorktree(worktreeId: string, context: ControlCallerContext): Promise<PublicWorktreeDto>;
  createWorktree(
    request: {
      selector: ControlProjectSelector;
      branch: string;
      startPoint: string;
      source?: WorktreeCreationSource;
      title?: string;
    },
    context: ControlCallerContext,
  ): Promise<PublicCreatedWorktreeDto>;
  listSessions(
    worktreeId: string,
    context: ControlCallerContext,
  ): Promise<{ sessions: PublicSessionDto[] }>;
  showSession(sessionId: string, context: ControlCallerContext): Promise<PublicSessionDto>;
  createSession(
    request: ControlSessionCreationRequest,
    context: ControlCallerContext,
  ): Promise<PublicSessionDto>;
  startSession(
    request: ControlSessionStartRequest,
    context: ControlCallerContext,
  ): Promise<{ session: PublicSessionDto; terminalId: string }>;
  launchSession(
    request: ControlSessionLaunchRequest,
    context: ControlCallerContext,
  ): Promise<{ session: PublicSessionDto; terminalId: string }>;
  readSession(
    sessionId: string,
    context: ControlCallerContext,
  ): Promise<TerminalSessionSnapshot>;
  waitForSession(
    request: ControlSessionWaitRequest,
    context: ControlCallerContext,
  ): Promise<TerminalSessionSnapshot>;
  promptSession(
    request: ControlSessionPromptRequest,
    context: ControlCallerContext,
  ): Promise<TerminalSessionSnapshot>;
  sendSessionKeys(
    request: ControlSessionKeysRequest,
    context: ControlCallerContext,
  ): Promise<TerminalSessionSnapshot>;
  stopSession(
    sessionId: string,
    context: ControlCallerContext,
  ): Promise<TerminalSessionSnapshot>;
}

export class ControlOperationError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ControlOperationError';
  }
}

export class ControlSessionStartError extends ControlOperationError {
  constructor(
    code: ControlErrorCode,
    message: string,
    httpStatus: number,
    details: Record<string, unknown>,
    readonly runtimeState: TerminalLaunchRuntimeState = 'unowned',
  ) {
    super(code, message, httpStatus, details);
    this.name = 'ControlSessionStartError';
  }

  get runtimeSpawned(): boolean {
    return this.runtimeState === 'spawned';
  }

  get runtimeOwned(): boolean {
    return this.runtimeState !== 'unowned';
  }
}

export function createControlService(options: {
  appVersion: string;
  runtimeId: string;
  authority: ControlAuthoritySource;
  projects: ControlProjectSource;
  worktrees: ControlWorktreeSource;
  worktreeCreator?: ControlWorktreeCreator;
  sessions?: ControlSessionSource;
  sessionMutator?: ControlSessionMutator;
  sessionObserver?: ControlSessionObserver;
  sessionController?: ControlSessionRuntimeController;
  auditHistory: ControlAuditHistory;
  providerIntegration?: ControlProviderIntegrationManager;
  providerSkillIntegration?: ProviderIntegration;
  resolveUserId?: () => Promise<string>;
}): ControlService {
  const {
    appVersion,
    runtimeId,
    authority,
    projects,
    worktrees,
    worktreeCreator,
    sessions,
    sessionMutator,
    sessionObserver,
    sessionController,
    auditHistory,
    providerIntegration,
    providerSkillIntegration,
    resolveUserId,
  } = options;

  return {
    assertAuthority(context) {
      requireControlAuthority(authority, context);
    },

    async status(context) {
      const caller = requireControlAuthority(authority, context);
      return {
        appVersion,
        controlVersion: CONTROL_API_VERSION,
        instanceId: runtimeId,
        connectionState: 'connected',
        callerContext: publicCallerContext(caller),
      };
    },

    async inspectCodexLifecycle(context) {
      if (context.projectId || context.worktreeId || context.sessionId) {
        throw new ControlOperationError(
          'UNAUTHORIZED',
          'Managed Sessions cannot inspect user-wide provider integration state.',
          403,
        );
      }
      if (!providerIntegration) {
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'This Tessera runtime cannot inspect provider integrations.',
          503,
        );
      }
      return providerIntegration.inspectCodexLifecycle();
    },

    async installCodexLifecycle(request, context) {
      if (request.consent !== 'granted') {
        throw new ControlOperationError(
          'INVALID_USAGE',
          'Explicit Codex lifecycle hook consent is required.',
          400,
        );
      }
      if (context.projectId || context.worktreeId || context.sessionId) {
        throw new ControlOperationError(
          'UNAUTHORIZED',
          'Managed Sessions cannot consent to user-wide provider integration changes.',
          403,
        );
      }
      if (!providerIntegration) {
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'This Tessera runtime cannot install provider integrations.',
          503,
        );
      }
      return providerIntegration.installCodexLifecycle();
    },

    async updateCodexLifecycle(context) {
      if (context.projectId || context.worktreeId || context.sessionId) {
        throw new ControlOperationError(
          'UNAUTHORIZED',
          'Managed Sessions cannot update user-wide provider integrations.',
          403,
        );
      }
      if (!providerIntegration) {
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'This Tessera runtime cannot update provider integrations.',
          503,
        );
      }
      return providerIntegration.updateCodexLifecycle();
    },

    async removeCodexLifecycle(context) {
      if (context.projectId || context.worktreeId || context.sessionId) {
        throw new ControlOperationError(
          'UNAUTHORIZED',
          'Managed Sessions cannot remove user-wide provider integrations.',
          403,
        );
      }
      if (!providerIntegration) {
        throw new ControlOperationError(
          'INSTANCE_UNAVAILABLE',
          'This Tessera runtime cannot remove provider integrations.',
          503,
        );
      }
      return providerIntegration.removeCodexLifecycle();
    },

    async manageProviderSkills(request, context) {
      if (!providerSkillIntegration || !resolveUserId) {
        throw new ControlOperationError(
          'PROVIDER_SKILL_TRANSACTION_FAILED',
          'Provider skill management is unavailable in this Tessera runtime.',
          503,
        );
      }
      if (context.projectId || context.worktreeId || context.sessionId) {
        throw new ControlOperationError(
          'PROVIDER_SKILL_GLOBAL_AUTHORITY_REQUIRED',
          'Provider skill management requires an explicit user-global CLI invocation outside a Managed Session.',
          403,
        );
      }
      const userId = await resolveUserId();
      const result = await providerSkillIntegration.manageSkills({
        ...request,
        agentEnvironmentOwner: { kind: 'user', userId },
      });
      if (!result.success) {
        throw new ControlOperationError(
          result.error?.code ?? 'PROVIDER_SKILL_TRANSACTION_FAILED',
          result.error?.message ?? 'Provider skill management failed.',
          result.error?.code === 'PROVIDER_SKILL_CONFLICT' ? 409 : 400,
          { result },
        );
      }
      return result;
    },

    async listProjects(context) {
      const caller = requireControlAuthority(authority, context);
      const project = projects.get(caller.projectId);
      return {
        projects: project ? [toPublicProject(project, caller)] : [],
      };
    },

    async showProject(projectId, context) {
      const caller = requireControlAuthority(authority, context);
      requireProjectScope(projectId, caller);
      const project = projects.get(projectId);
      if (!project) {
        throw new ControlOperationError(
          'PROJECT_NOT_FOUND',
          'The requested Project does not exist.',
          404,
          { projectId },
        );
      }
      return toPublicProject(project, caller);
    },

    async listProjectAudit(selector, context) {
      const caller = requireControlAuthority(authority, context);
      const projectId = resolveSelectedProjectId(selector, caller);
      requireProjectScope(projectId, caller);
      if (!projects.get(projectId)) {
        throw new ControlOperationError(
          'PROJECT_NOT_FOUND',
          'The requested Project does not exist.',
          404,
          { projectId },
        );
      }
      return { records: await auditHistory.list(projectId) };
    },

    async listWorktrees(selector, context) {
      const caller = requireControlAuthority(authority, context);
      const projectId = resolveSelectedProjectId(selector, caller);
      requireProjectScope(projectId, caller);
      if (!projects.get(projectId)) {
        throw new ControlOperationError(
          'PROJECT_NOT_FOUND',
          'The requested Project does not exist.',
          404,
          { projectId },
        );
      }
      return {
        worktrees: worktrees.list(projectId).map((worktree) => (
          toPublicWorktree(worktree, caller)
        )),
      };
    },

    async showWorktree(worktreeId, context) {
      const caller = requireControlAuthority(authority, context);
      return toPublicWorktree(requireScopedWorktree(worktrees, worktreeId, caller), caller);
    },

    async createWorktree(request, context) {
      const caller = requireControlAuthority(authority, context);
      const projectId = resolveSelectedProjectId(request.selector, caller);
      return auditProjectMutation(
        auditHistory,
        caller,
        'worktree.create',
        { kind: 'project', id: projectId },
        async () => {
          requireProjectScope(projectId, caller);
          const project = projects.get(projectId);
          if (!project) {
            throw new ControlOperationError(
              'PROJECT_NOT_FOUND',
              'The requested Project does not exist.',
              404,
              { projectId },
            );
          }
          if (!request.branch || !request.branch.trim()) {
            throw new ControlOperationError(
              'BRANCH_REQUIRED',
              'A new Worktree branch is required.',
              400,
            );
          }
          if (!request.startPoint || !request.startPoint.trim()) {
            throw new ControlOperationError(
              'START_POINT_REQUIRED',
              'A Worktree start point is required.',
              400,
            );
          }
          if (request.title !== undefined && !request.title.trim()) {
            throw new ControlOperationError(
              'INVALID_USAGE',
              'A Worktree title must not be empty.',
              400,
            );
          }
          const compatibility = validateProjectEnvironment(
            project.decodedPath,
            caller.agentEnvironment,
          );
          if (!compatibility.ok) {
            throw new ControlOperationError(
              'PROJECT_ENVIRONMENT_MISMATCH',
              compatibility.error ?? 'The Project is not compatible with the caller environment.',
              400,
              {
                projectId,
                agentEnvironment: caller.agentEnvironment,
                filesystemKind: compatibility.filesystemKind,
              },
            );
          }
          if (!worktreeCreator) {
            throw new ControlOperationError(
              'INSTANCE_UNAVAILABLE',
              'This Tessera runtime cannot create Worktrees.',
              503,
            );
          }

          let created: ControlCreatedWorktreeRecord;
          try {
            created = await worktreeCreator.create({
              project,
              branch: request.branch,
              startPoint: request.startPoint,
              ...(request.source === undefined ? {} : { source: request.source }),
              ...(request.title === undefined ? {} : { title: request.title }),
            });
          } catch (error) {
            if (!(error instanceof ControlWorktreeCreationError)) throw error;
            const details = error.worktree && error.startPoint
              ? {
                  ...error.details,
                  worktree: {
                    ...toPublicWorktree(error.worktree, caller),
                    startPoint: error.startPoint,
                  },
                }
              : error.details;
            throw new ControlOperationError(error.code, error.message, error.httpStatus, details);
          }
          return {
            ...toPublicWorktree(created.worktree, caller),
            startPoint: created.startPoint,
          };
        },
        (created) => ({ kind: 'worktree', id: created.worktreeId }),
      );
    },

    async listSessions(worktreeId, context) {
      const caller = requireControlAuthority(authority, context);
      requireScopedWorktree(worktrees, worktreeId, caller);
      const support = requireSessionSupport(sessions, sessionMutator);
      return {
        sessions: support.sessions.list(worktreeId).map(toPublicSession),
      };
    },

    async showSession(sessionId, context) {
      const caller = requireControlAuthority(authority, context);
      const support = requireSessionSupport(sessions, sessionMutator);
      return toPublicSession(requireScopedSession(support.sessions, sessionId, caller));
    },

    async createSession(request, context) {
      const caller = requireControlAuthority(authority, context);
      return toPublicSession(await auditProjectMutation(
        auditHistory,
        caller,
        'session.create',
        { kind: 'worktree', id: request.worktreeId },
        async () => {
          requireScopedWorktree(worktrees, request.worktreeId, caller);
          const support = requireSessionSupport(sessions, sessionMutator);
          validateSessionCreationRequest(request);
          return support.mutator.create(request);
        },
        (created) => ({ kind: 'session', id: created.sessionId }),
      ));
    },

    async startSession(request, context) {
      const caller = requireControlAuthority(authority, context);
      const target = { kind: 'session' as const, id: request.sessionId };
      return auditProjectMutation(
        auditHistory,
        caller,
        'session.start',
        target,
        async () => {
          const support = requireSessionSupport(sessions, sessionMutator);
          const session = requireScopedSession(support.sessions, request.sessionId, caller);
          const launched = await support.mutator.start(request);
          return { session: toPublicSession(session), terminalId: launched.terminalId };
        },
      );
    },

    async launchSession(request, context) {
      const caller = requireControlAuthority(authority, context);
      let target: ControlAuditTarget = { kind: 'worktree', id: request.worktreeId };
      return auditProjectMutation(
        auditHistory,
        caller,
        'session.launch',
        () => target,
        async () => {
          requireScopedWorktree(worktrees, request.worktreeId, caller);
          const support = requireSessionSupport(sessions, sessionMutator);
          validateSessionCreationRequest(request);
          const created = await support.mutator.create(request);
          target = { kind: 'session', id: created.sessionId };
          try {
            const launched = await support.mutator.start({
              sessionId: created.sessionId,
              initialPrompt: request.initialPrompt,
              allowPreparationFailure: request.allowPreparationFailure,
            });
            return { session: toPublicSession(created), terminalId: launched.terminalId };
          } catch (error) {
            if (!(error instanceof ControlSessionStartError) || !error.runtimeOwned) {
              await support.mutator.removeCreated(created.sessionId);
            }
            throw error;
          }
        },
      );
    },

    async readSession(sessionId, context) {
      const caller = requireControlAuthority(authority, context);
      const observer = requireSessionObserver(sessions, sessionObserver);
      requireScopedSession(observer.sessions, sessionId, caller);
      return observer.observer.read(sessionId);
    },

    async waitForSession(request, context) {
      const caller = requireControlAuthority(authority, context);
      const observer = requireSessionObserver(sessions, sessionObserver);
      requireScopedSession(observer.sessions, request.sessionId, caller);
      const timeoutSeconds = request.timeoutSeconds ?? 600;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) {
        throw new ControlOperationError(
          'INVALID_USAGE',
          'The Session wait timeout must be an integer from 1 to 3600 seconds.',
          400,
        );
      }
      if (!isSessionWaitCondition(request.condition)) {
        throw new ControlOperationError(
          'INVALID_USAGE',
          'The Session wait condition is not supported.',
          400,
        );
      }
      return observer.observer.wait(
        request.sessionId,
        request.condition,
        timeoutSeconds * 1_000,
      );
    },

    async promptSession(request, context) {
      const caller = requireControlAuthority(authority, context);
      const target = { kind: 'session' as const, id: request.sessionId };
      return auditProjectMutation(
        auditHistory,
        caller,
        'session.prompt',
        target,
        async () => {
          const controller = requireSessionController(sessions, sessionController);
          requireScopedSession(controller.sessions, request.sessionId, caller);
          if (!request.text.trim()) {
            throw new ControlOperationError(
              'INPUT_NOT_ACCEPTED',
              'The Session prompt must not be empty.',
              409,
              { sessionId: request.sessionId },
            );
          }
          return controller.controller.prompt(request.sessionId, request.text);
        },
      );
    },

    async sendSessionKeys(request, context) {
      const caller = requireControlAuthority(authority, context);
      const target = { kind: 'session' as const, id: request.sessionId };
      return auditProjectMutation(
        auditHistory,
        caller,
        'session.send-keys',
        target,
        async () => {
          const controller = requireSessionController(sessions, sessionController);
          requireScopedSession(controller.sessions, request.sessionId, caller);
          if (request.keys.length === 0 || !request.keys.every(isTerminalNamedKey)) {
            throw new ControlOperationError(
              'INVALID_USAGE',
              'At least one supported Session key is required.',
              400,
            );
          }
          return controller.controller.sendKeys(request.sessionId, request.keys);
        },
      );
    },

    async stopSession(sessionId, context) {
      const caller = requireControlAuthority(authority, context);
      const target = { kind: 'session' as const, id: sessionId };
      return auditProjectMutation(
        auditHistory,
        caller,
        'session.stop',
        target,
        async () => {
          const controller = requireSessionController(sessions, sessionController);
          requireScopedSession(controller.sessions, sessionId, caller);
          return controller.controller.stop(sessionId);
        },
      );
    },
  };
}

function requireControlAuthority(
  authority: ControlAuthoritySource,
  context: ControlCallerContext,
): ControlAuthorityContext {
  const resolved = authority.resolve(context.authorityToken);
  if (resolved) return resolved;
  throw new ControlOperationError(
    'CONTROL_AUTHORITY_DENIED',
    'The caller does not have active Tessera Control authority.',
    403,
  );
}

function publicAuditFailureCode(error: unknown): string | undefined {
  return error instanceof ControlOperationError ? error.code : undefined;
}

function auditProjectMutation<T>(
  history: ControlAuditHistory,
  caller: ControlAuthorityContext,
  operation: ControlAuditOperation,
  target: ControlAuditTarget | (() => ControlAuditTarget),
  mutation: () => Promise<T>,
  successTarget?: (result: T) => ControlAuditTarget,
): Promise<T> {
  const resolveTarget = (): ControlAuditTarget => (
    typeof target === 'function' ? target() : target
  );
  return auditControlMutation(
    history,
    {
      projectId: caller.projectId,
      sourceSessionId: caller.sessionId,
      operation,
      failureTarget: resolveTarget,
      successTarget: successTarget ?? resolveTarget,
      failureCode: publicAuditFailureCode,
    },
    mutation,
  );
}

function requireProjectScope(
  projectId: string,
  authority: ControlAuthorityContext,
): void {
  if (projectId === authority.projectId) return;
  throwOutsideProjectScope();
}

function throwOutsideProjectScope(): never {
  throw new ControlOperationError(
    'CONTROL_AUTHORITY_DENIED',
    'The requested resource is outside the caller Project scope.',
    403,
  );
}

function requireScopedWorktree(
  worktrees: ControlWorktreeSource,
  worktreeId: string,
  authority: ControlAuthorityContext,
): ControlWorktreeRecord {
  const worktree = worktrees.get(worktreeId);
  if (!worktree || worktree.projectId !== authority.projectId) throwOutsideProjectScope();
  return worktree;
}

function requireSessionSupport(
  sessions: ControlSessionSource | undefined,
  sessionMutator: ControlSessionMutator | undefined,
): { sessions: ControlSessionSource; mutator: ControlSessionMutator } {
  if (sessions && sessionMutator) return { sessions, mutator: sessionMutator };
  throw new ControlOperationError(
    'INSTANCE_UNAVAILABLE',
    'This Tessera runtime cannot operate Sessions.',
    503,
  );
}

function requireSessionObserver(
  sessions: ControlSessionSource | undefined,
  sessionObserver: ControlSessionObserver | undefined,
): { sessions: ControlSessionSource; observer: ControlSessionObserver } {
  if (sessions && sessionObserver) return { sessions, observer: sessionObserver };
  throw new ControlOperationError(
    'INSTANCE_UNAVAILABLE',
    'This Tessera runtime cannot observe Sessions.',
    503,
  );
}

function requireSessionController(
  sessions: ControlSessionSource | undefined,
  sessionController: ControlSessionRuntimeController | undefined,
): { sessions: ControlSessionSource; controller: ControlSessionRuntimeController } {
  if (sessions && sessionController) return { sessions, controller: sessionController };
  throw new ControlOperationError(
    'INSTANCE_UNAVAILABLE',
    'This Tessera runtime cannot control Sessions.',
    503,
  );
}

function isSessionWaitCondition(value: unknown): value is TerminalSessionWaitCondition {
  return value === 'running'
    || value === 'turn-complete'
    || value === 'input-required'
    || value === 'runtime-exit';
}

function requireScopedSession(
  sessions: ControlSessionSource,
  sessionId: string,
  authority: ControlAuthorityContext,
): ControlSessionRecord {
  const session = sessions.get(sessionId);
  if (!session || session.projectId !== authority.projectId) throwOutsideProjectScope();
  return session;
}

function validateSessionCreationRequest(
  request: Pick<
    ControlSessionCreationRequest,
    'provider' | 'title' | 'model' | 'reasoningEffort' | 'serviceTier'
  >,
): void {
  if (!request.provider.trim()) {
    throw new ControlOperationError(
      'PROVIDER_NOT_SUPPORTED',
      'An explicit supported provider is required.',
      400,
    );
  }
  if (request.title !== undefined && !request.title.trim()) {
    throw new ControlOperationError('INVALID_USAGE', 'A Session title must not be empty.', 400);
  }
  const provider = request.provider.trim();
  if (
    (request.model !== undefined || request.reasoningEffort !== undefined)
    && provider !== 'claude-code'
    && provider !== 'codex'
  ) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'Session model and effort selection is supported only for Claude Code and Codex.',
      400,
    );
  }
  if (request.serviceTier !== undefined && provider !== 'codex') {
    throw new ControlOperationError(
      'INVALID_USAGE',
      'Session fast mode selection is supported only for Codex.',
      400,
    );
  }
  if (request.serviceTier !== undefined && !isControlCodexServiceTier(request.serviceTier)) {
    throw new ControlOperationError('INVALID_USAGE', 'The Session fast mode is invalid.', 400);
  }
  validateSessionSelectionValue(request.model, 'model', 512);
  validateSessionSelectionValue(request.reasoningEffort, 'effort', 64);
}

function validateSessionSelectionValue(
  value: string | undefined,
  label: 'model' | 'effort',
  maxLength: number,
): void {
  if (value === undefined) return;
  if (!value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ControlOperationError(
      'INVALID_USAGE',
      `The Session ${label} is invalid.`,
      400,
    );
  }
}

function toPublicSession(session: ControlSessionRecord): PublicSessionDto {
  return {
    sessionId: session.sessionId,
    worktreeId: session.worktreeId,
    projectId: session.projectId,
    title: session.title,
    provider: session.provider,
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: session.reasoningEffort }),
    ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
    updatedAt: session.updatedAt,
  };
}

function resolveSelectedProjectId(
  selector: ControlProjectSelector,
  context: Pick<ControlAuthorityContext, 'projectId'>,
): string {
  return selector.kind === 'project' ? selector.projectId : context.projectId;
}

function publicCallerContext(
  context: ControlAuthorityContext,
): PublicControlCallerContext {
  return {
    projectId: context.projectId,
    sessionId: context.sessionId,
    ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
  };
}

function toPublicProject(
  project: ControlProjectRecord,
  context: ControlCallerContext,
): PublicProjectDto {
  const compatibility = validateProjectEnvironment(
    project.decodedPath,
    context.agentEnvironment,
  );
  return {
    id: project.id,
    displayName: project.displayName,
    path: formatPathForAgentDisplay(project.decodedPath, context.agentEnvironment),
    visible: project.visible,
    agentEnvironmentCompatibility: {
      agentEnvironment: context.agentEnvironment,
      filesystemKind: compatibility.filesystemKind,
      compatible: compatibility.ok,
    },
  };
}

function toPublicWorktree(
  worktree: ControlWorktreeRecord,
  context: ControlCallerContext,
): PublicWorktreeDto {
  return {
    worktreeId: worktree.worktreeId,
    projectId: worktree.projectId,
    title: worktree.title,
    branch: worktree.branch,
    path: worktree.filesystemPath === null
      ? null
      : formatPathForAgentDisplay(worktree.filesystemPath, context.agentEnvironment),
    preparation: {
      status: worktree.preparationStatus,
      phase: worktree.preparationPhase,
      afterRunning: worktree.preparationStatus === 'running'
        && worktree.preparationPhase === 'after',
    },
    sessions: worktree.sessions.map((session) => ({ ...session })),
  };
}
