'use client';

import { useI18n } from '@/lib/i18n';
import type { SessionTabState } from '@/lib/workspace-tabs/session-tab-state';

export function SessionTabLabel({ state, grouped = false }: { state: SessionTabState; grouped?: boolean }) {
  const { t } = useI18n();
  if (state === 'closed') return null;
  const label = t(state === 'current' ? 'sessionTabs.current' : 'sessionTabs.open');
  const description = t(grouped ? (state === 'current' ? 'sessionTabs.containsCurrent' : 'sessionTabs.containsOpen') : state === 'current' ? 'sessionTabs.currentDescription' : 'sessionTabs.openDescription');
  return (
    <span className="session-tab-label" data-state={state} title={description} aria-label={description}>
      {label}
    </span>
  );
}
