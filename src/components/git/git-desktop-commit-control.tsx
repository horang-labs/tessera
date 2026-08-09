"use client";

import React, { memo, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitCommitHorizontal, X } from "lucide-react";
import { useAnchoredPopover } from "@/hooks/use-anchored-popover";
import { useCloseOnEscape } from "@/hooks/use-close-on-escape";
import { useI18n } from "@/lib/i18n";
import type { GitPrimaryAction } from "@/lib/git/primary-git-action";
import { cn } from "@/lib/utils";
import {
  ANCHORED_VIEWPORT_MARGIN,
  resolveAnchoredAlignedLeft,
} from "@/lib/ui/anchored-viewport";
import { useGitStore } from "@/stores/git-store";
import type { GitPanelData } from "@/types/git";
import type { WorktreeDiffStats } from "@/types/worktree-diff-stats";
import { GitActionMenu } from "./git-action-menu";
import { GitCommitForm } from "./git-commit-form";
import {
  useSharedGitPanelController,
  type GitPanelController,
} from "./git-panel-controller-context";

interface ComposerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const COMPOSER_WIDTH = 376;

export function supportsDesktopCommitControl(
  data: GitPanelData | null,
  actionKind: GitPrimaryAction["kind"],
): boolean {
  return Boolean(
    data
      && actionKind === "commit"
      && data.changedFiles.length > 0
      && !data.changedFilesTruncated
      && data.diffStats
      && data.diffStats.changedFiles > 0,
  );
}

function formatCompactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(value / 1_000)}k`;
}

export function GitWorkingTreeDiffStatButton({
  accessibleLabel,
  onOpen,
  stats,
}: {
  accessibleLabel: string;
  onOpen: () => void;
  stats: WorktreeDiffStats;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-testid="desktop-commit-diff-stat"
      className="hidden h-full shrink-0 items-center gap-1.5 border-l border-(--divider) px-2.5 font-mono text-[11px] font-medium tabular-nums transition-colors hover:bg-(--sidebar-hover) xl:flex"
    >
      <span className="text-(--status-success-text)">+{formatCompactCount(stats.added)}</span>
      <span className="text-(--status-error-text)">−{formatCompactCount(stats.removed)}</span>
    </button>
  );
}

export const GitDesktopCommitControl = memo(function GitDesktopCommitControl() {
  const controller = useSharedGitPanelController();
  const data = controller.data;
  const stats = data?.diffStats ?? null;
  if (
    !supportsDesktopCommitControl(data, controller.primaryAction.kind)
    || !data
    || !stats
  ) {
    return null;
  }

  return (
    <GitDesktopCommitControlView
      controller={controller}
      data={data}
      stats={stats}
    />
  );
});

function GitDesktopCommitControlView({
  controller,
  data,
  stats,
}: {
  controller: GitPanelController;
  data: GitPanelData;
  stats: WorktreeDiffStats;
}) {
  const { t } = useI18n();
  const [composerOpen, setComposerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  const { position, updatePosition } = useAnchoredPopover({
    isOpen: composerOpen,
    onClose: closeComposer,
    triggerRef,
    containerRef,
    popoverRef: composerRef,
    calculatePosition: calculateComposerPosition,
  });

  const worktreeName = data.worktreeName
    || data.repoName
    || t("gitPanel.commit.worktreeFallback");

  useCloseOnEscape(closeComposer, { enabled: composerOpen });

  const openChangedFiles = useCallback(() => {
    closeComposer();
    useGitStore.getState().openTab("git");
  }, [closeComposer]);

  const openComposer = useCallback(() => {
    updatePosition();
    setComposerOpen(true);
  }, [updatePosition]);

  const commitFromComposer = useCallback(async () => {
    const committed = await controller.runPrimaryAction();
    if (committed === true) closeComposer();
  }, [closeComposer, controller]);

  const composerLabel = t("gitPanel.commit.composerLabel", { worktree: worktreeName });
  const diffLabel = t("gitPanel.commit.diffStatLabel", {
    added: stats.added,
    removed: stats.removed,
    files: stats.changedFiles,
  });

  return (
    <div
      ref={containerRef}
      data-testid="desktop-commit-control"
      className="electron-no-drag hidden h-full shrink-0 items-stretch border-l border-(--divider) sm:flex"
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={composerOpen ? closeComposer : openComposer}
        disabled={controller.pendingVerb !== null}
        aria-haspopup="dialog"
        aria-expanded={composerOpen}
        aria-controls="desktop-commit-composer"
        aria-busy={controller.pendingVerb !== null}
        aria-label={t("gitPanel.commit.openComposer", { worktree: worktreeName })}
        title={t("gitPanel.commit.openComposer", { worktree: worktreeName })}
        data-testid="desktop-commit-primary"
        className={cn(
          "flex h-full shrink-0 items-center gap-1.5 px-3 text-xs font-semibold transition-colors hover:bg-(--sidebar-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent) disabled:cursor-wait disabled:opacity-60",
          composerOpen && "bg-(--accent)/14 text-(--accent)",
        )}
      >
        <GitCommitHorizontal className="h-3.5 w-3.5" />
        <span>{t(controller.pendingVerb ? "gitPanel.commit.buttonPending" : "gitPanel.commit.button")}</span>
      </button>

      <GitWorkingTreeDiffStatButton
        accessibleLabel={diffLabel}
        onOpen={openChangedFiles}
        stats={stats}
      />

      <GitActionMenu
        actions={controller.menuActions}
        pending={controller.pendingVerb !== null}
        commitDraftBlocked={controller.commitDraftBlocked}
        onRun={(id) => void controller.runMenuAction(id)}
        onBeforeOpen={closeComposer}
        triggerAriaLabel={t("gitPanel.commit.menuLabel", { worktree: worktreeName })}
        triggerTestId="desktop-commit-menu-trigger"
        menuTestId="desktop-commit-action-menu"
        triggerClassName="h-full w-8 rounded-none border-0 border-l border-(--divider)"
      />

      {composerOpen && position && typeof document !== "undefined"
        ? createPortal(
          <div
            id="desktop-commit-composer"
            ref={composerRef}
            role="dialog"
            aria-label={composerLabel}
            data-testid="desktop-commit-composer"
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-60 flex flex-col overflow-hidden rounded-xl border border-(--divider) bg-(--sidebar-bg) shadow-2xl"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--divider) px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-(--text-primary)">
                  {t("gitPanel.commit.composerTitle")}
                </p>
                <p className="truncate text-[10px] text-(--text-muted)">{worktreeName}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={openChangedFiles}
                  className="h-7 rounded-md px-2 text-[11px] font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
                >
                  {t("gitPanel.commit.reviewFiles")}
                </button>
                <button
                  type="button"
                  onClick={closeComposer}
                  aria-label={t("gitPanel.commit.closeComposer")}
                  title={t("gitPanel.commit.closeComposer")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto p-2.5">
              <GitCommitForm
                pendingVerb={controller.pendingVerb}
                generateError={controller.generateMessageError}
                generating={controller.generatingMessage}
                message={controller.commitMessage}
                onCommit={() => void commitFromComposer()}
                onGenerate={() => void controller.generateCommitMessage()}
                onMessageChange={controller.setCommitMessage}
                primaryAction={controller.primaryAction}
                totals={controller.commitTotals}
              >
                <div className="max-h-40 overflow-y-auto rounded-md border border-(--divider) bg-(--sidebar-bg)">
                  <p className="border-b border-(--divider) px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-(--text-muted)">
                    {t("gitPanel.commit.changedFiles")}
                  </p>
                  {data.changedFiles.map((file) => (
                    <label
                      key={file.path}
                      className="flex cursor-pointer items-center gap-2 border-b border-(--divider)/60 px-2 py-1.5 last:border-b-0 hover:bg-(--sidebar-hover)"
                    >
                      <input
                        type="checkbox"
                        checked={controller.isSelectedForCommit(file.path)}
                        disabled={controller.pendingVerb !== null}
                        onChange={() => controller.toggleCommitFile(file.path)}
                        aria-label={t("gitPanel.commit.includeFile", { path: file.path })}
                        data-testid={`desktop-commit-file-checkbox-${file.path}`}
                        className="h-3.5 w-3.5 shrink-0 accent-(--accent)"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--text-secondary)">
                        {file.path}
                      </span>
                      {file.diffStats ? (
                        <span className="shrink-0 font-mono text-[10px] tabular-nums" aria-label={`${file.diffStats.added} additions, ${file.diffStats.removed} deletions`}>
                          <span className="text-(--status-success-text)">+{file.diffStats.added}</span>{" "}
                          <span className="text-(--status-error-text)">−{file.diffStats.removed}</span>
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </GitCommitForm>
            </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

function calculateComposerPosition(trigger: HTMLElement): ComposerPosition {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(
    COMPOSER_WIDTH,
    Math.max(0, window.innerWidth - ANCHORED_VIEWPORT_MARGIN * 2),
  );
  const top = rect.bottom + 6;
  return {
    top,
    left: resolveAnchoredAlignedLeft({
      anchorRight: rect.right,
      elementWidth: width,
      viewportWidth: window.innerWidth,
    }),
    width,
    maxHeight: Math.max(0, window.innerHeight - top - ANCHORED_VIEWPORT_MARGIN),
  };
}
