import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserSettings } from '@/lib/settings/types';
import type { ServerHostInfo } from '@/lib/system/types';
import { DEFAULT_SETTINGS } from '@/lib/settings/defaults';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import { i18n } from '@/lib/i18n';
import { useBoardStore, type ViewMode } from '@/stores/board-store';

export const SETTINGS_STORAGE_KEY = 'tessera:settings';
export const SETTINGS_SYNC_CHANNEL = 'tessera:settings-sync';

export const LIST_SIDEBAR_MIN_WIDTH = 280;
export const LIST_SIDEBAR_DEFAULT_WIDTH = 420;
export const BOARD_SIDEBAR_MIN_WIDTH = 600;
export const BOARD_SIDEBAR_DEFAULT_WIDTH = 600;

type SidebarWidths = Record<ViewMode, number>;
type ProjectSidebarWidths = Record<string, Partial<SidebarWidths>>;

export interface UpdateSettingsOptions {
  confirmArchivedWorktreePrune?: boolean;
}

function normalizeSidebarWidth(
  width: number | undefined,
  fallback: number,
  minWidth: number,
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return fallback;
  return Math.max(width, minWidth);
}

function normalizeOptionalSidebarWidth(
  width: unknown,
  minWidth: number,
): number | undefined {
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  return Math.max(width, minWidth);
}

export function buildSidebarWidths(
  persistedSidebarWidths?: Partial<SidebarWidths>,
  legacySidebarWidth?: number,
): SidebarWidths {
  const legacyListWidth = normalizeSidebarWidth(
    legacySidebarWidth,
    LIST_SIDEBAR_MIN_WIDTH,
    LIST_SIDEBAR_MIN_WIDTH,
  );

  return {
    list: normalizeSidebarWidth(
      persistedSidebarWidths?.list,
      legacyListWidth,
      LIST_SIDEBAR_MIN_WIDTH,
    ),
    board: normalizeSidebarWidth(
      persistedSidebarWidths?.board,
      Math.max(legacyListWidth, BOARD_SIDEBAR_MIN_WIDTH),
      BOARD_SIDEBAR_MIN_WIDTH,
    ),
  };
}

function buildProjectSidebarWidths(
  persistedProjectSidebarWidths?: ProjectSidebarWidths,
): ProjectSidebarWidths {
  if (!persistedProjectSidebarWidths || typeof persistedProjectSidebarWidths !== 'object') {
    return {};
  }

  const result: ProjectSidebarWidths = {};
  for (const [projectDir, widths] of Object.entries(persistedProjectSidebarWidths)) {
    if (!projectDir || !widths || typeof widths !== 'object') continue;

    const list = normalizeOptionalSidebarWidth(widths.list, LIST_SIDEBAR_MIN_WIDTH);
    const board = normalizeOptionalSidebarWidth(widths.board, BOARD_SIDEBAR_MIN_WIDTH);
    const normalized: Partial<SidebarWidths> = {};
    if (list !== undefined) normalized.list = list;
    if (board !== undefined) normalized.board = board;
    if (Object.keys(normalized).length > 0) result[projectDir] = normalized;
  }

  return result;
}

function syncI18nLanguage(language: UserSettings['language']): void {
  void i18n.changeLanguage(language);
}

interface SettingsSyncMessage {
  type: 'settings-updated';
  settings: UserSettings;
  /** Identifies the originating tab so it can ignore its own broadcast (see below). */
  senderId: string;
}

/**
 * Unique per-tab id. Two BroadcastChannel objects in the SAME window still receive
 * each other's messages (only the exact sender object is excluded), so without this
 * a tab would re-apply its own settings snapshot asynchronously — replacing the
 * settings object mid-edit and resetting the caret in any focused settings field.
 * Receivers drop messages carrying this id; cross-tab sync (different id) still works.
 */
export const SETTINGS_SYNC_SENDER_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

let settingsSyncChannel: BroadcastChannel | null = null;

function getSettingsSyncChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') {
    return null;
  }
  settingsSyncChannel ??= new window.BroadcastChannel(SETTINGS_SYNC_CHANNEL);
  return settingsSyncChannel;
}

function broadcastSettingsSnapshot(settings: UserSettings): void {
  try {
    getSettingsSyncChannel()?.postMessage({
      type: 'settings-updated',
      settings,
      senderId: SETTINGS_SYNC_SENDER_ID,
    } satisfies SettingsSyncMessage);
  } catch {
    // Best effort only. Other windows can still pick up persisted settings.
  }
}

export function isSettingsSyncMessage(message: unknown): message is SettingsSyncMessage {
  if (!message || typeof message !== 'object') return false;
  const value = message as Partial<SettingsSyncMessage>;
  return value.type === 'settings-updated'
    && Boolean(value.settings)
    && typeof value.settings === 'object'
    && typeof value.senderId === 'string';
}

interface SettingsState {
  settings: UserSettings;
  serverHostInfo: ServerHostInfo | null;
  isOpen: boolean;
  isLoading: boolean;
  pendingSaveCount: number;

  // REQ-007: Sidebar toggle state
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // REQ-002: Sidebar resize state
  sidebarWidths: SidebarWidths;
  projectSidebarWidths: ProjectSidebarWidths;
  sidebarWidth: number;
  getSidebarWidth: (mode: ViewMode, projectDir?: string | null) => number;
  setSidebarWidth: (width: number, mode?: ViewMode, projectDir?: string | null) => void;

  open: () => void;
  close: () => void;
  updateSettings: (partial: Partial<UserSettings>, options?: UpdateSettingsOptions) => Promise<void>;
  reset: () => Promise<void>;
  load: () => Promise<void>;
  applyExternalSettings: (settings: UserSettings) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      serverHostInfo: null,
      isOpen: false,
      isLoading: false,
      pendingSaveCount: 0,
      sidebarCollapsed: false, // BR-TOGGLE-001: 기본 펼침
      sidebarWidths: {
        list: LIST_SIDEBAR_MIN_WIDTH,
        board: BOARD_SIDEBAR_MIN_WIDTH,
      },
      projectSidebarWidths: {},
      sidebarWidth: LIST_SIDEBAR_MIN_WIDTH, // 레거시 호환용 alias (list width)

      open: () => set({ isOpen: true }),
      close: () => {
        if (get().pendingSaveCount > 0) return;
        set({ isOpen: false });
      },
      applyExternalSettings: (externalSettings) => {
        const settings = normalizeUserSettings(externalSettings);
        set({ settings });
        syncI18nLanguage(settings.language);
      },

      // REQ-007: Sidebar toggle
      toggleSidebar: () => {
        const collapsed = !get().sidebarCollapsed;
        if (collapsed && !useBoardStore.getState().closeSessionPeek()) return;
        set({ sidebarCollapsed: collapsed });
      },
      setSidebarCollapsed: (collapsed) => {
        if (collapsed && !useBoardStore.getState().closeSessionPeek()) return;
        set({ sidebarCollapsed: collapsed });
      },

      // REQ-002: Sidebar resize
      getSidebarWidth: (mode, projectDir) => {
        const state = get();
        const projectWidth = projectDir
          ? state.projectSidebarWidths[projectDir]?.[mode]
          : undefined;
        return projectWidth ?? state.sidebarWidths[mode];
      },
      setSidebarWidth: (width, mode = 'list', projectDir) =>
        set((state) => {
          const minWidth =
            mode === 'board' ? BOARD_SIDEBAR_MIN_WIDTH : LIST_SIDEBAR_MIN_WIDTH;
          const nextWidth = Math.max(width, minWidth);
          if (projectDir) {
            return {
              projectSidebarWidths: {
                ...state.projectSidebarWidths,
                [projectDir]: {
                  ...state.projectSidebarWidths[projectDir],
                  [mode]: nextWidth,
                },
              },
            };
          }

          const sidebarWidths = {
            ...state.sidebarWidths,
            [mode]: nextWidth,
          };
          return {
            sidebarWidth: sidebarWidths.list,
            sidebarWidths,
          };
        }),

      updateSettings: async (partial, options) => {
        const prior = get().settings;
        if (
          partial.kanbanSessionOpenMode
          && partial.kanbanSessionOpenMode !== prior.kanbanSessionOpenMode
          && partial.kanbanSessionOpenMode !== 'peek'
          && !useBoardStore.getState().closeSessionPeek()
        ) return;
        const updated = normalizeUserSettings({
          ...prior,
          ...partial,
          lastModified: new Date().toISOString(),
        });

        set((state) => ({
          settings: updated,
          pendingSaveCount: state.pendingSaveCount + 1,
        }));
        broadcastSettingsSnapshot(updated);

        if (partial.language) {
          syncI18nLanguage(updated.language);
        }

        let saved = false;
        try {
          const requestBody = options?.confirmArchivedWorktreePrune
            ? { ...updated, confirmArchivedWorktreePrune: true }
            : updated;
          const response = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          });
          if (!response.ok) {
            throw new Error(`Settings save failed with status ${response.status}`);
          }
          saved = true;
        } catch (error) {
          console.error('Failed to save settings to server', error);
          set({ settings: prior });
          broadcastSettingsSnapshot(prior);
          if (partial.language) {
            syncI18nLanguage(prior.language);
          }
        } finally {
          set((state) => ({
            pendingSaveCount: Math.max(0, state.pendingSaveCount - 1),
          }));
        }

        // Environment and CLI command overrides change which binaries are reachable.
        if (
          saved
          && (
            (partial.agentEnvironment && partial.agentEnvironment !== prior.agentEnvironment)
            || partial.cliCommandOverrides
          )
        ) {
          const { useProvidersStore } = await import('@/stores/providers-store');
          useProvidersStore.getState().refresh();
        }
      },

      reset: async () => {
        const prior = get().settings;
        const defaults = normalizeUserSettings({
          ...DEFAULT_SETTINGS,
          lastModified: new Date().toISOString(),
        });

        set({ settings: defaults });
        broadcastSettingsSnapshot(defaults);
        syncI18nLanguage(defaults.language);

        try {
          const response = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaults),
          });
          if (!response.ok) {
            throw new Error(`Settings reset failed with status ${response.status}`);
          }
        } catch (error) {
          console.error('Failed to reset settings', error);
          set({ settings: prior });
          broadcastSettingsSnapshot(prior);
          syncI18nLanguage(prior.language);
        }
      },

      load: async () => {
        set({ isLoading: true });

        try {
          const response = await fetch('/api/settings');
          if (response.ok) {
            const data = await response.json();
            const settings = normalizeUserSettings(data.settings);
            set({
              settings,
              serverHostInfo: data.serverHostInfo ?? null,
              isLoading: false,
            });
            syncI18nLanguage(settings.language);
          } else {
            set({ isLoading: false });
          }
        } catch (error) {
          console.error('Failed to load settings', error);
          set({ isLoading: false });
        }
      },
    }),
    {
      name: 'tessera:settings',
      partialize: (state) => ({
        settings: state.settings,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        sidebarWidths: state.sidebarWidths,
        projectSidebarWidths: state.projectSidebarWidths,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsState> | undefined;
        const sidebarWidths = buildSidebarWidths(p?.sidebarWidths, p?.sidebarWidth);
        const projectSidebarWidths = buildProjectSidebarWidths(p?.projectSidebarWidths);
        return {
          ...current,
          ...p,
          sidebarWidth: sidebarWidths.list,
          sidebarWidths,
          projectSidebarWidths,
          // Merge defaults into persisted settings so new fields are never undefined
          settings: normalizeUserSettings(p?.settings as Partial<UserSettings> | undefined),
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        syncI18nLanguage(state.settings.language);
      },
    }
  )
);
