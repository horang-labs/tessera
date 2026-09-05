"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useGitStore, type GitPanelTab } from "@/stores/git-store";
import {
  WorktreeScriptsPanel,
  useWorktreeScriptsAvailable,
} from "@/components/scripts/worktree-scripts-panel";
import { useElectronPlatform } from "@/hooks/use-electron-platform";
import { useProjectViewSession } from "@/hooks/use-project-view-workspace-state";
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
import { useSharedGitPanelController } from "./git-panel-controller-context";
import {
  openWorkspaceTargetFileTab,
  previewWorkspaceTargetFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { resolveWorkspaceTarget } from '@/types/worktree';
import { WorkspaceFilePanel } from "@/components/workspace/workspace-file-panel";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { ImageGenerationsPanel } from "@/components/image-generation/image-generations-panel";
import { cn } from "@/lib/utils";
import { PHONE_TOUCH_TARGET } from "@/lib/ui/touch-target";
import { ElectronWindowControls } from "@/components/layout/electron-window-controls";
import { usePhoneViewport } from "@/hooks/use-phone-viewport";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { usePhoneOverlayNavigation } from "@/hooks/use-phone-overlay-navigation";
import {
  telemetryClickAttributes,
  type TelemetryUiControl,
} from "@/lib/telemetry/ui-click";

const NOOP = () => {};

/**
 * Every tab says what it is.
 *
 * Four of them and a narrow panel is a tight fit, so the words are what stays
 * and the icons go: an unlabelled icon row leaves the reader guessing which
 * mark means which panel, and guessing costs more than an icon buys.
 */
function GitPanelTabButton({
  active,
  children,
  onClick,
  telemetryControl,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
  telemetryControl: TelemetryUiControl;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={children}
      onClick={onClick}
      {...telemetryClickAttributes(telemetryControl, "right_panel")}
      className={cn(
        "flex h-6 min-w-0 flex-1 items-center justify-center rounded px-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-(--sidebar-bg) text-(--text-primary) shadow-sm"
          : "text-(--text-muted) hover:bg-(--sidebar-bg)/60 hover:text-(--text-primary)",
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

export function GitPanel({
  sessionId,
  isActive = true,
  worktreeId = null,
  width,
  className,
  closeLabel,
  onClose,
}: {
  sessionId: string | null;
  isActive?: boolean;
  worktreeId?: string | null;
  width: number | string;
  className?: string;
  closeLabel?: string;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isWindowsElectron = electronPlatform === "win32";
  const isLinuxElectron = electronPlatform === "linux";
  const isPhoneViewport = usePhoneViewport();
  const controller = useSharedGitPanelController();
  // The selection lives in the store so a preparation badge can send the user
  // straight to the Scripts tab.
  const activePanelTab = useGitStore((state) => state.panelTab);
  const setActivePanelTab = useGitStore((state) => state.setPanelTab);
  const openedTelemetryRef = useRef(false);
  const resolvedCloseLabel = closeLabel ?? t("chat.closeGitPanel");
  const dismissPhonePanel = usePhoneOverlayNavigation({
    enabled: isPhoneViewport && Boolean(onClose),
    open: Boolean(onClose),
    onBack: onClose ?? NOOP,
  });
  useCloseOnEscape(dismissPhonePanel, {
    enabled: isPhoneViewport && Boolean(onClose),
  });

  const sessionProvider = useProjectViewSession(sessionId)?.provider?.trim() ?? null;
  const showMemoryTab = supportsMemoryPanel(sessionProvider);
  const showScriptsTab = useWorktreeScriptsAvailable(sessionId);
  const fileTarget = useMemo(
    () => resolveWorkspaceTarget(sessionId, worktreeId),
    [sessionId, worktreeId],
  );

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
    if (!fileTarget) return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "preview_diff",
      target: "diff",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    previewWorkspaceTargetFileTab(fileTarget, 'diff', file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    fileTarget,
  ]);

  const pinDiffFile = useCallback((file: GitChangedFile) => {
    if (!fileTarget) return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "open_diff_tab",
      target: "diff",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    openWorkspaceTargetFileTab(fileTarget, 'diff', file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    fileTarget,
  ]);

  const openReadOnlyFile = useCallback((file: GitChangedFile) => {
    if (!fileTarget || file.state === "deleted") return;
    void captureTelemetryEvent("git_file_opened", {
      source: "git_panel",
      action: "open_file_tab",
      target: "file",
      file_state: file.state,
      has_worktree: Boolean(controller.data?.worktreePath),
      has_changes: Boolean(controller.changedFileCount),
      has_pr: Boolean(controller.data?.prStatus || controller.data?.github.pullRequest),
    });
    openWorkspaceTargetFileTab(fileTarget, 'file', file.path, {
      preferKanbanPeek: true,
    });
  }, [
    controller.changedFileCount,
    controller.data?.github.pullRequest,
    controller.data?.prStatus,
    controller.data?.worktreePath,
    fileTarget,
  ]);

  const summarySection = (
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
  );
  const commitsSection = (
    <GitPanelCommitsSection
      data={controller.data}
      loading={controller.loading}
      error={controller.error}
    />
  );

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 cursor-default flex-col border-l border-(--chat-header-border) bg-(--sidebar-bg)",
        className,
      )}
      style={{ width: typeof width === "number" ? `${width}px` : width }}
      data-testid="git-panel"
      data-session-target={sessionId ?? undefined}
      data-worktree-target={worktreeId ?? undefined}
    >
      {isWindowsElectron || isLinuxElectron ? (
        <div className="electron-drag flex h-[40px] shrink-0 items-stretch justify-end border-b border-(--electron-titlebar-border) bg-(--electron-titlebar-bg)">
          {isLinuxElectron ? <ElectronWindowControls /> : null}
        </div>
      ) : null}

      {/* `max-sm:h-auto` so the close target below can be 44px without
          overflowing a 29px row (#270). */}
      <div className="flex h-9 max-sm:h-auto shrink-0 items-center gap-2 border-b border-(--chat-header-border) px-2">
        <div
          role="tablist"
          aria-label={t("gitPanel.tabs.rightPanel")}
          className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md bg-(--sidebar-hover) p-0.5"
        >
          <GitPanelTabButton
            active={effectivePanelTab === "git"}
            onClick={() => handlePanelTabChange("git")}
            telemetryControl="right_panel.tab.git"
          >
            {t("gitPanel.tabs.git")}
          </GitPanelTabButton>
          <GitPanelTabButton
            active={effectivePanelTab === "images"}
            onClick={() => handlePanelTabChange("images")}
            telemetryControl="right_panel.tab.images"
          >
            {t("gitPanel.tabs.images")}
          </GitPanelTabButton>
          <GitPanelTabButton
            active={effectivePanelTab === "files"}
            onClick={() => handlePanelTabChange("files")}
            telemetryControl="right_panel.tab.files"
          >
            {t("gitPanel.tabs.files")}
          </GitPanelTabButton>
          {showScriptsTab ? (
            <GitPanelTabButton
              active={effectivePanelTab === "scripts"}
              onClick={() => handlePanelTabChange("scripts")}
              telemetryControl="right_panel.tab.scripts"
            >
              {t("gitPanel.tabs.scripts")}
            </GitPanelTabButton>
          ) : null}
          {showMemoryTab ? (
            <GitPanelTabButton
              active={effectivePanelTab === "memory"}
              onClick={() => handlePanelTabChange("memory")}
              telemetryControl="right_panel.tab.memory"
            >
              {t("gitPanel.tabs.context")}
            </GitPanelTabButton>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={() => dismissPhonePanel()}
            {...telemetryClickAttributes("right_panel.close", "right_panel")}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
              PHONE_TOUCH_TARGET,
            )}
            aria-label={resolvedCloseLabel}
            title={resolvedCloseLabel}
            data-testid="git-panel-close-btn"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {effectivePanelTab === "scripts" || effectivePanelTab === "images"
        || (isPhoneViewport && effectivePanelTab === "git")
        ? null
        : summarySection}

      {effectivePanelTab === "files" ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFilePanel
            key={sessionId ?? worktreeId ?? "no-target"}
            sessionId={sessionId}
            worktreeId={worktreeId}
          />
        </div>
      ) : effectivePanelTab === "scripts" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorktreeScriptsPanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : effectivePanelTab === "memory" ? (
        <div className="min-h-0 flex-1">
          <MemoryPanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : effectivePanelTab === "images" ? (
        <div className="min-h-0 flex-1">
          <ImageGenerationsPanel key={sessionId ?? "no-session"} sessionId={sessionId} isActive={isActive} />
        </div>
      ) : (
        <>
          <GitPanelContentSection
            sessionId={sessionId}
            targetSelected={Boolean(sessionId || worktreeId)}
            data={controller.data}
            loading={controller.loading}
            error={controller.error}
            changedFileCount={controller.changedFileCount}
            failure={{
              report: controller.actionFailure,
              onDismiss: controller.dismissActionFailure,
            }}
            conflictHandoff={{
              available: controller.conflictHandoffAvailable,
              pending: controller.preparingConflictHandoff,
              onPrepare: () => void controller.prepareConflictHandoff(),
            }}
            commit={{
              draftBlocked: controller.commitDraftBlocked,
              generateError: controller.generateMessageError,
              generating: controller.generatingMessage,
              isSelected: controller.isSelectedForCommit,
              message: controller.commitMessage,
              onGenerate: () => void controller.generateCommitMessage(),
              onMessageChange: controller.setCommitMessage,
              onSetAllSelected: controller.setAllCommitFilesSelected,
              onSetSelected: controller.setCommitFilesSelected,
              selectionKey: controller.commitSelectionKey,
              totals: controller.commitTotals,
            }}
            revert={{
              onConfirm: () => void controller.revertSelectedFiles(),
              pending: controller.pendingVerb === "revert",
            }}
            primary={{
              action: controller.primaryAction,
              pendingVerb: controller.pendingVerb,
              onRun: () => void controller.runPrimaryAction(),
            }}
            phoneScrollableContent={isPhoneViewport ? {
              summary: summarySection,
              commits: commitsSection,
            } : undefined}
            menu={{
              actions: controller.menuActions,
              onRun: (id) => void controller.runMenuAction(id),
            }}
            selectedPath={controller.selectedPath}
            setSelectedPath={controller.setSelectedPath}
            onCopyFilePath={controller.copyFilePath}
            onOpenDiffFile={openDiffFile}
            onPinDiffFile={pinDiffFile}
            onOpenReadOnlyFile={openReadOnlyFile}
          />

          {isPhoneViewport ? null : commitsSection}
        </>
      )}

    </aside>
  );
}
