import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

export interface SessionPanelLocation {
  tabId: string;
  panelId: string;
}

function queryPanelElement(panelId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(
    `[data-panel-wrapper="true"][data-panel-id="${panelId}"]`,
  );
}

function focusPanelControlNow(panelId: string): void {
  const panelEl = queryPanelElement(panelId);
  if (!panelEl || panelEl.dataset.active !== 'true') return;
  if (document.activeElement?.getAttribute('data-tab-title-editor') === 'true') return;

  const prompt = panelEl.querySelector<HTMLElement>('[data-interactive-prompt]');
  if (prompt) {
    prompt.focus();
    return;
  }

  const textarea = panelEl.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
  if (textarea) {
    textarea.focus();
    return;
  }

  const createBtn = panelEl.querySelector<HTMLElement>('[data-testid="empty-panel-create-session"]');
  createBtn?.focus();
}

export function focusPanelControl(panelId: string): void {
  if (typeof requestAnimationFrame === 'undefined') {
    focusPanelControlNow(panelId);
    return;
  }

  requestAnimationFrame(() => {
    focusPanelControlNow(panelId);
    requestAnimationFrame(() => focusPanelControlNow(panelId));
  });
}

export function activateSessionPanel(
  sessionId: string,
  options: { location?: SessionPanelLocation | null; focus?: boolean } = {},
): boolean {
  const tabStore = useTabStore.getState();
  const location = options.location ?? tabStore.findSessionLocation(sessionId);
  if (!location) return false;

  if (location.tabId !== tabStore.activeTabId) {
    tabStore.setActiveTab(location.tabId);
  }

  usePanelStore.getState().setActivePanelId(location.panelId);

  if (options.focus !== false) {
    focusPanelControl(location.panelId);
  }

  return true;
}
