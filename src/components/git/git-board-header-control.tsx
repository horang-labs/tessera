'use client';

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/git-store';
import { GitDesktopDeliveryControl, supportsDesktopGitControl } from './git-desktop-commit-control';
import { useSharedGitPanelController } from './git-panel-controller-context';

/** Git delivery/status surface for the full-width Kanban header. */
export function GitBoardHeaderControl() {
  const { t } = useI18n();
  const controller = useSharedGitPanelController();
  const gitPanelOpen = useGitStore((state) => state.isOpen);
  const toggleGitPanel = useGitStore((state) => state.toggle);

  const showDeliveryStatus = supportsDesktopGitControl(
    controller.data,
    controller.hasActiveSession,
  );

  return (
    <div
      className="hidden h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-(--divider) sm:flex"
      data-testid="kanban-git-header-control"
    >
      {showDeliveryStatus ? <GitDesktopDeliveryControl /> : null}
      <button
        type="button"
        onClick={toggleGitPanel}
        aria-label={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
        aria-pressed={gitPanelOpen}
        title={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
        className={cn(
          'flex h-full w-9 shrink-0 items-center justify-center border-l border-(--divider)',
          'text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)',
          gitPanelOpen && 'bg-(--accent)/14 text-(--accent)',
        )}
        data-testid="kanban-git-panel-toggle"
      >
        {gitPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </div>
  );
}
