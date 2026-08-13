import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import {
  readUiStorageItem,
  removeUiStorageItem,
  writeUiStorageItem,
} from '@/lib/persistence/ui-storage';

/**
 * Zustand persistence backed by Tessera's origin-independent UI storage.
 *
 * In a browser this delegates to localStorage. In Electron the preload bridge
 * writes to `<dataDir>/ui-state.json`, so replacing or restarting the packaged
 * renderer cannot strand workspace state under an old localhost origin.
 */
const uiStateStorage: StateStorage = {
  getItem: (key) => readUiStorageItem(key),
  setItem: (key, value) => writeUiStorageItem(key, value),
  removeItem: (key) => removeUiStorageItem(key),
};

export function createUiJsonStorage<T>() {
  return createJSONStorage<T>(() => uiStateStorage);
}
