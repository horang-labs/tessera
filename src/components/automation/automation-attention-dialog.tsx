'use client';
import { useStore } from 'zustand';
import { automationAttentionNavigation } from '@/stores/automation-store';
import { useAutomationStore } from './use-automation';
import { AutomationManager } from './automation-manager';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { getRenderedViewMode } from '@/lib/viewport/rendered-view-mode';
import { useBoardStore } from '@/stores/board-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTabStore } from '@/stores/tab-store';
import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { getSessionOriginProjectId } from '@/lib/projects/origin-project-representation';
import { switchToSessionProject } from '@/lib/session/switch-session-project';
import type { AutomationAttention } from '@/lib/automation/autorun-contracts';

export function AutomationAttentionDialog() {
  const target = useStore(automationAttentionNavigation, state => state.target);
  return target ? <AttentionManager key={target.automationId} target={target} /> : null;
}
function AttentionManager({ target }: { target: AutomationAttention }) {
  const scope = { sessionId: target.sessionId };
  const store = useAutomationStore(scope);
  const { materializeSession, viewSession } = useSessionNavigation();
  const close = () => automationAttentionNavigation.setState({ target: null });
  return <AutomationManager scope={scope} store={store} initialId={target.automationId} onClose={close} onOpenSession={async id => {
    const session = await materializeSession(id);
    if (!session) { store.setState({ error: 'SESSION_UNAVAILABLE' }); return; }
    if (!switchToSessionProject(getSessionOriginProjectId(session))) return;
    close();
    if (getRenderedViewMode() === 'board' && useSettingsStore.getState().settings.kanbanSessionOpenMode === 'peek') { useBoardStore.getState().openSessionPeek(id); return; }
    const tabs = useTabStore.getState(); const location = tabs.findSessionLocation(id);
    if (location) activateSessionPanel(id, { location });
    else { tabs.openPreview(id); await viewSession(session); }
  }} />;
}
