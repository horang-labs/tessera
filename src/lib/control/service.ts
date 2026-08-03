import { formatPathForAgentDisplay } from '@/lib/filesystem/path-environment';
import {
  validateProjectEnvironment,
  type ProjectFilesystemKind,
} from '@/lib/projects/environment-policy';
import type { AgentEnvironment } from '@/lib/settings/types';
import { CONTROL_API_VERSION } from './runtime-descriptor';

export type ControlErrorCode =
  | 'CALLER_CONTEXT_UNAVAILABLE'
  | 'CONTROL_VERSION_MISMATCH'
  | 'INSTANCE_UNAVAILABLE'
  | 'INVALID_USAGE'
  | 'PROJECT_NOT_FOUND'
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
}): ControlService {
  const { appVersion, runtimeId, projects } = options;

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
  };
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
