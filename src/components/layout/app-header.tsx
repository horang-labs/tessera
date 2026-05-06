'use client';

import { memo } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useSettingsStore } from '@/stores/settings-store';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { ALL_PROJECTS_SENTINEL, getProjectColor } from '@/lib/constants/project-strip';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { ProjectViewModeToggle } from '@/components/tab/project-view-mode-toggle';

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
  const isElectronTitlebar = isMacElectron || isWindowsElectron;

  // Sidebar collapse
  const toggleSidebar = useSettingsStore((state) => state.toggleSidebar);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const projects = useSessionStore((state) => state.projects);
  const selectedProject = projects.find((project) => project.encodedDir === selectedProjectDir) ?? null;
  const isAllProjects = selectedProjectDir === ALL_PROJECTS_SENTINEL;
  const projectDisplayName = isAllProjects
    ? t('projectStrip.allProjects')
    : selectedProject?.displayName ?? '';
  const projectTitle = isAllProjects
    ? t('projectStrip.allProjects')
    : selectedProject?.displayPath ?? selectedProject?.decodedPath ?? projectDisplayName;
  const projectInitial = projectDisplayName.trim().charAt(0).toUpperCase() || '?';
  const shouldShowProjectContext = isAllProjects || selectedProject !== null;

  return (
    <>
      <header
        className={cn(
          'shrink-0 flex h-9 items-center border-b border-(--divider) bg-(--sidebar-bg)',
          isWindowsElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
          isMacElectron && 'electron-drag h-10 bg-(--chat-header-bg) border-b-(--chat-header-border) select-none'
        )}
        data-testid="app-header"
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3',
            isMacElectron && 'pl-10',
          )}
        >
          {shouldShowProjectContext ? (
            <>
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[0.6875rem] font-bold leading-none text-white shadow-sm"
                style={{ backgroundColor: getProjectColor(projectDisplayName) }}
                aria-hidden="true"
              >
                {projectInitial}
              </div>
              <div className="min-w-0 flex-1" title={projectTitle}>
                <div className="truncate text-[0.875rem] font-semibold leading-5 text-(--sidebar-text-active)">
                  {projectDisplayName}
                </div>
              </div>
              <ProjectViewModeToggle
                className={isElectronTitlebar ? 'electron-no-drag' : undefined}
                labelMode="short"
              />
            </>
          ) : (
            <div className="flex-1" />
          )}

          {/* Sidebar collapse button */}
          <ShortcutTooltip id="toggle-sidebar" label={t('shortcut.toggleSidebar')}>
            <button
              onClick={toggleSidebar}
              className={cn(
                'shrink-0 rounded p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
                isElectronTitlebar && 'electron-no-drag',
              )}
              aria-label={t('sidebar.collapse')}
              data-testid="sidebar-collapse-btn"
            >
              <PanelLeftClose size={16} />
            </button>
          </ShortcutTooltip>
        </div>
      </header>
    </>
  );
});
