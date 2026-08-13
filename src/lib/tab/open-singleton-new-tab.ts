import { useTabStore } from '@/stores/tab-store';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';

/** Shared user command: dismiss transient workspace UI and open/reuse New Tab. */
export function openSingletonNewTab(): string {
  useWorkspacePeekStore.getState().close();
  return useTabStore.getState().openNewTab();
}
