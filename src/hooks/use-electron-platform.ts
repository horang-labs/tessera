'use client';

type ElectronApi = {
  isElectron?: boolean;
  platform?: string;
};

function getElectronApi(): ElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronApi }).electronAPI;
}

export function useElectronPlatform(): string | null {
  const electronApi = getElectronApi();
  return electronApi?.isElectron ? (electronApi.platform ?? null) : null;
}
