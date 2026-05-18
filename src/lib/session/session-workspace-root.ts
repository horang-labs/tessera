import * as dbProjects from '@/lib/db/projects';
import * as dbSessions from '@/lib/db/sessions';
import {
  isAbsoluteFilesystemPath,
  resolvePathForHostFilesystem,
} from '@/lib/filesystem/host-path';

export function resolveSessionWorkspaceRoot(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;

  const workDir = session.work_dir?.trim();
  if (workDir) return workDir;

  const projectPath = dbProjects.getProject(session.project_id)?.decoded_path?.trim();
  if (projectPath) return projectPath;

  const projectId = session.project_id?.trim();
  if (projectId && isAbsoluteFilesystemPath(projectId)) return projectId;

  return null;
}

export async function resolveSessionWorkspaceFilesystemRoot(
  sessionId: string,
): Promise<string | null> {
  const root = resolveSessionWorkspaceRoot(sessionId);
  return root ? resolvePathForHostFilesystem(root) : null;
}
