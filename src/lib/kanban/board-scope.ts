import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity } from '@/types/task-entity';
import { buildOriginProjectRepresentation } from '@/lib/projects/origin-project-representation';

export type KanbanScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'all-projects'; projectIds: string[] };

export interface KanbanScopeData {
  projects: ProjectGroup[];
  sessions: UnifiedSession[];
  tasks: TaskEntity[];
  collectionsByProject: Record<string, Collection[]>;
}
export function resolveKanbanScope(
  selectedProjectDir: string | null,
  projects: ProjectGroup[],
): KanbanScope | null {
  if (!selectedProjectDir) return null;
  if (selectedProjectDir === ALL_PROJECTS_SENTINEL) {
    return {
      kind: 'all-projects',
      projectIds: projects.map((project) => project.encodedDir),
    };
  }
  return { kind: 'project', projectId: selectedProjectDir };
}

export function getKanbanScopeProjectIds(scope: KanbanScope | null): string[] {
  if (!scope) return [];
  return scope.kind === 'all-projects' ? scope.projectIds : [scope.projectId];
}

export function collectKanbanScopeData(
  scope: KanbanScope | null,
  projects: ProjectGroup[],
  tasksByProject: Record<string, TaskEntity[]>,
  collectionsByProject: Record<string, Collection[]>,
): KanbanScopeData {
  const projectIds = getKanbanScopeProjectIds(scope);
  const projectIdSet = new Set(projectIds);
  const scopedProjects = projects.filter((project) => projectIdSet.has(project.encodedDir));

  if (scope?.kind === 'all-projects') {
    const origin = buildOriginProjectRepresentation(scopedProjects, tasksByProject);
    return {
      projects: origin.projects,
      sessions: origin.sessions,
      tasks: origin.tasks,
      collectionsByProject: Object.fromEntries(
        projectIds.map((projectId) => [projectId, collectionsByProject[projectId] ?? []]),
      ),
    };
  }

  return {
    projects: scopedProjects,
    sessions: scopedProjects.flatMap((project) => project.sessions),
    tasks: projectIds.flatMap((projectId) => tasksByProject[projectId] ?? []),
    collectionsByProject: Object.fromEntries(
      projectIds.map((projectId) => [projectId, collectionsByProject[projectId] ?? []]),
    ),
  };
}

export function selectKanbanProjectionItems(
  data: Pick<KanbanScopeData, 'sessions' | 'tasks'>,
  collectionId: string | null,
) {
  return {
    chats: data.sessions.filter((session) =>
      !session.archived && (!collectionId || session.collectionId === collectionId)
    ),
    tasks: filterKanbanTasks(data.tasks, collectionId),
  };
}

export function filterKanbanTasks(
  tasks: TaskEntity[],
  collectionId: string | null,
): TaskEntity[] {
  return tasks.filter((task) => {
    const isInCollection = !collectionId || task.collectionId === collectionId;
    return isInCollection;
  });
}
