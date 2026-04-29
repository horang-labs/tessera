import { create } from 'zustand';
import type { Collection } from '@/types/collection';
import { useSessionStore } from './session-store';
import { useTaskStore } from './task-store';

interface LoadCollectionsOptions {
  setCurrent?: boolean;
}

interface CollectionState {
  /** Collections for the currently focused project (kept for existing consumers) */
  collections: Collection[];
  /** Cached collections keyed by project ID for all-project views */
  collectionsByProject: Record<string, Collection[]>;
  /** Whether the current project's collections have been loaded */
  loaded: boolean;
  /** Per-project load marker for cached collection data */
  loadedProjects: Record<string, boolean>;
  /** Project whose collections are currently exposed via `collections` */
  currentProjectId: string | null;
  /** In-flight collection fetches keyed by project ID */
  loadingProjectIds: Record<string, boolean>;

  /** Fetch collections for a project from API */
  loadCollections: (projectId: string, options?: LoadCollectionsOptions) => Promise<void>;
  /** Create a new collection in a project */
  addCollection: (projectId: string, label: string, color: string) => Promise<Collection | null>;
  /** Update a collection's label or color */
  updateCollection: (id: string, label: string, color: string) => Promise<boolean>;
  /** Delete a collection (resets collection_id to null for its tasks and sessions) */
  deleteCollection: (id: string) => Promise<{ movedCount: number } | null>;
  /** Optimistically replace a project's cached collection list */
  setCollectionsForProject: (projectId: string, collections: Collection[]) => void;
  /** Read cached collections for a specific project */
  getCollectionsForProject: (projectId: string) => Collection[];
  /** Get config for a collection by ID (returns null if not found) */
  getCollectionConfig: (id: string) => { label: string; color: string } | null;
}

function mapCollectionRow(row: {
  id: string;
  project_id: string;
  label: string;
  color: string;
  sort_order: number;
}): Collection {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    color: row.color,
    sortOrder: row.sort_order,
  };
}

function updateProjectCache(
  state: CollectionState,
  projectId: string,
  projectCollections: Collection[],
  syncCurrentProject: boolean
) {
  return {
    collectionsByProject: {
      ...state.collectionsByProject,
      [projectId]: projectCollections,
    },
    loadedProjects: {
      ...state.loadedProjects,
      [projectId]: true,
    },
    ...(syncCurrentProject
      ? {
          collections: projectCollections,
          currentProjectId: projectId,
          loaded: true,
        }
      : {}),
  };
}

function removeProjectLoadingFlag(state: CollectionState, projectId: string) {
  const nextLoading = { ...state.loadingProjectIds };
  delete nextLoading[projectId];
  return nextLoading;
}

function findCollectionProjectId(state: CollectionState, collectionId: string): string | null {
  for (const [projectId, collections] of Object.entries(state.collectionsByProject)) {
    if (collections.some((collection) => collection.id === collectionId)) {
      return projectId;
    }
  }

  if (state.currentProjectId && state.collections.some((collection) => collection.id === collectionId)) {
    return state.currentProjectId;
  }

  return null;
}

export const useCollectionStore = create<CollectionState>((set, get) => ({
  collections: [],
  collectionsByProject: {},
  loaded: false,
  loadedProjects: {},
  currentProjectId: null,
  loadingProjectIds: {},

  loadCollections: async (projectId, options) => {
    const shouldSetCurrent = options?.setCurrent !== false;
    const currentState = get();

    if (currentState.loadedProjects[projectId]) {
      if (shouldSetCurrent) {
        set({
          collections: currentState.collectionsByProject[projectId] ?? [],
          currentProjectId: projectId,
          loaded: true,
        });
      }
      return;
    }

    if (currentState.loadingProjectIds[projectId]) {
      if (shouldSetCurrent) {
        set({
          currentProjectId: projectId,
          loaded: false,
        });
      }
      return;
    }

    set((state) => ({
      loadingProjectIds: {
        ...state.loadingProjectIds,
        [projectId]: true,
      },
      ...(shouldSetCurrent
        ? {
            currentProjectId: projectId,
            loaded: false,
          }
        : {}),
    }));

    try {
      const res = await fetch(`/api/collections?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;

      const data = await res.json();
      const projectCollections: Collection[] = (data.collections ?? []).map(mapCollectionRow);

      set((state) => ({
        ...updateProjectCache(
          state,
          projectId,
          projectCollections,
          shouldSetCurrent || state.currentProjectId === projectId
        ),
      }));
    } catch {
      // Silently fail — collections will just not appear
    } finally {
      set((state) => ({
        loadingProjectIds: removeProjectLoadingFlag(state, projectId),
      }));
    }
  },

  addCollection: async (projectId, label, color) => {
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, label, color }),
      });
      if (!res.ok) return null;

      const data = await res.json();
      const collection = mapCollectionRow(data.collection);

      set((state) => {
        const projectCollections = [...(state.collectionsByProject[projectId] ?? []), collection];
        return {
          ...updateProjectCache(
            state,
            projectId,
            projectCollections,
            state.currentProjectId === projectId
          ),
        };
      });

      return collection;
    } catch {
      return null;
    }
  },

  updateCollection: async (id, label, color) => {
    const state = get();
    const projectId = findCollectionProjectId(state, id);
    if (!projectId) return false;

    const prevProjectCollections = state.collectionsByProject[projectId] ?? [];
    const nextProjectCollections = prevProjectCollections.map((collection) =>
      collection.id === id ? { ...collection, label, color } : collection
    );

    set((currentState) => ({
      ...updateProjectCache(
        currentState,
        projectId,
        nextProjectCollections,
        currentState.currentProjectId === projectId
      ),
    }));

    try {
      const res = await fetch(`/api/collections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, color }),
      });

      if (!res.ok) {
        set((currentState) => ({
          ...updateProjectCache(
            currentState,
            projectId,
            prevProjectCollections,
            currentState.currentProjectId === projectId
          ),
        }));
        return false;
      }

      return true;
    } catch {
      set((currentState) => ({
        ...updateProjectCache(
          currentState,
          projectId,
          prevProjectCollections,
          currentState.currentProjectId === projectId
        ),
      }));
      return false;
    }
  },

  deleteCollection: async (id) => {
    const state = get();
    const projectId = findCollectionProjectId(state, id);
    if (!projectId) return null;

    const prevProjectCollections = state.collectionsByProject[projectId] ?? [];
    const nextProjectCollections = prevProjectCollections.filter((collection) => collection.id !== id);

    set((currentState) => ({
      ...updateProjectCache(
        currentState,
        projectId,
        nextProjectCollections,
        currentState.currentProjectId === projectId
      ),
    }));

    try {
      const res = await fetch(`/api/collections/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        set((currentState) => ({
          ...updateProjectCache(
            currentState,
            projectId,
            prevProjectCollections,
            currentState.currentProjectId === projectId
          ),
        }));
        return null;
      }

      const data = await res.json();
      useTaskStore.getState().replaceCollectionId(id, null);
      useSessionStore.getState().replaceCollectionId(id, null);
      return { movedCount: data.movedCount ?? 0 };
    } catch {
      set((currentState) => ({
        ...updateProjectCache(
          currentState,
          projectId,
          prevProjectCollections,
          currentState.currentProjectId === projectId
        ),
      }));
      return null;
    }
  },

  setCollectionsForProject: (projectId, collections) => {
    set((state) => ({
      ...updateProjectCache(
        state,
        projectId,
        collections,
        state.currentProjectId === projectId
      ),
    }));
  },

  getCollectionsForProject: (projectId) => get().collectionsByProject[projectId] ?? [],

  getCollectionConfig: (id) => {
    const projectId = findCollectionProjectId(get(), id);
    if (!projectId) return null;

    const collection = get().collectionsByProject[projectId]?.find((item) => item.id === id);
    if (!collection) return null;

    return { label: collection.label, color: collection.color };
  },
}));
