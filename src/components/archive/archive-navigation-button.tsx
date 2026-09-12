'use client';

import { Archive, Loader2 } from 'lucide-react';
import { useArchiveRetentionProgress, isArchiveRetentionActive } from '@/hooks/use-archive-retention-progress';
import { useI18n } from '@/lib/i18n';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useTabStore } from '@/stores/tab-store';
import { ARCHIVE_DASHBOARD_SESSION_ID } from '@/lib/constants/special-sessions';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

export function ArchiveNavigationButton() {
  const { t } = useI18n();
  const retention = useArchiveRetentionProgress();
  const retentionActive = isArchiveRetentionActive(retention);
  const archiveLabel = retentionActive && retention
    ? retention.phase === 'scanning'
      ? t('archive.retentionProgress.scanning')
      : t('archive.retentionProgress.running', { completed: retention.completed, total: retention.total })
    : t('archive.title');
  return (
    <Tooltip content={archiveLabel} delay={300}>
      <Button
        {...telemetryClickAttributes('sidebar.archive.open', 'sidebar')}
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
        aria-label={archiveLabel}
      >
        <span className="relative">
          <Archive className="w-5 h-5 max-sm:w-3.5 max-sm:h-3.5" />
          {retentionActive && (
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-(--sidebar-bg) text-(--accent)" data-testid="archive-retention-spinner">
              <span className="block motion-safe:animate-spin"><Loader2 className="h-3 w-3" aria-hidden="true" /></span>
            </span>
          )}
        </span>
      </Button>
    </Tooltip>
  );
}
