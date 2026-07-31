"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Brain, FileText, GitCommitHorizontal, X } from "lucide-react";
import { useGitStore, type GitPanelTab } from "@/stores/git-store";
import {
  WorktreeScriptsPanel,
  WorktreeScriptsTabIcon,
  useWorktreeScriptsAvailable,
} from "@/components/scripts/worktree-scripts-panel";
import { useElectronPlatform } from "@/hooks/use-electron-platform";
import { useI18n } from "@/lib/i18n";
import { captureTelemetryEvent } from "@/lib/telemetry/client";
import { useSessionStore } from "@/stores/session-store";
import { supportsMemoryPanel } from "@/lib/memory/memory-provider";
import type { GitChangedFile } from "@/types/git";
import {
  GitPanelCommitsSection,
  GitPanelContentSection,
  GitPanelSummarySection,
} from "./git-panel-sections";
import { useGitPanelController } from "./use-git-panel-controller";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { WorkspaceFilePanel } from "@/components/workspace/workspace-file-panel";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { cn } from "@/lib/utils";
import { ElectronWindowControls } from "@/components/layout/electron-window-controls";

/**
 * Only the selected tab carries its name.
 *
 * Four tabs and a 320px panel do not leave room for four labels — they came
 * out as "Cont..." — and an icon the reader has already chosen needs no words
 * beside it. The name stays reachable as the button's own label.
 */
function GitPanelTabButton({
  active,
  children,
  icon,
  onClick,
}: {
  active: boolean;
  children: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={children}
      title={children}
      onClick={onClick}
      className={cn(
        // The selected tab takes twice the width, because it is the only one
        // carrying words; the rest share what is left evenly so the row keeps
        // its rhythm however many there are.
        "flex h-6 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors",
        active
          ? "flex-[2] bg-(--sidebar-bg) text-(--text-primary) shadow-sm"
          : "flex-1 text-(--text-muted) hover:bg-(--sidebar-bg)/60 hover:text-(--text-primary)",
      )}
    >
      {icon}
      {active ? <span className="truncate">{children}</span> : null}
    </button>
  );
}

export function GitPanel({
  sessionId,
  width,
  className,
  closeLabel,
  onClose,
}: {
  sessionId: string | null;
  width: number | string;
  className?: string;
  closeLabel?: string;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isWindowsElectron = electronPlatform === "win32";
  const isLinuxElectron = electronPlatform === "linux";
  const controller = useGitPanelController(sessionId);
  // The selection lives in the store so a preparation badge can send the user
  // straight to the Scripts tab.
  const activePanelTab = useGitStore((state) => state.panelTab);
  const setActivePanelTab = useGitStore((state) => state.setPanelTab);
  const openedTelemetryRef = useRef(false);
  const resolvedCloseLabel = closeLabel ?? t("chat.closeGitPanel");

  const sessionProvider = useSessionStore((state) =>
    sessionId ? state.getSession(sessionId)?.provider?.trim() ?? null : null,
  );
  const showMemoryTab = supportsMemoryPanel(sessionProvider);
  const showScriptsTab = useWorktreeScriptsAvailable(sessionId);

  // Derive the visible tab instead of forcing state: if the stored selection
  // is one this session can't show, fall back to Git for rendering while
  // preserving the selection for sessions that can.
  const tabUnavailable =
    (!showMemoryTab && activePanelTab === "memory")
    || (!showScriptsTab && activePanelTab === "scripts");
  const effectivePanelTab: GitPanelTab = tabUnavailable ? "git" : activePanelTab;

  useEffect(() => {
    openedTelemetryRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (openedTelemetryRef.current) return;
    if (controller.loading) return;

    openedTelemetryRef.current = true;
    void captureTelemetryEvent("git_panel_opened", {
      source: "git_panel",
      result: controller.error ? "failed" : "success",
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      changed_file_count: controller.changedFileCount,
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
      github_available: Boolean(controller.data?.github.available),
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.available,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    controller.error,
    controller.loading,
  ]);

  const handlePanelTabChange = useCallback((tab: GitPanelTab) => {
    if (activePanelTab === tab) return;
    setActivePanelTab(tab);
    void captureTelemetryEvent("git_panel_tab_changed", {
      source: "git_panel",
      tab,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
  }, [
    activePanelTab,
    setActivePanelTab,
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
  ]);

  const openDiffFile = useCallback((file: GitChangedFile) => {
    if (!sessionId) return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "preview_diff",
      target: "diff",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    previewWorkspaceFileTab(sessionId, "diff", file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    sessionId,
  ]);

  const pinDiffFile = useCallback((file: GitChangedFile) => {
    if (!sessionId) return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "open_diff_tab",
      target: "diff",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    openWorkspaceFileTab(sessionId, "diff", file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    sessionId,
  ]);

  const openReadOnlyFile = useCallback((file: GitChangedFile) => {
    if (!sessionId || file.state === "deleted") return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "open_file_tab",
      target: "file",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    openWorkspaceFileTab(sessionId, "file", file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    sessionId,
  ]);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 cursor-default flex-col border-l border-(--chat-header-border) bg-(--sidebar-bg)",
        className,
      )}
      style={{ width: typeof width === "number" ? `${width}px` : width }}
    >
      {isWindowsElectron || isLinuxElectron ? (
        <div className="electron-drag flex h-[40px] shrink-0 items-stretch justify-end border-b border-(--electron-titlebar-border) bg-(--electron-titlebar-bg)">
          {isLinuxElectron ? <ElectronWindowControls /> : null}
        </div>
      ) : null}

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--chat-header-border) px-2">
        <div
          role="tablist"
          aria-label={t("gitPanel.tabs.rightPanel")}
          className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md bg-(--sidebar-hover) p-0.5"
        >
          <GitPanelTabButton
            active={effectivePanelTab === "git"}
            icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
            onClick={() => handlePanelTabChange("git")}
          >
            {t("gitPanel.tabs.git")}
          </GitPanelTabButton>
          <GitPanelTabButton
            active={effectivePanelTab === "files"}
            icon={<FileText className="h-3.5 w-3.5" />}
            onClick={() => handlePanelTabChange("files")}
          >
            {t("gitPanel.tabs.files")}
          </GitPanelTabButton>
          {showScriptsTab ? (
            <GitPanelTabButton
              active={effectivePanelTab === "scripts"}
              icon={<WorktreeScriptsTabIcon className="h-3.5 w-3.5" />}
              onClick={() => handlePanelTabChange("scripts")}
            >
              {t("gitPanel.tabs.scripts")}
            </GitPanelTabButton>
          ) : null}
          {showMemoryTab ? (
            <GitPanelTabButton
              active={effectivePanelTab === "memory"}
              icon={<Brain className="h-3.5 w-3.5" />}
              onClick={() => handlePanelTabChange("memory")}
            >
              {t("gitPanel.tabs.context")}
            </GitPanelTabButton>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            aria-label={resolvedCloseLabel}
            title={resolvedCloseLabel}
            data-testid="git-panel-close-btn"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <GitPanelSummarySection
        data={controller.data}
        loading={controller.loading}
        error={controller.error}
        changedFileCount={controller.changedFileCount}
        onCopyBranch={controller.copyBranch}
        onCopyWorktreePath={controller.copyWorktreePath}
        onOpenExternal={controller.openExternal}
        showDetails={effectivePanelTab === "git"}
      />

      {effectivePanelTab === "files" ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFilePanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : effectivePanelTab === "scripts" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorktreeScriptsPanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : effectivePanelTab === "memory" ? (
        <div className="min-h-0 flex-1">
          <MemoryPanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : (
        <>
          <GitPanelContentSection
            sessionId={sessionId}
            data={controller.data}
            loading={controller.loading}
            error={controller.error}
            changedFileCount={controller.changedFileCount}
            selectedPath={controller.selectedPath}
            setSelectedPath={controller.setSelectedPath}
            onCopyFilePath={controller.copyFilePath}
            onOpenDiffFile={openDiffFile}
            onPinDiffFile={pinDiffFile}
            onOpenReadOnlyFile={openReadOnlyFile}
          />

          <GitPanelCommitsSection
            data={controller.data}
            loading={controller.loading}
            error={controller.error}
          />
        </>
      )}
    </aside>
  );
}
