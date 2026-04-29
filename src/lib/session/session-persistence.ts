import path from 'path';
import * as dbProjects from '../db/projects';
import * as dbSessions from '../db/sessions';

interface PersistCreatedSessionRecordOptions {
  collectionId?: string;
  hasCustomTitle?: boolean;
  parentProjectId?: string;
  providerId: string;
  resolvedWorkDir: string;
  sessionId: string;
  taskId?: string;
  title: string;
  worktreeBranch?: string;
}

interface PersistedSessionProject {
  decodedPath: string;
  displayName: string;
  projectId: string;
}

function resolveSessionProject({
  parentProjectId,
  resolvedWorkDir,
}: Pick<PersistCreatedSessionRecordOptions, 'parentProjectId' | 'resolvedWorkDir'>): PersistedSessionProject {
  if (parentProjectId) {
    const parent = dbProjects.getProject(parentProjectId);
    return {
      projectId: parentProjectId,
      decodedPath: parent?.decoded_path || resolvedWorkDir,
      displayName: parent?.display_name || path.basename(resolvedWorkDir),
    };
  }

  return {
    projectId: resolvedWorkDir,
    decodedPath: resolvedWorkDir,
    displayName: path.basename(resolvedWorkDir),
  };
}

export function persistCreatedSessionRecord(
  options: PersistCreatedSessionRecordOptions,
): PersistedSessionProject {
  const project = resolveSessionProject(options);

  dbProjects.registerProject(project.projectId, project.decodedPath, project.displayName);

  dbSessions.createSession(
    options.sessionId,
    project.projectId,
    options.title,
    options.providerId,
    {
      workDir: options.resolvedWorkDir,
      taskId: options.taskId,
      collectionId: options.collectionId,
    },
  );

  if (options.hasCustomTitle === true) {
    dbSessions.updateSession(
      options.sessionId,
      { has_custom_title: 1 },
      { skipTimestamp: true },
    );
  }

  if (options.taskId && options.worktreeBranch) {
    dbSessions.updateSession(options.sessionId, {
      worktree_branch: options.worktreeBranch,
    });
  }

  return project;
}
