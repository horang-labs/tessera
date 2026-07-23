'use client';

import { memo } from 'react';
import { PanelLeftClose, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useSettingsStore } from '@/stores/settings-store';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { useGitStore } from '@/stores/git-store';
import { ALL_PROJECTS_SENTINEL, getProjectColor } from '@/lib/constants/project-strip';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { ElectronWindowControls } from '@/components/layout/electron-window-controls';
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
  const isLinuxElectron = electronPlatform === 'linux';
  const isElectronTitlebar = isMacElectron || isWindowsElectron || isLinuxElectron;

  // Sidebar collapse
  const toggleSidebar = useSettingsStore((state) => state.toggleSidebar);
  const kanbanSessionOpenMode = useSettingsStore(
    (state) => state.settings.kanbanSessionOpenMode,
  );
  const gitPanelOpen = useGitStore((state) => state.isOpen);
  const toggleGitPanel = useGitStore((state) => state.toggle);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const viewMode = useBoardStore((state) => state.viewMode);
  const isKanbanPeekMode = viewMode === 'board' && kanbanSessionOpenMode === 'peek';
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
          isLinuxElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
          isMacElectron && 'electron-drag h-10 bg-(--chat-header-bg) border-b-(--chat-header-border) select-none'
        )}
        data-testid="app-header"
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3',
            isMacElectron && 'pl-10',
            // Peek mode stretches the header across the window, so it has to
            // clear the native window controls the tab bar normally clears.
            isKanbanPeekMode && isWindowsElectron && !gitPanelOpen && 'pr-[152px]',
          )}
        >
          {shouldShowProjectContext ? (
            <>
              <div
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[0.6875rem] font-bold leading-none text-white shadow-sm',
                  isElectronTitlebar && 'electron-drag pointer-events-none',
                )}
                style={{ backgroundColor: getProjectColor(projectDisplayName) }}
                aria-hidden="true"
              >
                {projectInitial}
              </div>
              <div
                className={cn(
                  'min-w-0',
                  // In peek mode the header spans the full window, so the project
                  // name must not absorb the free space — the spacer below does.
                  isKanbanPeekMode ? 'shrink' : 'flex-1',
                  isElectronTitlebar && 'electron-drag pointer-events-none',
                )}
                title={projectTitle}
              >
                <div className="truncate text-[0.875rem] font-semibold leading-5 text-(--sidebar-text-active)">
                  {projectDisplayName}
                </div>
              </div>
              <ProjectViewModeToggle
                className={isElectronTitlebar ? 'electron-no-drag' : undefined}
                labelMode="short"
              />
              {isKanbanPeekMode ? (
                <>
                  <div
                    className={cn(
                      'min-w-0 flex-1',
                      isElectronTitlebar && 'electron-drag',
                    )}
                  />
                  <button
                    type="button"
                    onClick={toggleGitPanel}
                    className={cn(
                      // Lift above the Session Peek backdrop (z-50) so the panel
                      // toggle stays clickable while a peek is open — otherwise the
                      // backdrop swallows the click and light-dismisses the peek.
                      'relative z-[60] electron-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--divider) transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
                      gitPanelOpen
                        ? 'bg-(--accent)/14 text-(--accent)'
                        : 'bg-(--chat-bg) text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
                    )}
                    aria-label={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
                    aria-pressed={gitPanelOpen}
                    title={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
                    data-testid="kanban-git-panel-toggle"
                  >
                    {gitPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <div className="flex-1" />
          )}

          {!isKanbanPeekMode ? (
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
          ) : null}
        </div>
        {isKanbanPeekMode && isLinuxElectron && !gitPanelOpen ? <ElectronWindowControls /> : null}
      </header>
    </>
  );
});
