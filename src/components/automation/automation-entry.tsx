'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useI18n } from '@/lib/i18n';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { AutomationPauseAction, automationNeedsLimitReview } from './continuation-resume';
import { AutomationManager } from './automation-manager';
import { localDue } from './automation-form';
import { AutomationReason } from './automation-reason';
import { AutomationError } from './automation-error';
import { automationButton } from './ownership-actions';
import { useAutomationOwnership, useAutomationStore } from './use-automation';

function Entry({ scope, store, supported = true, currentId, attention = false, paused = false, reviewLimits = false }: { scope: AutomationScope; store: AutomationStoreApi; supported?: boolean; currentId?: string; attention?: boolean; paused?: boolean; reviewLimits?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { materializeSession } = useSessionNavigation();
  const { handleSessionClick } = useSessionClickHandlers();
  return <>
    <button {...telemetryClickAttributes('sessionId' in scope ? 'automation.open.wake' : 'automation.open.schedule', 'sessionId' in scope ? 'chat_header' : 'worktree')} className={automationButton} type="button" onClick={() => setOpen(true)}>{t(currentId ? reviewLimits ? 'automation.reviewLimits' : attention ? 'automation.review' : paused ? 'automation.resume' : 'automation.details' : 'sessionId' in scope ? 'automation.wake' : 'automation.schedule')}</button>
    {open && <AutomationManager scope={scope} store={store} initialId={currentId} initialResume={paused && !attention && !reviewLimits} supported={supported} onClose={() => setOpen(false)} onOpenSession={async id => {
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
  const { items, details, error } = useStore(store);
  const ownership = useAutomationOwnership(sessionId);
  const rule = items.find(rule => rule.id === ownership.automationId) ?? items.find(rule => rule.state === 'enabled') ?? items.find(rule => rule.attention && rule.state !== 'deleted') ?? items.find(rule => rule.state !== 'deleted');
  const automationId = ownership.automationId ?? rule?.id ?? null;
  const { t } = useI18n();
  useEffect(() => { if (rule) void store.getState().inspect(rule.id); }, [store, rule]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const current = automationId ? details[automationId]?.automation : undefined;
  const reviewLimits = current ? automationNeedsLimitReview(current, now) : rule?.state === 'exhausted' || rule?.state === 'expired';
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--divider) bg-(--chat-header-bg) px-2.5 py-1 text-(--text-primary)" data-testid="automation-session-controls">
    {rule && <span role="status" className="text-xs">{rule.name} · {t(`automation.state_${rule.state}`)}{current?.mode === 'autorun' && ` · ${t(`automation.phase_${current.autorunStatus}`)}`}</span>}
    <Entry scope={scope} store={store} currentId={automationId ?? undefined} attention={Boolean(rule?.attention)} paused={rule?.state === 'paused'} reviewLimits={reviewLimits} supported={provider === 'claude-code' || provider === 'codex'} />
    {current?.nextDueAt && <span className="text-xs">{t('automation.next')}: {localDue(current.nextDueAt)}</span>}
    {rule?.attention && <AutomationReason reason={rule.attention.reason} summary={current?.mode === 'autorun' ? current.attention?.summary : null} />}
    {automationId && <span className="text-xs" role="status">{t(`automation.${ownership.mode}`)}</span>}
    <AutomationPauseAction rule={rule} ownership={ownership} surface="chat_header" onPause={id => void store.getState().pause(id)} />
    <AutomationError code={error} />
  </div>;
}
