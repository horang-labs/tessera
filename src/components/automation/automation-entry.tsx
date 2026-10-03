'use client';

import { activationStatusKey } from './automation-activation';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useTabStore } from '@/stores/tab-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { useTerminalSessionStore, selectIsTerminalAwaitingInput } from '@/stores/terminal-session-store';
import { getSessionInputOwnership } from '@/lib/automation/client-state';
import { useI18n } from '@/lib/i18n';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { AutomationPauseAction, automationNeedsLimitReview } from './continuation-resume';
import { AutomationManager } from './automation-manager';
import { Repeat2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { automationButton, automationToolbarButton } from './ownership-actions';
import { useAutomationOwnership, useAutomationStore } from './use-automation';

function Entry({ scope, store, supported = true, currentId, attention = false, paused = false, reviewLimits = false, toolbarState }: { scope: AutomationScope; store: AutomationStoreApi; supported?: boolean; currentId?: string; attention?: boolean; paused?: boolean; reviewLimits?: boolean; toolbarState?: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const navigationRequest = useRef(0);
  const { materializeSession } = useSessionNavigation();
  const { handleSessionClick } = useSessionClickHandlers();
  return <>
    <button {...telemetryClickAttributes('sessionId' in scope ? 'automation.open.wake' : 'automation.open.schedule', 'sessionId' in scope ? 'chat_header' : 'worktree')} className={'sessionId' in scope ? automationToolbarButton : automationButton} type="button" aria-haspopup="dialog" title={'sessionId' in scope ? [t('automation.toolbar'), toolbarState].filter(Boolean).join(' · ') : t('automation.schedule')} onClick={() => setOpen(true)}>
      {'sessionId' in scope ? <><Repeat2 className="h-3.5 w-3.5" aria-hidden="true" /><span>{t('automation.toolbar')}</span>{toolbarState && <span aria-label={toolbarState} className={cn('h-1.5 w-1.5 rounded-full', attention ? 'bg-(--status-error-text)' : paused || reviewLimits ? 'bg-(--text-muted)' : 'bg-(--accent)')} />}</> : t(currentId ? 'automation.details' : 'automation.schedule')}
    </button>
    {open && <AutomationManager scope={scope} store={store} initialId={currentId} initialResume={paused && !attention && !reviewLimits} supported={supported} onClose={() => { ++navigationRequest.current; setOpen(false); }} onOpenSession={async (id, objective) => {
      const request = ++navigationRequest.current;
      const activeSession = useSessionStore.getState().activeSessionId;
      const activeTab = useTabStore.getState().activeTabId;
      const session = await materializeSession(id);
      if (request !== navigationRequest.current || activeSession !== useSessionStore.getState().activeSessionId || activeTab !== useTabStore.getState().activeTabId) return;
      if (!session) { store.setState({ error: 'SESSION_UNAVAILABLE' }); return; }
      if (objective && !addAutomationObjectiveToDraft(id, objective)) { store.setState({ error: 'PAUSE_REQUIRED' }); return; }
      if (objective) useTerminalViewModeStore.getState().setMode(id, 'chat');
      setOpen(false);
      await handleSessionClick(session);
      if (objective) focusAutomationSessionDraft(id);
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
  const { items, details } = useStore(store);
  const ownership = useAutomationOwnership(sessionId);
  const rule = items.find(rule => rule.id === ownership.automationId) ?? items.find(rule => rule.state === 'enabled') ?? items.find(rule => rule.attention && rule.state !== 'deleted') ?? items.find(rule => rule.state !== 'deleted');
  const automationId = ownership.automationId ?? rule?.id ?? null;
  const { t } = useI18n();
  useEffect(() => { if (rule) void store.getState().inspect(rule.id); }, [store, rule]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const current = automationId ? details[automationId]?.automation : undefined;
  const reviewLimits = current ? automationNeedsLimitReview(current, now) : rule?.state === 'exhausted' || rule?.state === 'expired';
  const stateLabel = rule ? t(activationStatusKey(rule.state, details[rule.id]?.activation)) : ownership.automationId ? t(`automation.${ownership.mode}`) : null;
  return <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('automation.toolbar')} data-testid="automation-session-controls">
    <Entry scope={scope} store={store} currentId={automationId ?? undefined} attention={Boolean(rule?.attention)} paused={rule?.state === 'paused'} reviewLimits={reviewLimits} toolbarState={stateLabel} supported={provider === 'claude-code' || provider === 'codex'} />
    <AutomationPauseAction compact rule={rule} ownership={ownership} surface="chat_header" onPause={id => void store.getState().pause(id)} />
  </div>;
}


/** Explicit recovery copies text only; normal composer submission remains authoritative. */
export function addAutomationObjectiveToDraft(sessionId: string, objective: string) {
  if (!objective.trim() || getSessionInputOwnership(sessionId).mode !== 'human' || selectIsTerminalAwaitingInput(sessionId)(useTerminalSessionStore.getState())) return false;
  const chat = useChatStore.getState();
  const existing = chat.getDraftInput(sessionId);
  chat.setDraftInput(sessionId, existing ? `${existing}\n\n${objective}` : objective);
  return true;
}


/** Recovery navigates through the existing normal-panel route, including from Peek. */
export function focusAutomationSessionDraft(sessionId: string) {
  const location = useTabStore.getState().findSessionLocation(sessionId);
  if (!location) return;
  const focus = () => {
    const panels = usePanelStore.getState();
    const tab = panels.tabPanels[location.tabId];
    if (useTabStore.getState().activeTabId !== location.tabId || panels.activeTabId !== location.tabId || tab?.activePanelId !== location.panelId || tab.panels[location.panelId]?.sessionId !== sessionId || document.querySelector('dialog[open]')) return;
    const root = [...document.querySelectorAll<HTMLElement>('[data-panel-wrapper="true"][data-panel-id]')].find(root => root.dataset.panelId === location.panelId && root.dataset.active === 'true');
    const input = root && [...root.querySelectorAll<HTMLTextAreaElement>('[data-session-input]')].find(input => input.dataset.sessionInput === sessionId);
    if (input && input.getClientRects().length && !input.readOnly && !input.disabled) input.focus();
  };
  requestAnimationFrame(() => { focus(); requestAnimationFrame(focus); });
}
