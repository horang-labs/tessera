'use client';

import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { cn } from '@/lib/utils';

interface ElectronWindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

interface ElectronWindowControlApi {
  isElectron?: boolean;
  controlWindow?: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<void>;
  getWindowState?: () => Promise<ElectronWindowState>;
  onWindowStateChanged?: (callback: (state: ElectronWindowState) => void) => (() => void) | void;
}

interface ElectronWindowControlsProps {
  className?: string;
}

function getElectronApi(): ElectronWindowControlApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronWindowControlApi }).electronAPI;
}

export function ElectronWindowControls({ className }: ElectronWindowControlsProps) {
  const electronPlatform = useElectronPlatform();
  const [windowState, setWindowState] = useState<ElectronWindowState>({
    isMaximized: false,
    isFullScreen: false,
  });

  useEffect(() => {
    if (electronPlatform !== 'linux') return;

    const electronApi = getElectronApi();
    if (!electronApi?.isElectron) return;

    void electronApi.getWindowState?.().then(setWindowState).catch(() => {});
    return electronApi.onWindowStateChanged?.(setWindowState) ?? undefined;
  }, [electronPlatform]);

  if (electronPlatform !== 'linux') return null;

  const electronApi = getElectronApi();
  const controlWindow = electronApi?.controlWindow;
  const maximizeLabel = windowState.isMaximized ? 'Restore' : 'Maximize';
  const MaximizeIcon = windowState.isMaximized ? Minimize2 : Maximize2;

  return (
    <div
      className={cn('electron-no-drag flex h-[40px] shrink-0 items-stretch', className)}
      data-testid="electron-window-controls"
    >
      <button
        type="button"
        className="flex w-11 items-center justify-center text-(--electron-titlebar-muted) transition-colors hover:bg-(--electron-titlebar-hover) hover:text-(--electron-titlebar-text)"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void controlWindow?.('minimize')}
        data-testid="electron-window-minimize"
      >
        <Minus className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="flex w-11 items-center justify-center text-(--electron-titlebar-muted) transition-colors hover:bg-(--electron-titlebar-hover) hover:text-(--electron-titlebar-text)"
        title={maximizeLabel}
        aria-label={maximizeLabel}
        onClick={() => void controlWindow?.('toggle-maximize')}
        data-testid="electron-window-maximize"
      >
        <MaximizeIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="flex w-11 items-center justify-center text-(--electron-titlebar-muted) transition-colors hover:bg-[#d92d20] hover:text-white"
        title="Close"
        aria-label="Close"
        onClick={() => void controlWindow?.('close')}
        data-testid="electron-window-close"
      >
        <X className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
