'use client';
import { useStore } from 'zustand';
import { automationAttentionNavigation } from '@/stores/automation-store';
import { useAutomationStore } from './use-automation';
import { AutomationManager } from './automation-manager';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import type { AutomationAttention } from '@/lib/automation/autorun-contracts';

export function AutomationAttentionDialog() {
  const target = useStore(automationAttentionNavigation, state => state.target);
  return target ? <AttentionManager key={target.automationId} target={target} /> : null;
}
function AttentionManager({ target }: { target: AutomationAttention }) {
  const scope = { sessionId: target.sessionId };
  const store = useAutomationStore(scope);
  const { materializeSession } = useSessionNavigation();
  const { handleSessionClick } = useSessionClickHandlers();
  const close = () => automationAttentionNavigation.setState({ target: null });
  return <AutomationManager scope={scope} store={store} initialId={target.automationId} onClose={close} onOpenSession={async id => {
    const session = await materializeSession(id);
    if (!session) { store.setState({ error: 'SESSION_UNAVAILABLE' }); return; }
    close(); await handleSessionClick(session);
  }} />;
}
