'use client';

import { memo } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useBoardStore } from '@/stores/board-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ViewModeToggle } from '@/components/tab/view-mode-toggle';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { saveCurrentKanbanScrollPosition } from '@/lib/kanban-scroll-position';
import type { ViewMode } from '@/stores/board-store';

/**
 * AppHeader — global navigation header.
 *
 * [ViewModeToggle]
 * Action icons (Terminal, Bell, Skills, Settings, Logout) moved to ProjectStrip bottom.
 */
export const AppHeader = memo(function AppHeader() {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isMacElectron = electronPlatform === 'darwin';
  const isWindowsElectron = electronPlatform === 'win32';

  // Board store
  const viewMode = useBoardStore((state) => state.viewMode);
  const setViewMode = useBoardStore((state) => state.setViewMode);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const activeCollectionFilter = useBoardStore((state) => state.activeCollectionFilter);
  // Sidebar collapse
  const toggleSidebar = useSettingsStore((state) => state.toggleSidebar);
  const sidebarWidth = useSettingsStore(
    (state) => state.getSidebarWidth(viewMode, selectedProjectDir),
  );

  const handleViewModeChange = (nextMode: ViewMode) => {
    if (viewMode === 'board') {
      saveCurrentKanbanScrollPosition(selectedProjectDir, activeCollectionFilter);
    }
    setViewMode(nextMode);
  };

  return (
    <>
      <header
        className={cn(
          'shrink-0 flex items-center gap-2 px-3 h-10 border-b border-(--divider) bg-(--sidebar-bg)',
          isWindowsElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
          isMacElectron && 'electron-drag pl-[84px] bg-(--chat-header-bg) border-b-(--chat-header-border) select-none'
        )}
        data-testid="app-header"
      >
        {/* View Mode Toggle */}
        <div className={cn('shrink-0', (isMacElectron || isWindowsElectron) && 'electron-no-drag')}>
          <ViewModeToggle viewMode={viewMode} onToggle={handleViewModeChange} compact={sidebarWidth < 340} />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sidebar collapse button */}
        <ShortcutTooltip id="toggle-sidebar" label={t('shortcut.toggleSidebar')}>
          <button
            onClick={toggleSidebar}
            className={cn(
              'shrink-0 p-1 rounded hover:bg-(--sidebar-hover) text-(--text-muted) hover:text-(--text-primary) transition-colors',
              (isMacElectron || isWindowsElectron) && 'electron-no-drag'
            )}
            aria-label={t('sidebar.collapse')}
            data-testid="sidebar-collapse-btn"
          >
            <PanelLeftClose size={16} />
          </button>
        </ShortcutTooltip>
      </header>
    </>
  );
});
