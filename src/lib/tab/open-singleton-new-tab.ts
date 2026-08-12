import { useTabStore } from '@/stores/tab-store';

/** Shared command behind every user-facing New Tab entry point. */
export function openSingletonNewTab(): string {
  return useTabStore.getState().openNewTab();
}
