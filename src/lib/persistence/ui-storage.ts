interface ElectronUiStorageApi {
  isElectron?: boolean;
  uiStorageGetItem?: (key: string) => string | null;
  uiStorageSetItem?: (key: string, value: string) => void;
  uiStorageRemoveItem?: (key: string) => void;
}

function getElectronUiStorageApi(): ElectronUiStorageApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronUiStorageApi }).electronAPI;
}

export function readUiStorageItem(key: string): string | null {
  if (typeof window === 'undefined') return null;

  const electronApi = getElectronUiStorageApi();
  if (electronApi?.isElectron && electronApi.uiStorageGetItem) {
    try {
      const persisted = electronApi.uiStorageGetItem(key);
      if (persisted !== null) return persisted;

      // One-time migration for UI stores that predate the Electron bridge.
      // Their values live under the current renderer origin; copy them into
      // ui-state.json before a future build/port change makes them unreachable.
      const legacy = window.localStorage.getItem(key);
      if (legacy !== null) {
        electronApi.uiStorageSetItem?.(key, legacy);
        return legacy;
      }
      return null;
    } catch {
      // Fall back to browser storage below.
    }
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeUiStorageItem(key: string, value: string): void {
  if (typeof window === 'undefined') return;

  const electronApi = getElectronUiStorageApi();
  if (electronApi?.isElectron && electronApi.uiStorageSetItem) {
    try {
      electronApi.uiStorageSetItem(key, value);
      return;
    } catch {
      // Fall back to browser storage below.
    }
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function removeUiStorageItem(key: string): void {
  if (typeof window === 'undefined') return;

  const electronApi = getElectronUiStorageApi();
  if (electronApi?.isElectron && electronApi.uiStorageRemoveItem) {
    try {
      electronApi.uiStorageRemoveItem(key);
      return;
    } catch {
      // Fall back to browser storage below.
    }
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
