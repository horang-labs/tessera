'use client';

import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useBoardStore } from '@/stores/board-store';

interface ElectronUiSyncApi {
  isElectron?: boolean;
  uiActiveSessionChanged?: (sessionId: string | null) => void;
  onUiActiveSessionChanged?: (cb: (sessionId: string | null) => void) => (() => void) | void;
  uiSelectedProjectChanged?: (projectDir: string | null) => void;
  onUiSelectedProjectChanged?: (cb: (projectDir: string | null) => void) => (() => void) | void;
}

function getApi(): ElectronUiSyncApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronUiSyncApi }).electronAPI;
}

/**
 * Mirror activeSessionId and selectedProjectDir between the main window and
 * any open popout boards. Bidirectional: any window's local UI change
 * broadcasts via IPC; the main process re-broadcasts to every other window
 * (see electron/main.ts handlers). A short-lived ref suppresses the
 * outbound echo when applying an inbound change so the windows don't
 * trade messages forever.
 */
export function useCrossWindowUiSync(): void {
  const suppressedSessionRef = useRef<string | null | undefined>(undefined);
  const suppressedProjectRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const api = getApi();
    if (!api?.isElectron) return;

    let prevSession = useSessionStore.getState().activeSessionId;
    let prevProject = useBoardStore.getState().selectedProjectDir;

    const unsubSession = useSessionStore.subscribe((state) => {
      const next = state.activeSessionId;
      if (next === prevSession) return;
      prevSession = next;
      if (suppressedSessionRef.current === next) {
        suppressedSessionRef.current = undefined;
        return;
      }
      api.uiActiveSessionChanged?.(next);
    });

    const unsubProject = useBoardStore.subscribe((state) => {
      const next = state.selectedProjectDir;
      if (next === prevProject) return;
      prevProject = next;
      if (suppressedProjectRef.current === next) {
        suppressedProjectRef.current = undefined;
        return;
      }
      api.uiSelectedProjectChanged?.(next);
    });

    return () => {
      unsubSession();
      unsubProject();
    };
  }, []);

  useEffect(() => {
    const api = getApi();
    if (!api?.isElectron) return;

    const offSession = api.onUiActiveSessionChanged?.((sessionId) => {
      const current = useSessionStore.getState().activeSessionId;
      if (current === sessionId) return;
      suppressedSessionRef.current = sessionId;
      useSessionStore.getState().setActiveSession(sessionId);
    });

    const offProject = api.onUiSelectedProjectChanged?.((projectDir) => {
      const current = useBoardStore.getState().selectedProjectDir;
      if (current === projectDir) return;
      suppressedProjectRef.current = projectDir;
      useBoardStore.getState().setSelectedProjectDir(projectDir);
    });

    return () => {
      if (typeof offSession === 'function') offSession();
      if (typeof offProject === 'function') offProject();
    };
  }, []);
}
