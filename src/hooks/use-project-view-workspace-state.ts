'use client';
'use no memo';

// The adapter resolves from mutable Zustand stores after these subscriptions fire.
// React Compiler must not cache the imperative reads only by the explicit Session/View IDs.
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { useCollectionStore } from '@/stores/collection-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';

/**
 * Subscribe React consumers to every backing store owned by the workspace-state
 * boundary. Callers then resolve through the boundary instead of treating one
 * store as canonical.
 */
function useProjectViewWorkspaceStateSubscription(): void {
  useSessionStore((state) => state.projects);
  useSessionStore((state) => state.retainedSessions);
  useTaskStore((state) => state.tasksByProject);
  useCollectionStore((state) => state.collectionsByProject);
}

export function useLoadedProjectViews(): readonly ProjectGroup[] {
  useProjectViewWorkspaceStateSubscription();
  return projectViewWorkspaceState.getLoadedProjectViews();
}

export function useProjectViewSession(
  sessionId: string | null | undefined,
  projectViewId?: string | null,
): UnifiedSession | undefined {
  useProjectViewWorkspaceStateSubscription();
  return sessionId
    ? projectViewWorkspaceState.resolveSession(sessionId, projectViewId ?? undefined)
    : undefined;
}

export function useProjectViewSessions(
  sessionIds: readonly string[],
  projectViewId?: string | null,
): UnifiedSession[] {
  useProjectViewWorkspaceStateSubscription();
  return sessionIds.flatMap((sessionId) => {
    const session = projectViewWorkspaceState.resolveSession(
      sessionId,
      projectViewId ?? undefined,
    );
    return session ? [session] : [];
  });
}

export function useCanonicalProjectViewSessions(): UnifiedSession[] {
  useProjectViewWorkspaceStateSubscription();
  return projectViewWorkspaceState.getCanonicalSessions();
}

export function useCanonicalRunningProjectViewSessions(): UnifiedSession[] {
  useProjectViewWorkspaceStateSubscription();
  return projectViewWorkspaceState.getCanonicalRunningSessions();
}

export function useOriginProjectRepresentation(): ReturnType<
  typeof projectViewWorkspaceState.getOriginProjectRepresentation
> {
  useProjectViewWorkspaceStateSubscription();
  return projectViewWorkspaceState.getOriginProjectRepresentation();
}

export function useProjectViewRepresentation(
  projectViewId: string | null | undefined,
): ReturnType<typeof projectViewWorkspaceState.getProjectViewRepresentation> {
  useProjectViewWorkspaceStateSubscription();
  return projectViewId
    ? projectViewWorkspaceState.getProjectViewRepresentation(projectViewId)
    : undefined;
}
