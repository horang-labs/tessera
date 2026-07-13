"use client";

import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import {
  buildMemoryFileSessionId,
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "./special-session";
import type { MemoryTargetKind } from "@/types/memory";

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
  previewSpecialFileTab(buildWorkspaceFileSessionId(sourceSessionId, kind, filePath));
}

export function openMemoryFileTab(
  sourceSessionId: string,
  memoryKind: MemoryTargetKind,
  fileName: string,
): void {
  focusOrCreateSpecialTab(
    buildMemoryFileSessionId(sourceSessionId, memoryKind, fileName),
    {
      pinExistingPreview: true,
      insertAfterTabId: useTabStore.getState().activeTabId,
    },
  );
}

export function previewMemoryFileTab(
  sourceSessionId: string,
  memoryKind: MemoryTargetKind,
  fileName: string,
): void {
  previewSpecialFileTab(buildMemoryFileSessionId(sourceSessionId, memoryKind, fileName));
}

function previewSpecialFileTab(specialSessionId: string): void {
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
