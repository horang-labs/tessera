'use client';

import { useEffect, type MouseEvent } from 'react';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useSettingsStore } from '@/stores/settings-store';
import { useTabStore } from '@/stores/tab-store';

type TitlebarMenuSection = 'file' | 'edit' | 'view' | 'window' | 'help';

interface ElectronMenuAnchor {
  x: number;
  y: number;
}

interface ElectronApi {
  isElectron?: boolean;
  platform?: string;
  setTitlebarTheme?: (theme: 'light' | 'dark', options?: { dimmed?: boolean }) => void;
  popupTitlebarMenu?: (section: TitlebarMenuSection, anchor: ElectronMenuAnchor) => Promise<void>;
  onTitlebarMenuCommand?: (callback: (command: string) => void) => (() => void) | void;
}

interface ElectronTitlebarProps {
  showMenu?: boolean;
}

const MENU_SECTIONS: Array<{ key: TitlebarMenuSection; label: string }> = [
  { key: 'file', label: 'File' },
  { key: 'edit', label: 'Edit' },
  { key: 'view', label: 'View' },
  { key: 'window', label: 'Window' },
  { key: 'help', label: 'Help' },
];

const WINDOWS_TITLEBAR_HEIGHT_PX = 40;

function getElectronApi(): ElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronApi }).electronAPI;
}

function useElectronTitlebarThemeSync(isWindowsElectron: boolean) {
  const isSettingsOpen = useSettingsStore((state) => state.isOpen);

  useEffect(() => {
    if (!isWindowsElectron) return;

    const electronApi = getElectronApi();
    const setTitlebarTheme = electronApi?.setTitlebarTheme;
    if (!setTitlebarTheme) return;

    const applyTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setTitlebarTheme(isDark ? 'dark' : 'light', { dimmed: isSettingsOpen });
    };

    applyTheme();

    const observer = new MutationObserver(() => {
      applyTheme();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observer.disconnect();
    };
  }, [isWindowsElectron, isSettingsOpen]);
}

export function ElectronTitlebarThemeSync() {
  const isWindowsElectron = useElectronPlatform() === 'win32';
  useElectronTitlebarThemeSync(isWindowsElectron);
  return null;
}

export function ElectronTitlebar({ showMenu = true }: ElectronTitlebarProps) {
  const electronPlatform = useElectronPlatform();
  const isWindowsElectron = electronPlatform === 'win32';
  useElectronTitlebarThemeSync(isWindowsElectron);

  useEffect(() => {
    if (!showMenu) return;

    const electronApi = getElectronApi();
    const platform = electronApi?.isElectron ? (electronApi.platform ?? null) : null;

    const supported = Boolean(
      electronApi?.isElectron &&
      platform === 'win32' &&
      electronApi.popupTitlebarMenu
    );

    if (!supported || !electronApi?.onTitlebarMenuCommand) return;

    return electronApi.onTitlebarMenuCommand((command) => {
      switch (command) {
        case 'new-tab':
          useTabStore.getState().createTab();
          break;
        case 'open-settings':
          useSettingsStore.getState().open();
          break;
        case 'toggle-sidebar':
          useSettingsStore.getState().toggleSidebar();
          break;
        default:
          break;
      }
    });
  }, [showMenu]);

  if (!isWindowsElectron) return null;

  async function handleMenuOpen(
    section: TitlebarMenuSection,
    event: MouseEvent<HTMLButtonElement>
  ) {
    const electronApi = getElectronApi();
    if (!electronApi?.popupTitlebarMenu) return;

    const rect = event.currentTarget.getBoundingClientRect();
    await electronApi.popupTitlebarMenu(section, {
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
  }

  return (
    <header
      className="electron-drag shrink-0 px-3 pr-[152px] border-b flex items-center gap-1.5 bg-(--electron-titlebar-bg) border-(--electron-titlebar-border) text-(--electron-titlebar-text) select-none"
      style={{ height: WINDOWS_TITLEBAR_HEIGHT_PX }}
      data-testid="electron-titlebar"
    >
      <div className="flex items-center gap-2.5 min-w-0 mr-2">
        <div className="w-5 h-5 rounded-md bg-(--accent) text-white text-[11px] font-semibold flex items-center justify-center shadow-sm">
          T
        </div>
        <span className="text-[13px] font-semibold tracking-[-0.01em] truncate">
          Tessera
        </span>
      </div>

      {showMenu ? (
        <nav className="flex items-center gap-0.5 min-w-0" aria-label="Application menu">
          {MENU_SECTIONS.map((section) => (
            <button
              key={section.key}
              type="button"
              className="electron-no-drag h-7 px-2.5 rounded-md text-[12px] font-medium text-(--electron-titlebar-muted) hover:text-(--electron-titlebar-text) hover:bg-(--electron-titlebar-hover) transition-colors flex items-center gap-1"
              onClick={(event) => handleMenuOpen(section.key, event)}
            >
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <div className="ml-auto min-w-0" />
    </header>
  );
}
