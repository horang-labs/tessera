/**
 * Which project's preparation script the editor opens on.
 *
 * The editor is reachable from more than one place, and they know different
 * amounts: a worktree's Scripts tab knows exactly which project it belongs to,
 * while opening settings from the sidebar knows only what is on screen. So the
 * answer is whatever the most specific caller said, and a fallback for the
 * rest — never nothing, as long as a project exists to edit.
 */

import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';

export function resolvePreparationProject({
  requested,
  boardSelection,
  projects,
}: {
  /** Named by whoever opened the editor, when they had a project in mind. */
  requested: string | null | undefined;
  /** The project strip's current selection, which may be all of them at once. */
  boardSelection: string | null | undefined;
  projects: ReadonlyArray<{ encodedDir: string }>;
}): string | null {
  const isRegistered = (candidate: string | null | undefined): candidate is string =>
    Boolean(candidate)
    && candidate !== ALL_PROJECTS_SENTINEL
    && projects.some((project) => project.encodedDir === candidate);

  if (isRegistered(requested)) return requested;
  if (isRegistered(boardSelection)) return boardSelection;
  return projects[0]?.encodedDir ?? null;
}
