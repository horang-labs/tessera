"use client";

import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { useBoardStore } from "@/stores/board-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  buildMemoryFileSessionId,
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "./special-session";
import type { MemoryTargetKind } from "@/types/memory";

interface FileOpenOptions {
  preferKanbanPeek?: boolean;
}

function canOpenFileInKanbanPeek(): boolean {
  const settingsState = useSettingsStore.getState();
  const boardState = useBoardStore.getState();
  return settingsState.settings.kanbanSessionOpenMode === "peek"
    && !settingsState.sidebarCollapsed
    && boardState.viewMode === "board";
}

function tryOpenWorkspaceFileInKanbanPeek(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
): boolean {
  if (!canOpenFileInKanbanPeek()) return false;

  useBoardStore.getState().openPeekFile({
    type: "workspace-file",
    sourceSessionId,
    kind,
    path: filePath,
  });
  return true;
}

function tryOpenMemoryFileInKanbanPeek(
  sourceSessionId: string,
  memoryKind: MemoryTargetKind,
  fileName: string,
): boolean {
  if (!canOpenFileInKanbanPeek()) return false;

  useBoardStore.getState().openPeekFile({
    type: "memory-file",
    sourceSessionId,
    memoryKind,
    fileName,
  });
  return true;
}

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
  options: FileOpenOptions = {},
): void {
  if (
    options.preferKanbanPeek
    && tryOpenWorkspaceFileInKanbanPeek(sourceSessionId, kind, filePath)
  ) return;
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
  options: FileOpenOptions = {},
): void {
  if (
    options.preferKanbanPeek
    && tryOpenWorkspaceFileInKanbanPeek(sourceSessionId, kind, filePath)
  ) return;
  previewSpecialFileTab(buildWorkspaceFileSessionId(sourceSessionId, kind, filePath));
}

export function openMemoryFileTab(
  sourceSessionId: string,
  memoryKind: MemoryTargetKind,
  fileName: string,
  options: FileOpenOptions = {},
): void {
  if (
    options.preferKanbanPeek
    && tryOpenMemoryFileInKanbanPeek(sourceSessionId, memoryKind, fileName)
  ) return;
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
  options: FileOpenOptions = {},
): void {
  if (
    options.preferKanbanPeek
    && tryOpenMemoryFileInKanbanPeek(sourceSessionId, memoryKind, fileName)
  ) return;
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
