import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
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
import { CONTROL_API_VERSION } from './runtime-descriptor';

export type ControlErrorCode =
  | 'BRANCH_REQUIRED'
  | 'BRANCH_ALREADY_EXISTS'
  | 'CALLER_CONTEXT_UNAVAILABLE'
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
  callerContext: Omit<ControlCallerContext, 'agentEnvironment'> | null;
}

export interface ControlService {
  status(context: ControlCallerContext): Promise<ControlStatusDto>;
  listProjects(context: ControlCallerContext): Promise<{ projects: PublicProjectDto[] }>;
  showProject(projectId: string, context: ControlCallerContext): Promise<PublicProjectDto>;
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
  projects: ControlProjectSource;
  worktrees: ControlWorktreeSource;
  worktreeCreator?: ControlWorktreeCreator;
  sessions?: ControlSessionSource;
  sessionMutator?: ControlSessionMutator;
  sessionObserver?: ControlSessionObserver;
  sessionController?: ControlSessionRuntimeController;
}): ControlService {
  const {
    appVersion,
    runtimeId,
    projects,
    worktrees,
    worktreeCreator,
    sessions,
    sessionMutator,
    sessionObserver,
    sessionController,
  } = options;

  return {
    async status(context) {
      return {
        appVersion,
        controlVersion: CONTROL_API_VERSION,
        instanceId: runtimeId,
        connectionState: 'connected',
        callerContext: publicCallerContext(context),
      };
    },

    async listProjects(context) {
      return {
        projects: projects.list().map((project) => toPublicProject(project, context)),
      };
    },

    async showProject(projectId, context) {
      const project = projects.get(projectId);
      if (!project) {
        throw new ControlOperationError(
          'PROJECT_NOT_FOUND',
          'The requested Project does not exist.',
          404,
          { projectId },
        );
      }
      return toPublicProject(project, context);
    },

    async listWorktrees(selector, context) {
      const projectId = resolveSelectedProjectId(selector, context);
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
          toPublicWorktree(worktree, context)
        )),
      };
    },

    async showWorktree(worktreeId, context) {
      const worktree = worktrees.get(worktreeId);
      if (!worktree) {
        throw new ControlOperationError(
          'WORKTREE_NOT_FOUND',
          'The requested Worktree does not exist.',
          404,
          { worktreeId },
        );
      }
      return toPublicWorktree(worktree, context);
    },

    async createWorktree(request, context) {
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

      const projectId = resolveSelectedProjectId(request.selector, context);
      const project = projects.get(projectId);
      if (!project) {
        throw new ControlOperationError(
          'PROJECT_NOT_FOUND',
          'The requested Project does not exist.',
          404,
          { projectId },
        );
      }
      const compatibility = validateProjectEnvironment(
        project.decodedPath,
        context.agentEnvironment,
      );
      if (!compatibility.ok) {
        throw new ControlOperationError(
          'PROJECT_ENVIRONMENT_MISMATCH',
          compatibility.error ?? 'The Project is not compatible with the caller environment.',
          400,
          {
            projectId,
            agentEnvironment: context.agentEnvironment,
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
          ...(request.title === undefined ? {} : { title: request.title }),
        });
      } catch (error) {
        if (!(error instanceof ControlWorktreeCreationError)) throw error;
        const details = error.worktree && error.startPoint
          ? {
              ...error.details,
              worktree: {
                ...toPublicWorktree(error.worktree, context),
                startPoint: error.startPoint,
              },
            }
          : error.details;
        throw new ControlOperationError(error.code, error.message, error.httpStatus, details);
      }
      return {
        ...toPublicWorktree(created.worktree, context),
        startPoint: created.startPoint,
      };
    },

    async listSessions(worktreeId) {
      requireWorktree(worktrees, worktreeId);
      const support = requireSessionSupport(sessions, sessionMutator);
      return {
        sessions: support.sessions.list(worktreeId).map(toPublicSession),
      };
    },

    async showSession(sessionId) {
      const support = requireSessionSupport(sessions, sessionMutator);
      return toPublicSession(requireSession(support.sessions, sessionId));
    },

    async createSession(request) {
      requireWorktree(worktrees, request.worktreeId);
      const support = requireSessionSupport(sessions, sessionMutator);
      validateSessionCreationRequest(request);
      return toPublicSession(await support.mutator.create(request));
    },

    async startSession(request) {
      const support = requireSessionSupport(sessions, sessionMutator);
      const session = requireSession(support.sessions, request.sessionId);
      const launched = await support.mutator.start(request);
      return { session: toPublicSession(session), terminalId: launched.terminalId };
    },

    async launchSession(request) {
      requireWorktree(worktrees, request.worktreeId);
      const support = requireSessionSupport(sessions, sessionMutator);
      validateSessionCreationRequest(request);
      const created = await support.mutator.create(request);
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

    async readSession(sessionId) {
      const observer = requireSessionObserver(sessions, sessionObserver);
      requireSession(observer.sessions, sessionId);
      return observer.observer.read(sessionId);
    },

    async waitForSession(request) {
      const observer = requireSessionObserver(sessions, sessionObserver);
      requireSession(observer.sessions, request.sessionId);
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

    async promptSession(request) {
      const controller = requireSessionController(sessions, sessionController);
      requireSession(controller.sessions, request.sessionId);
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

    async sendSessionKeys(request) {
      const controller = requireSessionController(sessions, sessionController);
      requireSession(controller.sessions, request.sessionId);
      if (request.keys.length === 0 || !request.keys.every(isTerminalNamedKey)) {
        throw new ControlOperationError(
          'INVALID_USAGE',
          'At least one supported Session key is required.',
          400,
        );
      }
      return controller.controller.sendKeys(request.sessionId, request.keys);
    },

    async stopSession(sessionId) {
      const controller = requireSessionController(sessions, sessionController);
      requireSession(controller.sessions, sessionId);
      return controller.controller.stop(sessionId);
    },
  };
}

function requireWorktree(
  worktrees: ControlWorktreeSource,
  worktreeId: string,
): ControlWorktreeRecord {
  const worktree = worktrees.get(worktreeId);
  if (worktree) return worktree;
  throw new ControlOperationError(
    'WORKTREE_NOT_FOUND',
    'The requested Worktree does not exist.',
    404,
    { worktreeId },
  );
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

function requireSession(
  sessions: ControlSessionSource,
  sessionId: string,
): ControlSessionRecord {
  const session = sessions.get(sessionId);
  if (session) return session;
  throw new ControlOperationError(
    'SESSION_NOT_FOUND',
    'The requested Session does not exist.',
    404,
    { sessionId },
  );
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
  context: ControlCallerContext,
): string {
  if (selector.kind === 'project') return selector.projectId;
  if (context.projectId) return context.projectId;
  throw new ControlOperationError(
    'CALLER_CONTEXT_UNAVAILABLE',
    'The current Project is unavailable outside a managed caller context.',
    400,
  );
}

function publicCallerContext(
  context: ControlCallerContext,
): Omit<ControlCallerContext, 'agentEnvironment'> | null {
  const callerContext: Omit<ControlCallerContext, 'agentEnvironment'> = {};
  if (context.projectId) callerContext.projectId = context.projectId;
  if (context.sessionId) callerContext.sessionId = context.sessionId;
  if (context.worktreeId) callerContext.worktreeId = context.worktreeId;
  return Object.keys(callerContext).length > 0 ? callerContext : null;
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
