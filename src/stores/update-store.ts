import { create } from 'zustand';
import type { UpdateCheckResponse } from '@/lib/update/types';
import type {
  DesktopUpdateEvent,
  DesktopUpdateProgress,
  DesktopUpdateResult,
  ElectronUpdaterApi,
} from '@/types/electron-updater';

const DISMISSED_VERSION_KEY = 'tessera:update:dismissed-version';

type UpdateStatus = 'idle' | 'checking' | UpdateCheckResponse['status'];
type DesktopUpdateStatus = 'idle' | DesktopUpdateResult['status'] | 'downloading';

interface UpdateState {
  status: UpdateStatus;
  desktopStatus: DesktopUpdateStatus;
  info: UpdateCheckResponse | null;
  desktopProgress: DesktopUpdateProgress | null;
  isDesktopUpdaterAvailable: boolean;
  error: string | null;
  dismissedVersion: string | null;
  toastShownVersion: string | null;
  isChecking: boolean;
  isDownloading: boolean;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  markToastShown: (version: string) => void;
  dismissVersion: (version: string) => void;
  clearDismissedVersion: () => void;
}

type ElectronWindow = Window & {
  electronAPI?: Partial<ElectronUpdaterApi> & {
    isElectron?: boolean;
  };
};

function readDismissedVersion(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DISMISSED_VERSION_KEY);
}

function writeDismissedVersion(version: string | null): void {
  if (typeof window === 'undefined') return;
  if (version) {
    window.localStorage.setItem(DISMISSED_VERSION_KEY, version);
  } else {
    window.localStorage.removeItem(DISMISSED_VERSION_KEY);
  }
}

function getElectronUpdaterApi(): ElectronUpdaterApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as ElectronWindow).electronAPI;
  if (
    typeof api?.checkForDesktopUpdate === 'function'
    && typeof api.downloadDesktopUpdate === 'function'
    && typeof api.installDesktopUpdate === 'function'
    && typeof api.onDesktopUpdateEvent === 'function'
  ) {
    return api as ElectronUpdaterApi;
  }
  return null;
}

function buildDesktopInfo(result: DesktopUpdateResult): UpdateCheckResponse {
  return {
    status: result.status === 'downloaded'
      ? 'available'
      : result.status === 'checking'
        ? 'current'
        : result.status,
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    updateAvailable: result.updateAvailable,
    source: 'github-release',
    channel: 'desktop',
    releaseUrl: result.latestVersion
      ? `https://github.com/horang-labs/tessera/releases/tag/v${result.latestVersion}`
      : 'https://github.com/horang-labs/tessera/releases',
    installCommand: null,
    checkedAt: new Date().toISOString(),
    error: result.error,
  };
}

function updateDesktopInfoFromResult(result: DesktopUpdateResult): Partial<UpdateState> {
  return {
    status: result.status === 'downloaded' ? 'available' : result.status,
    desktopStatus: result.status,
    info: buildDesktopInfo(result),
    error: result.error,
  };
}

function buildDesktopInfoFromEvent(
  event: DesktopUpdateEvent,
  currentInfo: UpdateCheckResponse | null,
): UpdateCheckResponse {
  const latestVersion = event.info?.version ?? currentInfo?.latestVersion ?? null;
  return buildDesktopInfo({
    status: event.type === 'downloaded' ? 'downloaded' : 'available',
    currentVersion: currentInfo?.currentVersion ?? '',
    updateAvailable: true,
    latestVersion,
    error: null,
  });
}

let desktopEventUnsubscribe: (() => void) | null = null;

function ensureDesktopEventSubscription(
  set: (partial: Partial<UpdateState>) => void,
  getState: () => UpdateState,
): boolean {
  const api = getElectronUpdaterApi();
  if (!api) return false;
  if (desktopEventUnsubscribe) return true;

  const maybeUnsubscribe = api.onDesktopUpdateEvent((event: DesktopUpdateEvent) => {
    if (event.type === 'checking') {
      set({ desktopStatus: 'checking', status: 'checking', error: null });
      return;
    }
    if (event.type === 'available') {
      const currentInfo = getState().info;
      set({
        desktopStatus: 'available',
        status: 'available',
        info: buildDesktopInfoFromEvent(event, currentInfo),
        error: null,
      });
      return;
    }
    if (event.type === 'not-available') {
      set({ desktopStatus: 'current', status: 'current', error: null });
      return;
    }
    if (event.type === 'progress') {
      set({ desktopStatus: 'downloading', isDownloading: true, desktopProgress: event.progress ?? null });
      return;
    }
    if (event.type === 'downloaded') {
      const currentInfo = getState().info;
      set({
        desktopStatus: 'downloaded',
        status: 'available',
        info: buildDesktopInfoFromEvent(event, currentInfo),
        isDownloading: false,
        desktopProgress: null,
        error: null,
      });
      return;
    }
    if (event.type === 'error') {
      set({
        desktopStatus: 'error',
        status: 'error',
        error: event.error ?? 'Desktop update failed',
        isChecking: false,
        isDownloading: false,
      });
    }
  });

  desktopEventUnsubscribe = typeof maybeUnsubscribe === 'function' ? maybeUnsubscribe : null;
  return true;
}

export function isUpdateVisible(state: Pick<UpdateState, 'info' | 'dismissedVersion'>): boolean {
  const latestVersion = state.info?.latestVersion;
  return Boolean(
    state.info?.updateAvailable
    && latestVersion
    && state.dismissedVersion !== latestVersion
  );
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  desktopStatus: 'idle',
  info: null,
  desktopProgress: null,
  isDesktopUpdaterAvailable: false,
  error: null,
  dismissedVersion: null,
  toastShownVersion: null,
  isChecking: false,
  isDownloading: false,

  checkForUpdates: async () => {
    if (get().isChecking) return;
    const desktopUpdaterAvailable = ensureDesktopEventSubscription(set, get);

    set({
      status: 'checking',
      desktopStatus: desktopUpdaterAvailable ? 'checking' : get().desktopStatus,
      isDesktopUpdaterAvailable: desktopUpdaterAvailable,
      isChecking: true,
      error: null,
      dismissedVersion: readDismissedVersion(),
    });

    try {
      const desktopApi = getElectronUpdaterApi();
      if (desktopApi) {
        const result = await desktopApi.checkForDesktopUpdate();
        if (result.status !== 'unsupported') {
          set({
            ...updateDesktopInfoFromResult(result),
            isChecking: false,
            isDesktopUpdaterAvailable: true,
            dismissedVersion: readDismissedVersion(),
          });
          return;
        }
        set({
          desktopStatus: 'unsupported',
          isDesktopUpdaterAvailable: false,
          desktopProgress: null,
        });
      }

      const response = await fetch('/api/update/check', {
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`Update check failed with status ${response.status}`);
      }

      const info = await response.json() as UpdateCheckResponse;
      set({
        status: info.status,
        info,
        error: info.error,
        isChecking: false,
        isDesktopUpdaterAvailable: false,
        dismissedVersion: readDismissedVersion(),
      });
    } catch (error) {
      set({
        status: 'error',
        desktopStatus: get().isDesktopUpdaterAvailable ? 'error' : get().desktopStatus,
        error: error instanceof Error ? error.message : 'Update check failed',
        isChecking: false,
        dismissedVersion: readDismissedVersion(),
      });
    }
  },

  downloadUpdate: async () => {
    const desktopApi = getElectronUpdaterApi();
    if (!desktopApi || get().isDownloading) return;

    ensureDesktopEventSubscription(set, get);
    set({
      desktopStatus: 'downloading',
      isDownloading: true,
      desktopProgress: null,
      error: null,
      isDesktopUpdaterAvailable: true,
    });

    const result = await desktopApi.downloadDesktopUpdate();
    set({
      ...updateDesktopInfoFromResult(result),
      isDownloading: false,
    });
  },

  installUpdate: async () => {
    const desktopApi = getElectronUpdaterApi();
    if (!desktopApi) return;
    await desktopApi.installDesktopUpdate();
  },

  markToastShown: (version) => set({ toastShownVersion: version }),

  dismissVersion: (version) => {
    writeDismissedVersion(version);
    set({ dismissedVersion: version });
  },

  clearDismissedVersion: () => {
    writeDismissedVersion(null);
    set({ dismissedVersion: null });
  },
}));
