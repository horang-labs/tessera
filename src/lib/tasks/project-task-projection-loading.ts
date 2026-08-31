import type { ProjectGroup } from '@/types/chat';

export function getProjectIdsMissingTaskProjection(
  projects: ReadonlyArray<Pick<ProjectGroup, 'encodedDir'>>,
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

/** Load All Projects task projections in display order without request fan-out. */
export async function loadProjectTaskProjectionsSequentially(
  projectIds: readonly string[],
  loadProject: (projectId: string) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  for (const projectId of projectIds) {
    if (!shouldContinue()) return;
    await loadProject(projectId);
  }
}
