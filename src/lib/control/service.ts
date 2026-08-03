import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import {
  validateProjectEnvironment,
  type ProjectFilesystemKind,
} from '@/lib/projects/environment-policy';
import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  PreparationPhase,
  PreparationStatus,
} from '@/lib/projects/preparation-status-policy';
import { CONTROL_API_VERSION } from './runtime-descriptor';

export type ControlErrorCode =
  | 'CALLER_CONTEXT_UNAVAILABLE'
  | 'CONTROL_VERSION_MISMATCH'
  | 'INSTANCE_UNAVAILABLE'
  | 'INVALID_USAGE'
  | 'PROJECT_NOT_FOUND'
  | 'WORKTREE_NOT_FOUND'
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

export function createControlService(options: {
  appVersion: string;
  runtimeId: string;
  projects: ControlProjectSource;
  worktrees: ControlWorktreeSource;
}): ControlService {
  const { appVersion, runtimeId, projects, worktrees } = options;

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
