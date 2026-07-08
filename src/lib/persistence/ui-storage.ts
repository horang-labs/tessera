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
    return electronApi.uiStorageGetItem(key);
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
    electronApi.uiStorageSetItem(key, value);
    return;
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
    electronApi.uiStorageRemoveItem(key);
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
