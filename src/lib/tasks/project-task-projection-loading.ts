import type { ProjectGroup } from '@/types/chat';

export function getProjectIdsMissingTaskProjection(
  projects: Array<Pick<ProjectGroup, 'encodedDir'>>,
  loadedProjects: Record<string, boolean>,
  loadingProjects: Record<string, boolean>,
  attemptedProjectIds: ReadonlySet<string>,
): string[] {
  return projects
    .map((project) => project.encodedDir)
    .filter((projectId) =>
      !loadedProjects[projectId]
      && !loadingProjects[projectId]
      && !attemptedProjectIds.has(projectId)
    );
}
