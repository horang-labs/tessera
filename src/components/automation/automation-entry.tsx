'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useState } from 'react';
import { useStore } from 'zustand';
import { useI18n } from '@/lib/i18n';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { AutomationManager } from './automation-manager';
import { AutomationError } from './automation-error';
import { automationButton } from './ownership-actions';
import { useAutomationOwnership, useAutomationStore } from './use-automation';

function Entry({ scope, store, supported = true, currentId }: { scope: AutomationScope; store: AutomationStoreApi; supported?: boolean; currentId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { materializeSession } = useSessionNavigation();
  const { handleSessionClick } = useSessionClickHandlers();
  return <>
    <button {...telemetryClickAttributes('sessionId' in scope ? 'automation.open.wake' : 'automation.open.schedule', 'sessionId' in scope ? 'chat_header' : 'worktree')} className={automationButton} type="button" onClick={() => setOpen(true)}>{t(currentId ? 'automation.details' : 'sessionId' in scope ? 'automation.wake' : 'automation.schedule')}</button>
    {open && <AutomationManager scope={scope} store={store} initialId={currentId} supported={supported} onClose={() => setOpen(false)} onOpenSession={async id => {
      const session = await materializeSession(id);
      if (!session) { store.setState({ error: 'SESSION_UNAVAILABLE' }); return; }
      setOpen(false);
      await handleSessionClick(session);
    }} />}
  </>;
}

export function AutomationWorktreeEntry({ worktreeId }: { worktreeId: string }) {
  const scope = { worktreeId };
  const store = useAutomationStore(scope);
  return <Entry scope={scope} store={store} />;
}

export function AutomationSessionControls({ sessionId, provider }: { sessionId: string; provider?: string }) {
  const scope = { sessionId };
  const store = useAutomationStore(scope);
  const { items, error } = useStore(store);
  const ownership = useAutomationOwnership(sessionId);
  const rule = items.find(rule => rule.id === ownership.automationId) ?? items.find(rule => rule.state === 'enabled') ?? items.find(rule => rule.attention && rule.state !== 'deleted') ?? items.find(rule => rule.state !== 'deleted');
  const automationId = ownership.automationId ?? rule?.id ?? null;
  const { t } = useI18n();
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--divider) bg-(--chat-header-bg) px-2.5 py-1 text-(--text-primary)" data-testid="automation-session-controls">
    {rule && <span role="status" className="text-xs">{rule.name} · {t(`automation.state_${rule.state}`)}</span>}
    <Entry scope={scope} store={store} currentId={automationId ?? undefined} supported={provider === 'claude-code' || provider === 'codex'} />
    {automationId && <><span className="text-xs" role="status">{t(`automation.${ownership.mode}`)}</span><button {...telemetryClickAttributes('automation.pause', 'chat_header')} className={automationButton} onClick={() => void store.getState().pause(automationId)}>{t('automation.pause')}</button></>}
    <AutomationError code={error} />
  </div>;
}
