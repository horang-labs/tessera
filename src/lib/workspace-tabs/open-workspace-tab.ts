"use client";

import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import {
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "./special-session";

function focusOrCreateSpecialTab(
  specialSessionId: string,
  options: { pinExistingPreview?: boolean; insertAfterTabId?: string | null } = {},
): void {
  const tabStore = useTabStore.getState();
  const existing = tabStore.findSessionLocation(specialSessionId);
  if (existing) {
    tabStore.setActiveTab(existing.tabId);
    usePanelStore.getState().setActivePanelId(existing.panelId);
    if (options.pinExistingPreview) tabStore.pinTab(existing.tabId);
    return;
  }
  tabStore.createTab(specialSessionId, {
    insertAfterTabId: options.insertAfterTabId ?? tabStore.activeTabId,
  });
}

export function openWorkspaceFileTab(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
): void {
  focusOrCreateSpecialTab(
    buildWorkspaceFileSessionId(sourceSessionId, kind, filePath),
    {
      pinExistingPreview: true,
      insertAfterTabId: useTabStore.getState().activeTabId,
    },
  );
}

export function previewWorkspaceFileTab(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
): void {
  const specialSessionId = buildWorkspaceFileSessionId(sourceSessionId, kind, filePath);
  const tabStore = useTabStore.getState();
  const existing = tabStore.findSessionLocation(specialSessionId);
  if (existing) {
    tabStore.setActiveTab(existing.tabId);
    usePanelStore.getState().setActivePanelId(existing.panelId);
    return;
  }
  tabStore.openWorkspaceFilePreview(specialSessionId, {
    insertAfterTabId: tabStore.activeTabId,
  });
}
