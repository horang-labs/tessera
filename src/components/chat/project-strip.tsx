'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Home, Plus, Blocks, EyeOff, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { useTabStore } from '@/stores/tab-store';
import { ALL_PROJECTS_SENTINEL, getProjectColor } from '@/lib/constants/project-strip';
import { ARCHIVE_DASHBOARD_SESSION_ID, SKILLS_DASHBOARD_SESSION_ID } from '@/lib/constants/special-sessions';
import { useProjectStripDnd } from '@/hooks/use-project-strip-dnd';
import { usePopoutActive } from '@/hooks/use-popout-active';
import { PHONE_TOUCH_TARGET, PHONE_TOUCH_TARGET_WIDTH } from '@/lib/ui/touch-target';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { NotificationBell } from '@/components/notifications/notification-bell';
import SettingsButton from '@/components/settings/settings-button';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useI18n } from '@/lib/i18n';
import { FeedbackDialog } from '@/components/feedback/feedback-dialog';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { ProviderUsageRail } from './provider-usage-rail';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';

interface ProjectStripProps {
  onAddProject: () => void;
  onRemoveProject?: (encodedDir: string) => void;
  /**
   * When true, hide management actions that don't make sense in the popout
   * board window (add project, remove project, bottom action stack).
   */
  hideManagementActions?: boolean;
}

export function ProjectStrip({
  onAddProject,
  onRemoveProject,
  hideManagementActions = false,
}: ProjectStripProps) {
  const { t } = useI18n();
  const projects = useSessionStore((state) => state.projects);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const setSelectedProjectDir = useBoardStore((state) => state.setSelectedProjectDir);
  const electronPlatform = useElectronPlatform();
  const isMacElectron = electronPlatform === 'darwin';
  // The popout window only renders one project at a time, so the All
  // Projects sentinel doesn't make sense while it's open.
  const { isActive: isPopoutActive } = usePopoutActive();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; encodedDir: string; displayName: string } | null>(null);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, encodedDir: string, displayName: string) => {
    e.preventDefault();
    if (hideManagementActions) return;
    setContextMenu({ x: e.clientX, y: e.clientY, encodedDir, displayName });
  }, [hideManagementActions]);

  const handleProjectSelect = useCallback((projectDir: string) => {
    useWorkspacePeekStore.getState().close();
    setSelectedProjectDir(projectDir);
    useTabStore.getState().switchProject(projectDir);
  }, [setSelectedProjectDir]);

  // Close context menu on click outside or ESC
  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleClose, true);
    document.addEventListener('keydown', handleEsc, true);
    return () => {
      document.removeEventListener('mousedown', handleClose, true);
      document.removeEventListener('keydown', handleEsc, true);
    };
  }, [contextMenu]);

  const {
    draggingProjectDir,
    projectDragOverIndex,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragOver,
    handleProjectDragLeave,
    handleProjectDrop,
  } = useProjectStripDnd();

  // Per-project running session count for badges
  const runningCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of projects) {
      const count = p.sessions.filter((session) =>
        resolveSessionRuntimePresentation(session).showRunning
      ).length;
      if (count > 0) map.set(p.encodedDir, count);
    }
    return map;
  }, [projects]);

  const isAllMode = selectedProjectDir === ALL_PROJECTS_SENTINEL;

  return (
    <div className={cn(
      'shrink-0 w-11 flex flex-col border-r border-(--divider) bg-(--sidebar-bg)',
      PHONE_TOUCH_TARGET_WIDTH,
      // Phone override — the strip on 360px screens was consuming a solid 44px
      // column; users on the smallest font scale asked for it about a third
      // narrower. `max-sm:!w-8` beats the PHONE_TOUCH_TARGET_WIDTH `min-w-11`
      // by pinning an exact width rather than a floor.
      'max-sm:!w-8 max-sm:!min-w-0',
    )}>
      {isMacElectron && (
        <div
          className="electron-drag h-10 shrink-0 border-b border-(--chat-header-border) bg-(--chat-header-bg) select-none"
          data-testid="project-strip-mac-titlebar-spacer"
        />
      )}

      {/* Add project button */}
      {!hideManagementActions && (
        <Tooltip content={t('projectStrip.addProject')} delay={300}>
          <button
            onClick={onAddProject}
            className={cn(
              'w-11 h-9 flex items-center justify-center shrink-0 text-(--text-muted) hover:text-(--sidebar-text-active) transition-colors',
              PHONE_TOUCH_TARGET,
              'max-sm:!w-8 max-sm:!h-7 max-sm:!min-w-0 max-sm:!min-h-0',
            )}
            data-testid="project-strip-add"
          >
            <Plus className="w-4 h-4 max-sm:w-3 max-sm:h-3" />
          </button>
        </Tooltip>
      )}

      {/* All Projects button */}
      <Tooltip
        content={
          isPopoutActive
            ? t('projectStrip.allProjectsDisabledPopout')
            : t('projectStrip.allProjects')
        }
        delay={300}
      >
        <button
          onClick={() => {
            if (isPopoutActive) return;
            handleProjectSelect(ALL_PROJECTS_SENTINEL);
          }}
          disabled={isPopoutActive}
          aria-disabled={isPopoutActive}
          className={cn(
            'relative w-11 h-11 flex items-center justify-center shrink-0 transition-colors',
            PHONE_TOUCH_TARGET,
            'max-sm:!w-8 max-sm:!h-8 max-sm:!min-w-0 max-sm:!min-h-0',
            isAllMode
              ? 'text-(--accent)'
              : 'text-(--text-muted) hover:text-(--sidebar-text-active)',
            isPopoutActive && 'opacity-40 cursor-not-allowed hover:text-(--text-muted)',
          )}
          data-testid="project-strip-all"
        >
          {isAllMode && !isPopoutActive && (
            <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-(--accent)" />
          )}
          <Home className="w-5 h-5 max-sm:w-3.5 max-sm:h-3.5" />
        </button>
      </Tooltip>

      <div className="w-6 mx-auto border-t border-(--divider)" />

      {/* Project icon list.
          The bottom action stack (bell / skills / archive / feedback / settings /
          logout) is `shrink-0`, and on a short phone viewport those + the usage
          rail + the header take the whole column — a `min-h-0 flex-1` here
          collapses to 0 and the project tiles disappear entirely. Guaranteeing
          a few tiles worth of runway means the list is always reachable; the
          hidden overflow is what scrolling the strip is for. */}
      <ScrollArea
        className={cn(
          'flex-1 overflow-x-hidden overscroll-contain scrollbar-none',
          projects.length > 0 ? 'min-h-[6.5rem]' : 'min-h-0',
        )}
        data-testid="project-strip-scroll-area"
      >
        <div className="flex flex-col items-center gap-1 py-1">
          {projects.map((p, index) => {
            const color = getProjectColor(p.displayName);
            const isSelected = selectedProjectDir === p.encodedDir;
            const isDragging = draggingProjectDir === p.encodedDir;
            const isDragOver = projectDragOverIndex === index && draggingProjectDir !== p.encodedDir;
            const runningCount = runningCounts.get(p.encodedDir) ?? 0;
            const letter = p.displayName.charAt(0).toUpperCase();

            return (
              <Tooltip key={p.encodedDir} content={p.displayName} delay={300}>
                <button
                  draggable
                  onClick={() => handleProjectSelect(p.encodedDir)}
                  onContextMenu={(e) => handleContextMenu(e, p.encodedDir, p.displayName)}
                  onDragStart={(e) => handleProjectDragStart(p.encodedDir, e)}
                  onDragEnd={handleProjectDragEnd}
                  onDragOver={(e) => handleProjectDragOver(index, e)}
                  onDragLeave={(e) => handleProjectDragLeave(index, e)}
                  onDrop={(e) => handleProjectDrop(index, e)}
                  className={cn(
                    'relative w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                    'font-bold text-white text-xs select-none transition-all',
                    // Reporter asked the whole strip to shrink by a third at
                    // the smallest font scale; the tile follows suit at
                    // max-sm and the `!` beats PHONE_TOUCH_TARGET's floor.
                    // Runtime badge and selected marker are positioned
                    // against this same box, so they inherit the smaller
                    // tile without re-anchoring (#270 spirit preserved).
                    PHONE_TOUCH_TARGET,
                    'max-sm:!w-6 max-sm:!h-6 max-sm:!min-w-0 max-sm:!min-h-0 max-sm:text-[10px] max-sm:rounded-md',
                    isSelected ? 'opacity-100' : 'opacity-50 hover:opacity-80',
                    isDragging && 'opacity-30 scale-90',
                    isDragOver && 'ring-2 ring-(--accent) ring-offset-1 ring-offset-(--sidebar-bg)'
                  )}
                  style={{ backgroundColor: color }}
                  data-testid={`project-strip-${p.encodedDir}`}
                >
                  {isSelected && (
                    <div className="absolute -left-1.5 top-1 bottom-1 w-0.5 rounded-r bg-(--accent)" />
                  )}
                  {letter}
                  {runningCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full bg-green-500 text-white text-[9px] flex items-center justify-center px-0.5 font-bold leading-none max-sm:right-1 max-sm:top-1">
                      {runningCount > 9 ? '9+' : runningCount}
                    </span>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>

      <div className="w-6 mx-auto border-t border-(--divider)" />
      <ProviderUsageRail />

      {/* Global action icons */}
      {!hideManagementActions && (
      <div className="flex flex-col items-center shrink-0">
        <div className="w-6 border-t border-(--divider)" />
        <NotificationBell direction="right" />
        <Tooltip content={t('skill.dashboardTitle')} delay={300}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-none max-sm:!w-8 max-sm:!h-8 max-sm:!min-w-0 max-sm:!min-h-0"
            onClick={() => {
              const tabStore = useTabStore.getState();
              const existing = tabStore.findSessionLocation(SKILLS_DASHBOARD_SESSION_ID);
              if (existing) {
                tabStore.setActiveTab(existing.tabId);
              } else {
                tabStore.createTab(SKILLS_DASHBOARD_SESSION_ID);
              }
            }}
          >
            <Blocks className="w-5 h-5 max-sm:w-3.5 max-sm:h-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('archive.title')} delay={300}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-none max-sm:!w-8 max-sm:!h-8 max-sm:!min-w-0 max-sm:!min-h-0"
            onClick={() => {
              const tabStore = useTabStore.getState();
              const existing = tabStore.findSessionLocation(ARCHIVE_DASHBOARD_SESSION_ID);
              if (existing) {
                tabStore.setActiveTab(existing.tabId);
              } else {
                tabStore.createTab(ARCHIVE_DASHBOARD_SESSION_ID);
              }
            }}
            data-testid="project-strip-archive"
          >
            <Archive className="w-5 h-5 max-sm:w-3.5 max-sm:h-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('feedback.tooltip')} delay={300}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-none max-sm:!w-8 max-sm:!h-8 max-sm:!min-w-0 max-sm:!min-h-0"
            onClick={() => setIsFeedbackOpen(true)}
            data-testid="project-strip-feedback"
          >
            <MessageSquarePlus className="w-5 h-5 max-sm:w-3.5 max-sm:h-3.5" />
          </Button>
        </Tooltip>
        <SettingsButton className="rounded-none max-sm:!w-8 max-sm:!h-8 max-sm:!min-w-0 max-sm:!min-h-0" iconSize="lg" />
      </div>
      )}

      {/* Context menu portal */}
      {contextMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-[9999] min-w-[160px] rounded-lg bg-(--sidebar-bg) border border-(--divider) shadow-[0_8px_32px_rgba(0,0,0,0.24)] py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="px-3 py-1.5 text-[11px] text-(--text-muted) truncate max-w-[200px]">
            {contextMenu.displayName}
          </div>
          <div className="mx-1.5 border-t border-(--divider)" />
          <button
            onClick={() => {
              onRemoveProject?.(contextMenu.encodedDir);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-(--error) hover:bg-(--sidebar-hover) transition-colors text-left"
          >
            <EyeOff className="w-3.5 h-3.5" />
            {t('dialog.remove')}
          </button>
        </div>,
        document.body
      )}
      {isFeedbackOpen && (
        <FeedbackDialog
          source="project_strip"
          onClose={() => setIsFeedbackOpen(false)}
        />
      )}
    </div>
  );
}
