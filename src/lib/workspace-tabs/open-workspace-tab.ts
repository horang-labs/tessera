"use client";

import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { useBoardStore } from "@/stores/board-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspacePeekStore } from "@/stores/workspace-peek-store";
import { getRenderedViewMode } from "@/lib/viewport/rendered-view-mode";
import { stepAsidePhoneGitPanel } from "@/lib/viewport/phone-overlay-step-aside";
import {
  buildMemoryFileSessionId,
  buildWorktreeFileSessionId,
  buildWorkspaceFileSessionId,
  type WorkspaceFileTabKind,
} from "./special-session";
import type { MemoryTargetKind } from "@/types/memory";
import type { WorkspaceTarget } from '@/types/worktree';

interface FileOpenOptions {
  preferKanbanPeek?: boolean;
}

interface TargetFileOpenOptions extends FileOpenOptions {
  projectDir?: string | null;
}

function resolveTargetProjectDir(
  target: WorkspaceTarget,
  projectDir: string | null | undefined,
): string | null {
  if (target.kind !== 'worktree') return null;
  if (projectDir !== undefined) return projectDir;
  const peekTarget = useWorkspacePeekStore.getState().target;
  return peekTarget?.worktreeId === target.id ? peekTarget.projectDir : null;
}

function canOpenFileInKanbanPeek(): boolean {
  const settingsState = useSettingsStore.getState();
  // The rendered mode, not the stored one: a phone shows the list, so a peek
  // opened here would have nothing rendering it and the tap would do nothing.
  return settingsState.settings.kanbanSessionOpenMode === "peek"
    && !settingsState.sidebarCollapsed
    && getRenderedViewMode() === "board";
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
): string {
  // #258: a file tab is about to become the active tab, and on a phone the Git
  // panel these are opened from is a full-screen overlay — so the tab would
  // open behind it. Placed on the tab-opening helpers rather than on each
  // caller: the Files tab, the Git tab's diffs and the Context tab all sit in
  // that one panel. The explorer tab also comes through here and is not in it,
  // where closing a panel that is not open is a no-op. Expanding a folder opens
  // no tab and never reaches this at all.
  stepAsidePhoneGitPanel();
  const tabStore = useTabStore.getState();
  const existing = tabStore.findSessionLocation(specialSessionId);
  if (existing) {
    tabStore.setActiveTab(existing.tabId);
    usePanelStore.getState().setActivePanelId(existing.panelId);
    if (options.pinExistingPreview) tabStore.pinTab(existing.tabId);
    return existing.tabId;
  }
  return tabStore.createTab(specialSessionId, {
    insertAfterTabId: options.insertAfterTabId ?? tabStore.activeTabId,
  });
}

export function openWorkspaceFileTab(
  sourceSessionId: string,
  kind: WorkspaceFileTabKind,
  filePath: string,
  options: FileOpenOptions = {},
): void {
  useWorkspacePeekStore.getState().close();
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
  useWorkspacePeekStore.getState().close();
  if (
    options.preferKanbanPeek
    && tryOpenWorkspaceFileInKanbanPeek(sourceSessionId, kind, filePath)
  ) return;
  previewSpecialFileTab(buildWorkspaceFileSessionId(sourceSessionId, kind, filePath));
}

export function openWorkspaceTargetFileTab(
  target: WorkspaceTarget,
  kind: WorkspaceFileTabKind,
  filePath: string,
  options: TargetFileOpenOptions = {},
): void {
  if (target.kind === 'session') {
    openWorkspaceFileTab(target.id, kind, filePath, options);
    return;
  }
  openWorktreeFileTab(
    target.id,
    filePath,
    resolveTargetProjectDir(target, options.projectDir),
    kind,
  );
}

export function previewWorkspaceTargetFileTab(
  target: WorkspaceTarget,
  kind: WorkspaceFileTabKind,
  filePath: string,
  options: TargetFileOpenOptions = {},
): void {
  if (target.kind === 'session') {
    previewWorkspaceFileTab(target.id, kind, filePath, options);
    return;
  }
  previewWorktreeFileTab(
    target.id,
    filePath,
    resolveTargetProjectDir(target, options.projectDir),
    kind,
  );
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

export function openWorktreeFileTab(
  sourceWorktreeId: string,
  filePath: string,
  projectDir?: string | null,
  kind: WorkspaceFileTabKind = "file",
): void {
  useWorkspacePeekStore.getState().close();
  const tabId = focusOrCreateSpecialTab(
    buildWorktreeFileSessionId(sourceWorktreeId, filePath, kind),
    {
      pinExistingPreview: true,
      insertAfterTabId: useTabStore.getState().activeTabId,
    },
  );
  if (projectDir) useTabStore.getState().setTabProject(tabId, projectDir);
}

export function previewWorktreeFileTab(
  sourceWorktreeId: string,
  filePath: string,
  projectDir?: string | null,
  kind: WorkspaceFileTabKind = "file",
): void {
  useWorkspacePeekStore.getState().close();
  const tabId = previewSpecialFileTab(
    buildWorktreeFileSessionId(sourceWorktreeId, filePath, kind),
  );
  if (projectDir) useTabStore.getState().setTabProject(tabId, projectDir);
}

function previewSpecialFileTab(specialSessionId: string): string {
  stepAsidePhoneGitPanel();
  const tabStore = useTabStore.getState();
  const existing = tabStore.findSessionLocation(specialSessionId);
  if (existing) {
    tabStore.setActiveTab(existing.tabId);
    usePanelStore.getState().setActivePanelId(existing.panelId);
    return existing.tabId;
  }
  tabStore.openWorkspaceFilePreview(specialSessionId, {
    insertAfterTabId: tabStore.activeTabId,
  });
  return useTabStore.getState().activeTabId;
}
