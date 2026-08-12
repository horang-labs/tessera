import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import type { CollectionGroupData } from '@/lib/chat/build-collection-groups';
import type { RecentWorkItem } from '@/lib/chat/recent-work';
import type { ProjectGroup } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const EMPTY_SIDEBAR_TASKS: TaskEntity[] = [];

export function selectSidebarProjectTasks(
  state: {
    tasks: TaskEntity[];
    tasksByProject: Record<string, TaskEntity[]>;
  },
  selectedProjectDir: string | null,
): TaskEntity[] {
  if (!selectedProjectDir || selectedProjectDir === ALL_PROJECTS_SENTINEL) {
    return EMPTY_SIDEBAR_TASKS;
  }

  return state.tasksByProject[selectedProjectDir] ?? EMPTY_SIDEBAR_TASKS;
}

export function findSidebarProject(
  projects: ProjectGroup[],
  selectedProjectDir: string | null,
): ProjectGroup | null {
  if (!selectedProjectDir) return null;
  return projects.find((project) => project.encodedDir === selectedProjectDir) ?? null;
}

export function shouldShowAllProjectLoading({
  isExpanded,
  isRunningFilterActive,
  collectionsLoaded,
  tasksLoaded,
}: {
  isExpanded: boolean;
  isRunningFilterActive: boolean;
  collectionsLoaded: boolean;
  tasksLoaded: boolean;
}): boolean {
  // Mutation-driven refreshes keep the previous cache usable. Blocking the
  // section on a transient `loadingProjectIds` flag would replace those rows
  // with Loading... for every Worktree preparation update.
  if (!isExpanded) return false;
  if (!tasksLoaded) return true;
  return !isRunningFilterActive && !collectionsLoaded;
}

export function buildRecentWorkOrderedSessionIds(items: RecentWorkItem[]): string[] {
  return items.flatMap((item) =>
    item.type === 'task'
      ? item.task.sessions.map((session) => session.id)
      : [item.session.id],
  );
}

export function buildSidebarOrderedSessionIds({
  selectedProjectDir,
  allProjectsSessionIds,
  selectedProject,
  collectionGroups,
}: {
  selectedProjectDir: string | null;
  allProjectsSessionIds: readonly string[];
  selectedProject: ProjectGroup | null;
  collectionGroups: CollectionGroupData[] | null;
}): string[] {
  if (selectedProjectDir === ALL_PROJECTS_SENTINEL) {
    return [...allProjectsSessionIds];
  }

  if (!selectedProjectDir || !selectedProject || !collectionGroups) {
    return [];
  }

  const orderedIds: string[] = [];
  for (const group of collectionGroups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) {
        // Collection groups are the rendered Project-view projection. Linked
        // Worktree sessions can be present here without also appearing in the
        // direct Session projection, so filtering through selectedProject.sessions
        // makes visible rows disappear from Shift+Click ranges.
        orderedIds.push(session.id);
      }
    }

    for (const chat of group.chats) {
      orderedIds.push(chat.id);
    }
  }

  return orderedIds;
}
