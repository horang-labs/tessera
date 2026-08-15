import path from 'path';
import * as dbProjects from '../db/projects';
import * as dbSessions from '../db/sessions';
import type { AgentExecutionMode } from './agent-execution-mode';

interface PersistCreatedSessionRecordOptions {
  collectionId?: string;
  hasCustomTitle?: boolean;
  parentProjectId?: string;
  providerId: string;
  resolvedWorkDir: string;
  sessionId: string;
  taskId?: string;
  title: string;
  executionMode: AgentExecutionMode;
  worktreeBranch?: string;
  worktreeManaged?: boolean;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  providerState?: string | null;
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
  const storedProject = dbProjects.getProject(project.projectId);
  // A bridged Project can retain the agent's /home/... spelling while its
  // canonical Worktree uses the Windows-hosted UNC spelling. The Project has
  // already established that identity, so an exact root Session should reuse
  // it instead of asking the server filesystem to reinterpret the agent path.
  // A different workDir may be a taskless linked checkout and must not inherit
  // the Project root's membership.
  const projectRootWorktreeId = !options.taskId
    && storedProject?.project_worktree_id
    && options.resolvedWorkDir === storedProject.decoded_path
    ? storedProject.project_worktree_id
    : undefined;

  dbSessions.createSession(
    options.sessionId,
    project.projectId,
    options.title,
    options.providerId,
    {
      workDir: options.resolvedWorkDir,
      worktreeBranch: options.worktreeBranch,
      worktreeManaged: options.worktreeManaged,
      worktreeId: projectRootWorktreeId,
      taskId: options.taskId,
      collectionId: options.collectionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      providerState: options.providerState,
    },
  );

  if (options.executionMode === 'pty') {
    dbSessions.updateSession(options.sessionId, {
      provider_state: JSON.stringify({ kind: 'terminal' }),
    });
  }

  if (options.hasCustomTitle === true) {
    dbSessions.updateSession(
      options.sessionId,
      { has_custom_title: 1 },
      { skipTimestamp: true },
    );
  }

  return project;
}
