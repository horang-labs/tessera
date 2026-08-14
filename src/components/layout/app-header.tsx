'use client';

import { memo } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { useEffectiveViewMode } from '@/hooks/use-effective-view-mode';
import { useSettingsStore } from '@/stores/settings-store';
import { useGitStore } from '@/stores/git-store';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { ElectronWindowControls } from '@/components/layout/electron-window-controls';
import { ProjectViewModeToggle } from '@/components/tab/project-view-mode-toggle';
import { GitBoardHeaderControl } from '@/components/git/git-board-header-control';

/**
 * AppHeader — project context header for the left panel.
 *
 * Action icons (Terminal, Bell, Skills, Settings, Logout) moved to ProjectStrip bottom.
 */
export const AppHeader = memo(function AppHeader() {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isMacElectron = electronPlatform === 'darwin';
  const isWindowsElectron = electronPlatform === 'win32';
  const isLinuxElectron = electronPlatform === 'linux';
  const isElectronTitlebar = isMacElectron || isWindowsElectron || isLinuxElectron;

  // Sidebar collapse
  const toggleSidebar = useSettingsStore((state) => state.toggleSidebar);
  const kanbanSessionOpenMode = useSettingsStore(
    (state) => state.settings.kanbanSessionOpenMode,
  );
  const gitPanelOpen = useGitStore((state) => state.isOpen);
  const isPhoneViewport = usePhoneViewport();
  // The list is what a phone renders, so the header's board chrome goes with it.
  const viewMode = useEffectiveViewMode();
  const isKanbanPeekMode = viewMode === 'board' && kanbanSessionOpenMode === 'peek';

  return (
    <>
      <header
        className={cn(
          'shrink-0 flex h-9 items-center border-b border-(--divider) bg-(--sidebar-bg)',
          // The collapse control is 44px tall at Phone viewport, which a fixed
          // 36px bar would clip (#259). Electron's own titlebar heights below
          // are desktop-only and untouched.
          'max-sm:h-auto',
          isWindowsElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
          isLinuxElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
          isMacElectron && 'electron-drag h-10 bg-(--chat-header-bg) border-b-(--chat-header-border) select-none'
        )}
        data-testid="app-header"
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3',
            isElectronTitlebar && 'self-stretch',
            isMacElectron && 'pl-10',
            // Peek mode stretches the header across the window, so it has to
            // clear the native window controls the tab bar normally clears.
            isKanbanPeekMode && isWindowsElectron && !gitPanelOpen && 'pr-[152px]',
          )}
        >
          {/* Project identity already lives in the rail and the Worktree row.
              Keep this titlebar focused on switching the current Project view. */}
          {!isPhoneViewport ? (
            <ProjectViewModeToggle
              className={isElectronTitlebar ? 'electron-no-drag' : undefined}
              labelMode="short"
            />
          ) : null}

          {/* Preserve a draggable titlebar lane after moving Project context out
              of the header. The controls on either side remain electron-no-drag. */}
          <div
            className={cn(
              'min-w-0 flex-1',
              // The empty flex item must occupy real titlebar area. Without a
              // cross-axis size it is 0px tall, so clicks land on the non-drag
              // layout container behind it instead of a native drag region.
              isElectronTitlebar && 'electron-drag min-w-12 self-stretch',
            )}
            data-testid="app-header-drag-lane"
          />

          {isKanbanPeekMode ? (
            // Lift above the Session Peek backdrop (z-50) so Git controls stay
            // clickable while a peek is open.
            <div className="relative z-[60] electron-no-drag">
              <GitBoardHeaderControl />
            </div>
          ) : null}

          {!isKanbanPeekMode ? (
            <ShortcutTooltip id="toggle-sidebar" label={t('shortcut.toggleSidebar')}>
              <button
                onClick={toggleSidebar}
                className={cn(
                  'shrink-0 rounded p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
                  PHONE_TOUCH_TARGET,
                  isElectronTitlebar && 'electron-no-drag',
                )}
                aria-label={t('sidebar.collapse')}
                data-testid="sidebar-collapse-btn"
              >
                <PanelLeftClose size={16} />
              </button>
            </ShortcutTooltip>
          ) : null}
        </div>
        {isKanbanPeekMode && isLinuxElectron && !gitPanelOpen ? <ElectronWindowControls /> : null}
      </header>
    </>
  );
});
