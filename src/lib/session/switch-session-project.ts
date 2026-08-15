import { useBoardStore } from '@/stores/board-store';
import { useTabStore } from '@/stores/tab-store';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';

/**
 * Move global navigation to the Session's representative origin Project before opening it.
 *
 * `findSessionLocation` only sees the tabs of the current scope, so opening a session
 * from another project without switching first both misses the tab it is already in and
 * creates a new one under the project the user happens to be looking at.
 *
 * All Projects mode already lists every project's sessions, so switching out of it would
 * narrow a view the user deliberately chose — that scope is left untouched.
 *
 * Returns false when the switch was refused (unsaved peek file); callers should then
 * abort rather than open the session under the wrong project.
 */
export function switchToSessionProject(projectDir: string | null | undefined): boolean {
  if (!projectDir) return true;

  const boardStore = useBoardStore.getState();
  const current = boardStore.selectedProjectDir;
  // null = project selection has not initialized yet; leave it to chat-layout.
  if (current === null || current === ALL_PROJECTS_SENTINEL || current === projectDir) return true;

  boardStore.setSelectedProjectDir(projectDir);
  if (useBoardStore.getState().selectedProjectDir !== projectDir) return false;

  // The board-store → tab-store bridge effect only runs after the next render, so switch
  // here as well to make the target project's tabs visible to the caller right away.
  useTabStore.getState().switchProject(projectDir);
  return true;
}
