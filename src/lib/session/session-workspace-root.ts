import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import {
  isAbsoluteFilesystemPath,
  resolvePathForHostFilesystem,
} from '@/lib/filesystem/host-path';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';

interface SessionWorkspaceFilesystemOptions {
  agentEnvironment: AgentEnvironment;
  resolveAgentPath?: (
    filesystemPath: string,
    environment: AgentEnvironment,
  ) => Promise<string>;
}

export function resolveSessionWorkspaceRoot(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;

  const workDir = dbSessions.getSessionWorktreeContext(sessionId)?.workDir?.trim();
  if (workDir) return workDir;

  const projectPath = dbProjects.getProject(session.project_id)?.decoded_path?.trim();
  if (projectPath) return projectPath;

  const projectId = session.project_id?.trim();
  if (projectId && isAbsoluteFilesystemPath(projectId)) return projectId;

  return null;
}

export async function resolveSessionWorkspaceFilesystemRoot(
  sessionId: string,
  options?: SessionWorkspaceFilesystemOptions,
): Promise<string | null> {
  const root = resolveSessionWorkspaceRoot(sessionId);
  if (!root) return null;
  if (options) {
    return (options.resolveAgentPath ?? resolveAgentReportedPath)(
      root,
      options.agentEnvironment,
    );
  }
  return resolvePathForHostFilesystem(root);
}
