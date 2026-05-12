"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Bot, FileText, GitCommitHorizontal, X } from "lucide-react";
import { useElectronPlatform } from "@/hooks/use-electron-platform";
import type { GitChangedFile } from "@/types/git";
import { AgentContextPanel } from "./agent-context-panel";
import {
  GitPanelCommitsSection,
  GitPanelContentSection,
  GitPanelFooterSection,
  GitPanelSummarySection,
} from "./git-panel-sections";
import { useGitPanelController } from "./use-git-panel-controller";
import {
  openWorkspaceFileTab,
  previewWorkspaceFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { WorkspaceFilePanel } from "@/components/workspace/workspace-file-panel";
import { cn } from "@/lib/utils";

type GitPanelTab = "git" | "files" | "agent";

function GitPanelTabButton({
  active,
  children,
  icon,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-6 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors",
        active
          ? "bg-(--sidebar-bg) text-(--text-primary) shadow-sm"
          : "text-(--text-muted) hover:text-(--text-primary)",
      )}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function GitPanel({
  sessionId,
  width,
  className,
  closeLabel = "Close right Git panel",
  onClose,
}: {
  sessionId: string | null;
  width: number | string;
  className?: string;
  closeLabel?: string;
  onClose?: () => void;
}) {
  const isWindowsElectron = useElectronPlatform() === "win32";
  const controller = useGitPanelController(sessionId);
  const [activePanelTab, setActivePanelTab] = useState<GitPanelTab>("git");

  const openDiffFile = useCallback((file: GitChangedFile) => {
    if (!sessionId) return;
    previewWorkspaceFileTab(sessionId, "diff", file.path);
  }, [sessionId]);

  const pinDiffFile = useCallback((file: GitChangedFile) => {
    if (!sessionId) return;
    openWorkspaceFileTab(sessionId, "diff", file.path);
  }, [sessionId]);

  const openReadOnlyFile = useCallback((file: GitChangedFile) => {
    if (!sessionId || file.state === "deleted") return;
    openWorkspaceFileTab(sessionId, "file", file.path);
  }, [sessionId]);

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 cursor-default flex-col border-l border-(--chat-header-border) bg-(--sidebar-bg)",
        className,
      )}
      style={{ width: typeof width === "number" ? `${width}px` : width }}
    >
      {isWindowsElectron ? (
        <div className="electron-drag h-[40px] shrink-0 border-b border-(--electron-titlebar-border) bg-(--electron-titlebar-bg)" />
      ) : null}

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--chat-header-border) px-2">
        <div
          role="tablist"
          aria-label="Right panel"
          className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md bg-(--sidebar-hover) p-0.5"
        >
          <GitPanelTabButton
            active={activePanelTab === "git"}
            icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
            onClick={() => setActivePanelTab("git")}
          >
            Git
          </GitPanelTabButton>
          <GitPanelTabButton
            active={activePanelTab === "files"}
            icon={<FileText className="h-3.5 w-3.5" />}
            onClick={() => setActivePanelTab("files")}
          >
            Files
          </GitPanelTabButton>
          <GitPanelTabButton
            active={activePanelTab === "agent"}
            icon={<Bot className="h-3.5 w-3.5" />}
            onClick={() => setActivePanelTab("agent")}
          >
            Agent
          </GitPanelTabButton>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            aria-label={closeLabel}
            title={closeLabel}
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
        showDetails={activePanelTab === "git"}
      />

      {activePanelTab === "files" ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFilePanel key={sessionId ?? "no-session"} sessionId={sessionId} />
        </div>
      ) : activePanelTab === "agent" ? (
        <div className="min-h-0 flex-1">
          <AgentContextPanel sessionId={sessionId} />
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
            onOpenDiffFile={openDiffFile}
            onPinDiffFile={pinDiffFile}
            onOpenReadOnlyFile={openReadOnlyFile}
          />

          <GitPanelCommitsSection
            data={controller.data}
            loading={controller.loading}
            error={controller.error}
          />

          {controller.data && !controller.loading && !controller.error ? (
            <GitPanelFooterSection
              data={controller.data}
              isSessionBusy={controller.isSessionBusy}
              activeAction={controller.activeAction}
              actionInput={controller.actionInput}
              mergePrPromptDraft={controller.mergePrPromptDraft}
              mergePrPromptPreview={controller.mergePrPromptPreview}
              mergeSource={controller.mergeSource}
              prBaseBranch={controller.prBaseBranch}
              checksUrl={controller.checksUrl}
              onActionInputChange={controller.setActionInput}
              onSetMergeSource={controller.setMergeSource}
              onSetPrBaseBranch={controller.setPrBaseBranch}
              onCommit={controller.handleCommit}
              onFetch={controller.handleFetch}
              onMerge={controller.handleMerge}
              onCreatePr={controller.handleCreatePr}
              onMergePr={controller.handleMergePr}
              onMergePrPromptChange={controller.setMergePrPromptDraft}
              onOpenAction={controller.openAction}
              onCloseAction={controller.closeAction}
              onResetMergePrPrompt={controller.resetMergePrPromptDraft}
              onPush={controller.handlePush}
              onPull={controller.handlePull}
              onOpenExternal={controller.openExternal}
              fetching={controller.fetching}
            />
          ) : null}
        </>
      )}
    </aside>
  );
}
