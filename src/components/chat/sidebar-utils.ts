import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import type { CollectionGroupData } from '@/lib/chat/build-collection-groups';
import type { ProjectGroup } from '@/types/chat';

export function findSidebarProject(
  projects: ProjectGroup[],
  selectedProjectDir: string | null,
): ProjectGroup | null {
  if (!selectedProjectDir) return null;
  return projects.find((project) => project.encodedDir === selectedProjectDir) ?? null;
}

export function buildSidebarOrderedSessionIds({
  selectedProjectDir,
  projects,
  selectedProject,
  collectionGroups,
}: {
  selectedProjectDir: string | null;
  projects: ProjectGroup[];
  selectedProject: ProjectGroup | null;
  collectionGroups: CollectionGroupData[] | null;
}): string[] {
  if (selectedProjectDir === ALL_PROJECTS_SENTINEL) {
    return projects.flatMap((project) =>
      project.sessions
        .filter((session) => !session.archived)
        .slice()
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
        .map((session) => session.id),
    );
  }

  if (!selectedProjectDir || !selectedProject || !collectionGroups) {
    return [];
  }

  const visibleSessionIds = new Set(
    selectedProject.sessions
      .filter((session) => !session.archived)
      .map((session) => session.id),
  );

  const orderedIds: string[] = [];
  for (const group of collectionGroups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) {
        if (visibleSessionIds.has(session.id)) {
          orderedIds.push(session.id);
        }
      }
    }

    for (const chat of group.chats) {
      orderedIds.push(chat.id);
    }
  }

  return orderedIds;
}
