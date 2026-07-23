'use client';

import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

export interface TerminalPreviewSurface {
  releasePreviewRuntime(): void;
  disposeIfUnmounted(): void;
}

const surfacesBySessionId = new Map<string, TerminalPreviewSurface>();
let auditScheduled = false;

function auditPreviewSurfaces(): void {
  auditScheduled = false;
  const tabStore = useTabStore.getState();

  for (const [sessionId, surface] of surfacesBySessionId) {
    const location = tabStore.findSessionLocation(sessionId);
    if (!location) {
      surfacesBySessionId.delete(sessionId);
      surface.releasePreviewRuntime();
      continue;
    }

    const tab = tabStore.tabs.find((candidate) => candidate.id === location.tabId);
    if (tab?.isPreview) {
      if (location.tabId === tabStore.activeTabId) continue;

      // A PTY preview is useful only while it is the view the user is
      // inspecting. Once focus returns to a retained tab, keeping this hidden
      // preview alive would leave its whole process tree running. Remove the
      // transient tab as well as releasing the runtime so reopening the
      // session creates a fresh preview surface.
      surfacesBySessionId.delete(sessionId);
      surface.releasePreviewRuntime();
      tabStore.closeTab(location.tabId);
      continue;
    }

    surfacesBySessionId.delete(sessionId);
    surface.disposeIfUnmounted();
  }
}

function scheduleAudit(): void {
  if (auditScheduled) return;
  auditScheduled = true;
  queueMicrotask(auditPreviewSurfaces);
}

useTabStore.subscribe(scheduleAudit);
usePanelStore.subscribe(scheduleAudit);

/**
 * Keep preview ownership observable even while LRU eviction removes its React
 * tree. A later pin retains the PTY; replacement or close releases it.
 */
export function registerTerminalPreviewSurface(
  sessionId: string,
  surface: TerminalPreviewSurface,
): void {
  surfacesBySessionId.set(sessionId, surface);
  scheduleAudit();
}
