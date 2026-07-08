import { create } from 'zustand';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import {
  readUiStorageItem,
  removeUiStorageItem,
  writeUiStorageItem,
} from '@/lib/persistence/ui-storage';

export type ViewMode = 'list' | 'board';

interface BoardState {
  // View mode for the selected project. Persisted per project below.
  viewMode: ViewMode;
  projectViewModes: Record<string, ViewMode>;
  setViewMode: (mode: ViewMode) => void;

  // Kanban drag-and-drop state
  draggingTaskId: string | null;
  dragOverStatus: string | null;
  setDragging: (taskId: string | null) => void;
  setDragOver: (status: string | null) => void;

  // Session reorder drop indicator (within same status group)
  dropIndicator: { targetSessionId: string; position: 'before' | 'after' } | null;
  setDropIndicator: (indicator: { targetSessionId: string; position: 'before' | 'after' } | null) => void;

  // Post-drop highlight (briefly highlights the card that was just reordered)
  justDroppedId: string | null;
  flashDrop: (sessionId: string) => void;

  // Collection group collapse state (sidebar collection view)
  collapsedCollections: Record<string, boolean>;
  toggleCollectionCollapse: (colId: string) => void;
  setCollectionCollapsed: (colId: string, collapsed: boolean) => void;

  // All Projects sidebar section expansion state (defaults collapsed on app start)
  allProjectsExpandedSections: Record<string, boolean>;
  toggleAllProjectsSection: (projectId: string) => void;
  setAllProjectsSectionExpanded: (projectId: string, expanded: boolean) => void;
  setAllProjectsSectionsExpanded: (projectIds: string[], expanded: boolean) => void;

  // List view session filter (false = all, true = running)
  isListRunningFilterActive: boolean;
  setListRunningFilterActive: (active: boolean) => void;

  // Kanban quick create sheet — tracks which column's sheet is open (null = closed)
  kanbanAddMenuColumn: string | null;
  setKanbanAddMenuColumn: (column: string | null) => void;

  // Project strip drag-and-drop state
  draggingProjectDir: string | null;
  projectDragOverIndex: number | null;
  setDraggingProject: (dir: string | null) => void;
  setProjectDragOverIndex: (index: number | null) => void;

  // Selected project (project selector)
  selectedProjectDir: string | null;
  setSelectedProjectDir: (dir: string | null) => void;

  /** Collection filter for kanban board (null = show all) */
  activeCollectionFilter: string | null;
  setCollectionFilter: (id: string | null) => void;

  // Collection item DnD state (sidebar collection view)
  draggingCollectionItem: {
    type: 'task' | 'chat';
    id: string;
    collectionId: string | null;
    projectId: string;
  } | null;
  dragOverCollectionId: string | null; // collection ID or '__uncategorized'
  collectionDropIndicator: { targetId: string; position: 'before' | 'after' } | null;
  setDraggingCollectionItem: (item: {
    type: 'task' | 'chat';
    id: string;
    collectionId: string | null;
    projectId: string;
  } | null) => void;
  setDragOverCollection: (colId: string | null) => void;
  setCollectionDropIndicator: (indicator: { targetId: string; position: 'before' | 'after' } | null) => void;

  // Collection group reorder DnD state
  draggingCollectionGroupId: string | null;
  collectionGroupDragOverIndex: number | null;
  setDraggingCollectionGroup: (id: string | null) => void;
  setCollectionGroupDragOverIndex: (index: number | null) => void;
}

// localStorage keys for persistence
const VIEW_MODE_KEY = 'ccw:viewMode';
const PROJECT_VIEW_MODES_KEY = 'ccw:projectViewModes';
const COLLAPSED_COLLECTIONS_KEY = 'ccw:collapsedCollections';
const SELECTED_PROJECT_DIR_KEY = 'ccw:selectedProjectDir';
const ALL_PROJECTS_EXPANDED_SECTIONS_KEY = 'ccw:allProjectsExpandedSections';
const LIST_RUNNING_FILTER_KEY = 'ccw:listRunningFilterActive';
const ACTIVE_COLLECTION_FILTER_KEY = 'ccw:activeCollectionFilter';

function isViewMode(value: unknown): value is ViewMode {
  return value === 'list' || value === 'board';
}

function loadViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'list';
  try {
    const saved = readUiStorageItem(VIEW_MODE_KEY);
    if (isViewMode(saved)) return saved;
    return 'list';
  } catch {
    return 'list';
  }
}

function loadProjectViewModes(): Record<string, ViewMode> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(readUiStorageItem(PROJECT_VIEW_MODES_KEY) ?? '{}') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};

    const modes: Record<string, ViewMode> = {};
    for (const [projectDir, mode] of Object.entries(parsed)) {
      if (typeof projectDir === 'string' && projectDir.length > 0 && isViewMode(mode)) {
        modes[projectDir] = mode;
      }
    }
    return modes;
  } catch {
    return {};
  }
}

function saveProjectViewModes(modes: Record<string, ViewMode>): void {
  if (typeof window === 'undefined') return;
  try {
    writeUiStorageItem(PROJECT_VIEW_MODES_KEY, JSON.stringify(modes));
  } catch {
    // ignore
  }
}

function loadCollapsedCollections(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(readUiStorageItem(COLLAPSED_COLLECTIONS_KEY) ?? '{}') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};

    const collapsed: Record<string, boolean> = {};
    for (const [scopeKey, value] of Object.entries(parsed)) {
      if (typeof scopeKey === 'string' && scopeKey.length > 0 && typeof value === 'boolean') {
        collapsed[scopeKey] = value;
      }
    }
    return collapsed;
  } catch {
    return {};
  }
}

function saveCollapsedCollections(collapsed: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    writeUiStorageItem(COLLAPSED_COLLECTIONS_KEY, JSON.stringify(collapsed));
  } catch {
    // ignore
  }
}

function loadBooleanRecord(key: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(readUiStorageItem(key) ?? '{}') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};

    const record: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof id === 'string' && id.length > 0 && typeof value === 'boolean') {
        record[id] = value;
      }
    }
    return record;
  } catch {
    return {};
  }
}

function saveBooleanRecord(key: string, record: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    writeUiStorageItem(key, JSON.stringify(record));
  } catch {
    // ignore
  }
}

function loadNullableString(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = readUiStorageItem(key);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveNullableString(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value && value.length > 0) {
      writeUiStorageItem(key, value);
    } else {
      removeUiStorageItem(key);
    }
  } catch {
    // ignore
  }
}

function loadBooleanFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return readUiStorageItem(key) === 'true';
  } catch {
    return false;
  }
}

function saveBooleanFlag(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    writeUiStorageItem(key, value ? 'true' : 'false');
  } catch {
    // ignore
  }
}

function resolveProjectViewMode(
  projectDir: string | null,
  projectViewModes: Record<string, ViewMode>,
  fallback: ViewMode,
): ViewMode {
  if (projectDir === ALL_PROJECTS_SENTINEL) return 'list';
  if (projectDir && projectViewModes[projectDir]) return projectViewModes[projectDir];
  return fallback;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  viewMode: loadViewMode(),
  projectViewModes: loadProjectViewModes(),
  setViewMode: (mode) => {
    // All Projects mode only supports list view — block board switch
    if (mode === 'board' && get().selectedProjectDir === ALL_PROJECTS_SENTINEL) return;
    if (get().viewMode === mode) return;
    set((state) => {
      const nextProjectViewModes =
        state.selectedProjectDir && state.selectedProjectDir !== ALL_PROJECTS_SENTINEL
          ? {
              ...state.projectViewModes,
              [state.selectedProjectDir]: mode,
            }
          : state.projectViewModes;

      try { writeUiStorageItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
      if (nextProjectViewModes !== state.projectViewModes) {
        saveProjectViewModes(nextProjectViewModes);
      }

      return {
        viewMode: mode,
        projectViewModes: nextProjectViewModes,
      };
    });
    void captureTelemetryEvent('workspace_view_changed', {
      view: mode === 'board' ? 'kanban' : 'list',
    });
  },

  draggingTaskId: null,
  dragOverStatus: null,
  setDragging: (taskId) =>
    set((state) => ({
      draggingTaskId: taskId,
      // When drag ends (null), reset dragOverStatus to prevent stale hover state
      dragOverStatus: taskId === null ? null : state.dragOverStatus,
      // Reset drop indicator when drag ends
      dropIndicator: taskId === null ? null : state.dropIndicator,
    })),
  setDragOver: (status) => set({ dragOverStatus: status }),

  dropIndicator: null,
  setDropIndicator: (indicator) => set({ dropIndicator: indicator }),

  justDroppedId: null,
  flashDrop: (sessionId) => {
    set({ justDroppedId: sessionId });
    setTimeout(() => {
      if (get().justDroppedId === sessionId) set({ justDroppedId: null });
    }, 1100);
  },

  collapsedCollections: loadCollapsedCollections(),
  toggleCollectionCollapse: (colId) =>
    set((state) => {
      const collapsedCollections = {
        ...state.collapsedCollections,
        [colId]: !state.collapsedCollections[colId],
      };
      saveCollapsedCollections(collapsedCollections);
      return { collapsedCollections };
    }),
  setCollectionCollapsed: (colId, collapsed) =>
    set((state) => {
      const collapsedCollections = {
        ...state.collapsedCollections,
        [colId]: collapsed,
      };
      saveCollapsedCollections(collapsedCollections);
      return { collapsedCollections };
    }),

  allProjectsExpandedSections: loadBooleanRecord(ALL_PROJECTS_EXPANDED_SECTIONS_KEY),
  toggleAllProjectsSection: (projectId) =>
    set((state) => {
      const allProjectsExpandedSections = {
        ...state.allProjectsExpandedSections,
        [projectId]: !state.allProjectsExpandedSections[projectId],
      };
      saveBooleanRecord(ALL_PROJECTS_EXPANDED_SECTIONS_KEY, allProjectsExpandedSections);
      return { allProjectsExpandedSections };
    }),
  setAllProjectsSectionExpanded: (projectId, expanded) =>
    set((state) => {
      const allProjectsExpandedSections = {
        ...state.allProjectsExpandedSections,
        [projectId]: expanded,
      };
      saveBooleanRecord(ALL_PROJECTS_EXPANDED_SECTIONS_KEY, allProjectsExpandedSections);
      return { allProjectsExpandedSections };
    }),
  setAllProjectsSectionsExpanded: (projectIds, expanded) =>
    set((state) => {
      const next = { ...state.allProjectsExpandedSections };
      for (const projectId of projectIds) {
        next[projectId] = expanded;
      }
      saveBooleanRecord(ALL_PROJECTS_EXPANDED_SECTIONS_KEY, next);
      return { allProjectsExpandedSections: next };
    }),

  isListRunningFilterActive: loadBooleanFlag(LIST_RUNNING_FILTER_KEY),
  setListRunningFilterActive: (active) => {
    saveBooleanFlag(LIST_RUNNING_FILTER_KEY, active);
    set({ isListRunningFilterActive: active });
  },

  kanbanAddMenuColumn: null,
  setKanbanAddMenuColumn: (column) => set({ kanbanAddMenuColumn: column }),

  draggingProjectDir: null,
  projectDragOverIndex: null,
  setDraggingProject: (dir) =>
    set({ draggingProjectDir: dir, projectDragOverIndex: dir === null ? null : get().projectDragOverIndex }),
  setProjectDragOverIndex: (index) => set({ projectDragOverIndex: index }),

  selectedProjectDir: loadNullableString(SELECTED_PROJECT_DIR_KEY),
  setSelectedProjectDir: (dir) => {
    set((state) => {
      const nextProjectViewModes =
        state.selectedProjectDir && state.selectedProjectDir !== ALL_PROJECTS_SENTINEL
          ? {
              ...state.projectViewModes,
              [state.selectedProjectDir]: state.viewMode,
            }
          : state.projectViewModes;

      return {
        selectedProjectDir: dir,
        projectViewModes: nextProjectViewModes,
        viewMode: resolveProjectViewMode(dir, nextProjectViewModes, state.viewMode),
      };
    });
    const { projectViewModes, viewMode } = get();
    saveNullableString(SELECTED_PROJECT_DIR_KEY, dir);
    try { writeUiStorageItem(VIEW_MODE_KEY, viewMode); } catch { /* ignore */ }
    saveProjectViewModes(projectViewModes);
  },

  activeCollectionFilter: loadNullableString(ACTIVE_COLLECTION_FILTER_KEY),
  setCollectionFilter: (id) => {
    saveNullableString(ACTIVE_COLLECTION_FILTER_KEY, id);
    set({ activeCollectionFilter: id });
  },

  // Collection item DnD
  draggingCollectionItem: null,
  dragOverCollectionId: null,
  collectionDropIndicator: null,
  setDraggingCollectionItem: (item) =>
    set({
      draggingCollectionItem: item,
      // Reset related state when drag ends
      ...(item === null && { dragOverCollectionId: null, collectionDropIndicator: null }),
    }),
  setDragOverCollection: (colId) => set({ dragOverCollectionId: colId }),
  setCollectionDropIndicator: (indicator) => set({ collectionDropIndicator: indicator }),

  // Collection group reorder DnD
  draggingCollectionGroupId: null,
  collectionGroupDragOverIndex: null,
  setDraggingCollectionGroup: (id) =>
    set({ draggingCollectionGroupId: id, collectionGroupDragOverIndex: id === null ? null : get().collectionGroupDragOverIndex }),
  setCollectionGroupDragOverIndex: (index) => set({ collectionGroupDragOverIndex: index }),
}));
