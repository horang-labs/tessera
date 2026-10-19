"use client";

import type React from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  List,
  ListTree,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { GitRevertConfirmDialog } from "@/components/git/git-revert-confirm-dialog";
import {
  WorkspaceFileIcon, WorkspaceFileName, WorkspaceTreeBranchGuide,
  workspaceTreeFileRowClassName, workspaceTreePadding,
} from "@/components/workspace/workspace-tree-row";
import { WorkspaceTreeExpansionControls } from "@/components/workspace/workspace-tree-expansion-controls";
import { clickPointerType, shouldOpenOnRowClick } from "@/components/workspace/workspace-inline-input-state";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { clearPathInsertDragData, setPathInsertDragData, setWorkspaceTargetFileDragData } from "@/lib/dnd/panel-session-drag";
import type { WorkspaceTarget } from "@/types/worktree";
import { useI18n } from "@/lib/i18n";
import {
  canUseElectronFileActions,
  openFilePathOnHost,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import { cn } from "@/lib/utils";
import { deriveGitConflictRecovery } from "@/lib/git/git-conflict-recovery";
import type { GitPrimaryAction } from "@/lib/git/primary-git-action";
import type { GitMenuAction, GitMenuActionId } from "@/lib/git/git-action-menu";
import type { GitPendingVerb } from "./use-git-panel-controller";
import { canRevertFile } from "@/lib/git/revert-eligibility";
import type {
  GitChangedFile,
  GitConflictOperation,
  GitDiffData,
  GitPanelData,
} from "@/types/git";
import { buildChangedFileRows, type ChangedFileRow } from "@/lib/git/changed-file-tree";
import { useGitStore } from "@/stores/git-store";
import { isCurrentTaskPr } from '@/types/task-pr-status';
import { GitActionMenu } from "./git-action-menu";
import { GitActionFailureBanner } from "./git-action-failure-banner";
import { GitConflictResolveWithAiButton } from "./git-conflict-ai-button";
import type { GitActionFailureReport } from "./git-action-report";
import { GitCommitForm } from "./git-commit-form";
import { GitChangedFileList } from "./git-changed-file-list";
import { GitPrimaryActionBar } from "./git-primary-action";
import {
  telemetryClickAttributes,
  type TelemetryUiControl,
} from "@/lib/telemetry/ui-click";
import {
  FILE_STATE_META,
} from "./git-panel-shared";
import {
  expandCommitSelectionItems,
  nextCommitInclusion,
  resolveCommitSelectionRange,
  resolveCommitTreeKeyTarget,
  useCommitFileSelection,
} from "./git-commit-selection";

function formatShortCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(value / 1000)}k`;
}

const subscribeToStaticClientValue = () => () => {};
const getNoElectronFileActions = () => false;

function formatDiffMetric(
  data: GitPanelData,
  changedFileCount: number,
): string {
  if (!data.diffStats) return String(changedFileCount);
  const addedSuffix = data.diffStats.addedLinesIncomplete ? "…" : "";
  return `+${formatShortCount(data.diffStats.added)}${addedSuffix} -${formatShortCount(data.diffStats.removed)} / ${data.diffStats.changedFiles}`;
}

function formatPrState(state: NonNullable<GitPanelData["prStatus"]>["state"]): string {
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

function formatRemoteBranchState(value: boolean | undefined): string {
  if (value === true) return "Remote branch present";
  if (value === false) return "Remote branch missing";
  return "Remote branch unknown";
}

function getGitHubSummaryMessage(data: GitPanelData): string {
  if (data.prUnsupported) return "GitHub PR sync is unavailable for this task.";
  if (data.remoteBranchExists === true) return "Remote branch exists. No PR linked yet.";
  if (data.remoteBranchExists === false) return "Remote branch is missing. No PR linked yet.";
  return data.github.reason ?? "No pull request is linked to this branch yet.";
}

function getGitPanelProjectName(data: GitPanelData): string {
  const worktreeSegments = data.worktreeName.split("/").filter(Boolean);
  return worktreeSegments.length > 1 ? worktreeSegments[0] : data.repoName;
}

function getGitPanelWorktreeName(data: GitPanelData): string {
  const worktreeSegments = data.worktreeName.split("/").filter(Boolean);
  return worktreeSegments.length > 1
    ? worktreeSegments.slice(1).join("/")
    : data.worktreeName;
}

/**
 * The recorded base, shortened for a row that is 4.5rem of label and whatever
 * is left. The remote stays (`origin/dev`, not `dev`) because a base on a
 * remote and one on a local branch of the same name are different answers, and
 * this row exists to tell them apart.
 */
export function formatGitBaseRefLabel(baseRef: string): string {
  return baseRef
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function GitSummaryCopyButton({
  ariaLabel,
  disabled,
  onClick,
  telemetryControl,
  tooltip,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onClick: () => void;
  telemetryControl: TelemetryUiControl;
  tooltip: string;
}) {
  return (
    <Tooltip content={tooltip} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        // Below the Phone viewport step the button is simply present: `hover:` compiles
        // to `@media (hover: hover)`, so on a phone no rule exists to reveal it. The
        // reveal is kept from `sm` up (#250).
        className="pointer-events-auto h-6 w-6 shrink-0 rounded text-(--text-muted) opacity-100 sm:pointer-events-none sm:opacity-0 transition-opacity hover:text-(--text-primary) sm:group-hover/summary-copy:pointer-events-auto sm:group-hover/summary-copy:opacity-100 group-focus-within/summary-copy:pointer-events-auto group-focus-within/summary-copy:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        onClick={onClick}
        {...telemetryClickAttributes(telemetryControl, "git_panel")}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </Tooltip>
  );
}

/*
 * The commit tree follows the JetBrains commit view: indent, disclosure slot,
 * checkbox, icon, name. Files reserve the disclosure slot so every checkbox at
 * one depth sits in one column, and a child's checkbox steps in under its
 * folder's.
 */
const COMMIT_TREE_CHECKBOX_OFFSET = 18;
const COMMIT_TREE_CONTENT_OFFSET = 38;

const commitCheckboxClassName = "absolute top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 cursor-pointer accent-(--accent) disabled:cursor-not-allowed disabled:opacity-50";

function CommitFolderCheckbox({
  checked,
  mixed,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "ref"> & { mixed: boolean }) {
  // `indeterminate` is a DOM property; set it on every render that changes it.
  const ref = useCallback((node: HTMLInputElement | null) => {
    if (node) node.indeterminate = mixed;
  }, [mixed]);
  return <input {...props} ref={ref} type="checkbox" checked={checked} />;
}

function FileBadge({ file }: { file: GitChangedFile }) {
  const meta = FILE_STATE_META[file.state];
  const display =
    file.state === "untracked" ? "U" : file.displayStatus;

  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center font-mono text-[10px] font-semibold leading-none",
        meta.statusClassName,
      )}
      aria-label={meta.label}
    >
      {display}
    </span>
  );
}

/**
 * Keep the leaf name visible when the Git panel is narrow. A conventional
 * end-truncated path hides the part people use to tell adjacent files apart.
 */
function FilePath({ path }: { path: string }) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex === -1) {
    return <WorkspaceFileName name={path} />;
  }

  const directory = path.slice(0, slashIndex);
  const filename = path.slice(slashIndex + 1);

  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden" title={path}>
      <span className="flex min-w-0 flex-1 overflow-hidden" data-git-file-name>
        <WorkspaceFileName name={filename} />
      </span>
      <span className="max-w-[45%] min-w-0 shrink truncate text-[11px] text-(--text-muted)" data-git-file-directory>{directory}</span>
    </span>
  );
}

function FileDiffStats({ stats }: { stats: GitChangedFile["diffStats"] }) {
  if (!stats) return null;
  if (stats.added === 0 && stats.removed === 0) return null;

  return (
    <span
      className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums"
      aria-label={`+${stats.added.toLocaleString()} -${stats.removed.toLocaleString()}`}
    >
      {stats.added > 0 ? (
        <span className="text-(--status-success-text)">
          +{formatShortCount(stats.added)}
        </span>
      ) : null}
      {stats.removed > 0 ? (
        <span className="text-(--status-error-text)">
          -{formatShortCount(stats.removed)}
        </span>
      ) : null}
    </span>
  );
}

function RecentCommitsSection({ data }: { data: GitPanelData }) {
  const [expanded, setExpanded] = useState(false);
  const commits = data.recentCommits.slice(0, 5);

  if (commits.length === 0) return null;

  return (
    <div className="border-t border-(--chat-header-border) px-3 py-2">
      <button
        {...telemetryClickAttributes('git.section.toggle', 'git_panel')}
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
      >
        <span className="flex min-w-0 items-center gap-2">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
          <span className="text-[10px] font-medium uppercase tracking-[0.18em]">
            Recent commits
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="mt-1 space-y-1">
          {commits.map((commit) => (
            <div
              key={`${commit.oidShort}-${commit.subject}`}
              className="rounded-md px-1.5 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-[color:var(--accent)]">
                  {commit.oidShort}
                </span>
                <span className="shrink-0 text-[10px] text-(--text-muted)">
                  {commit.relativeDate}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-(--text-secondary)">
                {commit.subject}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyPanelMessage({
  title,
  body,
  icon = "git",
}: {
  title: string;
  body: string;
  icon?: "clean" | "error" | "git";
}) {
  const Icon =
    icon === "clean" ? CheckCircle2 : icon === "error" ? AlertCircle : GitCommitHorizontal;
  const iconClassName =
    icon === "clean"
      ? "text-[#2f8753]"
      : icon === "error"
        ? "text-[#c94c4c]"
        : "text-(--text-muted)";

  return (
    <div className="flex h-full items-center justify-center p-5">
      <div className="max-w-[240px] text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-(--divider) bg-(--sidebar-hover)">
          <Icon className={cn("h-5 w-5", iconClassName)} />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">
          {title}
        </p>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {body}
        </p>
      </div>
    </div>
  );
}

export function GitPanelCommitsSection({
  data,
  error,
  loading,
}: {
  data: GitPanelData | null;
  error: string | null;
  loading: boolean;
}) {
  if (loading || error || !data) return null;
  return <RecentCommitsSection data={data} />;
}

function DiffLine({ line }: { line: string }) {
  let className = "text-(--text-secondary)";

  if (line.startsWith("+") && !line.startsWith("+++")) {
    className = "bg-[#2f8753]/8 text-[#2f8753]";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    className = "bg-[#c94c4c]/8 text-[#c94c4c]";
  }
  if (line.startsWith("@@")) {
    className = "bg-[#4a8cd6]/10 text-[#4a8cd6]";
  }
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    className = "text-(--text-primary)";
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    className = "text-[#9b7f35]";
  }

  return (
    <div
      className={cn(
        "whitespace-pre px-3 py-0.5 font-mono text-[11px] leading-5",
        className,
      )}
    >
      {line || " "}
    </div>
  );
}

export function DiffPreview({
  diffData,
  diffError,
  diffLoading,
  selectedFile,
  hideFileHeader = false,
  onCopyFilePath,
}: {
  diffData: GitDiffData | null;
  diffError: string | null;
  diffLoading: boolean;
  selectedFile: GitChangedFile | null;
  hideFileHeader?: boolean;
  onCopyFilePath?: (relativePath: string) => void;
}) {
  const { t } = useI18n();

  if (!selectedFile) {
    return (
      <EmptyPanelMessage
        title={t("gitPanel.empty.cleanTitle")}
        body={t("gitPanel.empty.cleanBody")}
        icon="clean"
      />
    );
  }

  if (diffLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
      </div>
    );
  }

  if (diffError) {
    return (
      <EmptyPanelMessage
        title={t("gitPanel.empty.diffUnavailableTitle")}
        body={diffError}
        icon="error"
      />
    );
  }

  if (!diffData) {
    return (
      <EmptyPanelMessage
        title={t("gitPanel.empty.selectFileTitle")}
        body={t("gitPanel.empty.selectFileBody")}
      />
    );
  }

  return (
    <ScrollArea className="h-full rounded-2xl border border-(--divider) bg-(--chat-bg)">
      {!hideFileHeader ? (
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-(--divider) bg-(--chat-bg)/95 px-3 py-2 backdrop-blur">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-(--text-primary)">
              {selectedFile.path}
            </p>
            <p className="text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
              {FILE_STATE_META[selectedFile.state].label}
              {diffData.truncated ? " · truncated" : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onCopyFilePath ? (
              <Tooltip content="Copy absolute path" side="top">
                <button
                  {...telemetryClickAttributes('git.diff.copy', 'git_panel')}
                  type="button"
                  onClick={() => onCopyFilePath(selectedFile.path)}
                  className="rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                  aria-label={`Copy absolute path for ${selectedFile.path}`}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            ) : null}
            <FileBadge file={selectedFile} />
          </div>
        </div>
      ) : null}
      <div className="py-2">
        {diffData.diff.split("\n").map((line, index) => (
          <DiffLine key={`${index}-${line.slice(0, 12)}`} line={line} />
        ))}
      </div>
    </ScrollArea>
  );
}

export function GitPanelSummarySection({
  changedFileCount,
  data,
  error,
  loading,
  onCopyBranch,
  onCopyWorktreePath,
  onOpenExternal,
  showDetails = true,
}: {
  changedFileCount: number;
  data: GitPanelData | null;
  error: string | null;
  loading: boolean;
  onCopyBranch: () => void;
  onCopyWorktreePath: () => void;
  onOpenExternal: (url: string | null | undefined) => void;
  showDetails?: boolean;
}) {
  const { t } = useI18n();
  const projectName = data ? getGitPanelProjectName(data) : "Repository";
  const worktreeName = data ? getGitPanelWorktreeName(data) : "worktree";
  const branchName = data?.branch ?? "branch";
  const worktreeTooltip = data?.worktreePath ?? "Worktree path unavailable";
  const canOpenWorktreeFolder = useSyncExternalStore(
    subscribeToStaticClientValue,
    canUseElectronFileActions,
    getNoElectronFileActions,
  );
  const prUrl = data?.prStatus?.url ?? data?.github.pullRequest?.url;
  const historicalPr = data?.prStatus ? !isCurrentTaskPr(data.prStatus) : false;
  const prLabel = data?.prStatus
    ? historicalPr
      ? t('gitPanel.pr.previousLabel', { number: data.prStatus.number })
      : data.github.pullRequest?.title
      ? `#${data.prStatus.number} ${data.github.pullRequest.title}`
      : `PR #${data.prStatus.number}`
    : "No PR";

  return (
    <div className="cursor-default border-b border-(--chat-header-border) px-3 py-3">
      <div className={cn("flex items-start justify-between gap-3", showDetails && "mb-3")}>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.22em] text-(--text-muted)">
            Git
          </p>
          {data?.repoUrl ? (
            <Tooltip content="Open repository" side="bottom" wrapperClassName="mt-1 min-w-0 max-w-full">
              <h3 className="min-w-0 text-sm font-semibold text-(--text-primary)">
                <button
                  type="button"
                  className="inline-flex max-w-full cursor-pointer items-center gap-1.5 truncate text-left hover:text-(--accent)"
                  onClick={() => onOpenExternal(data.repoUrl)}
                  {...telemetryClickAttributes("git.repository.open", "git_panel")}
                  aria-label={`Open repository ${projectName}`}
                >
                  <span className="min-w-0 truncate">{projectName}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </button>
              </h3>
            </Tooltip>
          ) : (
            <h3 className="mt-1 min-w-0 text-sm font-semibold text-(--text-primary)">
              <span className="block truncate">{projectName}</span>
            </h3>
          )}
          <div className="mt-2 grid gap-1 text-[11px]">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
              <span className="text-(--text-muted)">Worktree</span>
              <div className="group/summary-copy flex min-w-0 items-center gap-1">
                <Tooltip
                  content={worktreeTooltip}
                  side="bottom"
                  wrapperClassName="min-w-0 max-w-full flex-1"
                >
                  <span
                    className="block min-w-0 truncate font-mono text-(--text-muted)"
                  >
                    {worktreeName}
                  </span>
                </Tooltip>
                {data ? (
                  <>
                    {canOpenWorktreeFolder ? (
                      <Tooltip content="Open worktree folder" side="top">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 rounded text-(--text-muted) hover:text-(--text-primary)"
                          onClick={() => openFilePathOnHost(data.worktreePath)}
                          {...telemetryClickAttributes("git.worktree_folder.open", "git_panel")}
                          aria-label="Open worktree folder"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    ) : null}
                    <GitSummaryCopyButton
                      ariaLabel="Copy full worktree path"
                      onClick={onCopyWorktreePath}
                      telemetryControl="git.worktree_path.copy"
                      tooltip="Copy full worktree path"
                    />
                  </>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
              <span className="text-(--text-muted)">Branch</span>
              <div className="group/summary-copy flex min-w-0 items-center gap-1">
                <span
                  className="block min-w-0 flex-1 truncate font-mono text-(--text-muted)"
                >
                  {branchName}
                </span>
                {data ? (
                  <GitSummaryCopyButton
                    ariaLabel="Copy branch name"
                    onClick={onCopyBranch}
                    telemetryControl="git.branch.copy"
                    tooltip="Copy branch name"
                  />
                ) : null}
              </div>
            </div>
            {/*
              Only when there is one. Git records no lineage of its own, so a
              branch made outside Tessera has no answer here, and an empty row
              would read as "no base" rather than "not known".
            */}
            {data?.baseRef ? (
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
                <span className="text-(--text-muted)">Base</span>
                <Tooltip
                  content={`Branched from ${data.baseRef}`}
                  side="bottom"
                  wrapperClassName="min-w-0 max-w-full"
                >
                  <span
                    className="block min-w-0 truncate font-mono text-(--text-muted)"
                    data-testid="git-panel-base-ref"
                  >
                    {formatGitBaseRefLabel(data.baseRef)}
                  </span>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {!showDetails ? null : loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-(--divider) bg-(--chat-bg) px-3 py-3 text-sm text-(--text-muted)">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>Loading git surface…</span>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-[#c94c4c]/30 bg-[#c94c4c]/10 px-3 py-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 text-[#c94c4c]" />
            <div>
              <p className="text-sm font-medium text-(--text-primary)">
                Git panel unavailable
              </p>
              <p className="mt-1 text-xs leading-5 text-(--text-muted)">
                {error}
              </p>
            </div>
          </div>
        </div>
      ) : data ? (
        <div className="rounded-xl border border-(--divider) bg-(--chat-bg) px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
                {prUrl ? (
                  <Tooltip content={`Open PR #${data.prStatus?.number ?? data.github.pullRequest?.number}`} side="top" wrapperClassName="min-w-0">
                    <button
                      type="button"
                      className={cn(
                        "min-w-0 cursor-pointer truncate text-left text-xs font-semibold hover:text-(--accent)",
                        historicalPr ? "text-(--text-muted)" : "text-(--text-primary)",
                      )}
                      onClick={() => onOpenExternal(prUrl)}
                      {...telemetryClickAttributes("git.pull_request.open", "git_panel")}
                      aria-label={`Open pull request ${data.prStatus?.number ?? data.github.pullRequest?.number}`}
                    >
                      {prLabel}
                    </button>
                  </Tooltip>
                ) : (
                  <p className="truncate text-xs font-semibold text-(--text-primary)">
                    {prLabel}
                  </p>
                )}
                {data.prStatus ? (
                  <span className="shrink-0 rounded-full border border-(--divider) px-1.5 py-0.5 text-[10px] font-medium text-(--text-muted)">
                    {formatPrState(data.prStatus.state)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-(--text-muted)">
                {data.prStatus
                  ? formatRemoteBranchState(data.remoteBranchExists)
                  : getGitHubSummaryMessage(data)}
              </p>
            </div>
            {data.remoteBranchExists === false ? (
              <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-[#c94c4c]" />
            ) : (
              <Cloud
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  data.remoteBranchExists === true
                    ? "text-[#2f8753]"
                    : "text-(--text-muted)",
                )}
              />
            )}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-(--divider) pt-2">
            <span className="text-[10px] uppercase tracking-[0.16em] text-(--text-muted)">
              Diff
            </span>
            <span className="font-mono text-[11px] text-(--text-primary) tabular-nums">
              {formatDiffMetric(data, changedFileCount)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function GitPanelContentSection({
  changedFileCount,
  commit,
  conflictHandoff,
  data,
  error,
  failure,
  loading,
  menu,
  primary,
  phoneScrollableContent,
  revert,
  selectedPath,
  sessionId,
  workspaceTarget,
  targetSelected = Boolean(sessionId),
  setSelectedPath,
  onCopyFilePath,
  onOpenDiffFile,
  onPinDiffFile,
  onOpenReadOnlyFile,
}: {
  changedFileCount: number;
  commit: {
    draftBlocked: boolean;
    generateError: string | null;
    generating: boolean;
    isSelected: (path: string) => boolean;
    message: string;
    onGenerate: () => void;
    onMessageChange: (value: string) => void;
    onSetAllSelected: (selected: boolean) => void;
    onSetSelected: (paths: readonly string[], selected: boolean) => void;
    selectionKey: string | null;
    totals: { files: number; added: number; addedIncomplete?: boolean; removed: number };
  };
  conflictHandoff: {
    available: boolean;
    pending: boolean;
    onPrepare: () => void;
  };
  data: GitPanelData | null;
  error: string | null;
  /**
   * The last Git action that failed, or null. Distinct from `error`, which is
   * the panel failing to load: this one is a panel that reads fine reporting a
   * command that did not (#248).
   */
  failure: {
    report: GitActionFailureReport | null;
    onDismiss: () => void;
  };
  loading: boolean;
  /** The one Git action this state calls for, and the press that runs it. */
  primary: {
    action: GitPrimaryAction;
    /** What is running here, whether this button or the menu started it. */
    pendingVerb: GitPendingVerb | null;
    onRun: () => void;
  };
  /** Reverting the selected changed files (§2). The selection is the commit's. */
  revert: {
    onConfirm: () => void;
    pending: boolean;
  };
  /** Phone-only content that joins the changed files in one scroll region. */
  phoneScrollableContent?: {
    summary: React.ReactNode;
    commits: React.ReactNode;
  };
  /** Every Git action, always, derived independently of the primary (§4). */
  menu: {
    actions: readonly GitMenuAction[];
    onRun: (id: GitMenuActionId) => void;
  };
  selectedPath: string | null;
  sessionId: string | null;
  workspaceTarget?: WorkspaceTarget | null;
  targetSelected?: boolean;
  setSelectedPath: (path: string | null) => void;
  onCopyFilePath: (relativePath: string) => void;
  onOpenDiffFile: (file: GitChangedFile) => void;
  onPinDiffFile: (file: GitChangedFile) => void;
  onOpenReadOnlyFile: (file: GitChangedFile) => void;
}) {
  const { t } = useI18n();
  const recovery = deriveGitConflictRecovery(data);
  const [contextMenu, setContextMenu] = useState<{
    absolutePath: string;
    canOpenFile: boolean;
    position: { x: number; y: number };
  } | null>(null);
  // The changed files picked for revert, or null when no confirm is pending.
  const [revertPendingFiles, setRevertPendingFiles] = useState<
    GitChangedFile[] | null
  >(null);

  // One element, handed to whichever of the two surfaces draws the button: the
  // menu is the same list either way, and §4 keeps it beside the button on every
  // rung rather than only on the ones with a commit form under them.
  const actionMenu = (
    <GitActionMenu
      actions={menu.actions}
      pending={primary.pendingVerb !== null}
      commitDraftBlocked={commit.draftBlocked}
      onRun={menu.onRun}
    />
  );

  const actionArea = primary.action.kind === "commit" || primary.action.kind === "loading" ? (
    <GitCommitForm
      pendingVerb={primary.pendingVerb}
      generateError={commit.generateError}
      generating={commit.generating}
      menu={actionMenu}
      message={commit.message}
      onCommit={primary.onRun}
      onGenerate={commit.onGenerate}
      onMessageChange={commit.onMessageChange}
      primaryAction={primary.action}
      totals={commit.totals}
    />
  ) : (
    <GitPrimaryActionBar
      action={primary.action}
      menu={actionMenu}
      pendingVerb={primary.pendingVerb}
      onRun={primary.onRun}
    />
  );
  const hasTarget = targetSelected ?? Boolean(sessionId);
  const allCommitFilesSelected = changedFileCount > 0
    && commit.totals.files === changedFileCount;
  const someCommitFilesSelected = commit.totals.files > 0;
  // The commit selection is the revert selection (§2): only the files that can
  // actually be reverted participate in the button's enabled state.
  const revertableSelectedFiles = (data?.changedFiles ?? []).filter(
    (file) => commit.isSelected(file.path) && canRevertFile(file),
  );
  const filesView = useGitStore((state) => state.changedFilesView);
  const setFilesView = useGitStore((state) => state.setChangedFilesView);
  const [folderState, setFolderState] = useState<{ target: string | null; collapsed: Set<string> }>({ target: null, collapsed: new Set() });
  const fileRows = useMemo((): ChangedFileRow[] => {
    const files = data?.changedFiles ?? [];
    if (filesView === "list") return files.map((file) => ({ kind: "file", path: file.path, name: file.path, depth: 0, file }));
    return buildChangedFileRows(files, folderState.target === commit.selectionKey ? folderState.collapsed : new Set());
  }, [data?.changedFiles, filesView, folderState, commit.selectionKey]);
  const selectionItems = useMemo(
    () => fileRows.map((row) => ({ path: row.path, filePaths: row.kind === "folder" ? row.filePaths : undefined })),
    [fileRows],
  );
  const rowPaths = useMemo(() => fileRows.map((row) => row.path), [fileRows]);
  const isFolderExpanded = (path: string) =>
    !(folderState.target === commit.selectionKey && folderState.collapsed.has(path));
  function toggleFolder(path: string) {
    setFolderState((previous) => {
      const collapsed = new Set(previous.target === commit.selectionKey ? previous.collapsed : []);
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      return { target: commit.selectionKey, collapsed };
    });
  }
  const { selectAllCheckboxRef, setFileSelected } = useCommitFileSelection({
    allSelected: allCommitFilesSelected,
    files: selectionItems,
    onSetSelected: commit.onSetSelected,
    someSelected: someCommitFilesSelected,
    targetKey: commit.selectionKey,
  });

  // Row selection, distinct from commit inclusion (the checkboxes), as in the
  // JetBrains commit view: pick rows with click / Shift / Ctrl, then Space or
  // any one selected checkbox includes or excludes the lot. Rows hidden by a
  // collapse drop out; with no live selection the diff file stands in.
  const [treeSelection, setTreeSelection] = useState<{
    target: string | null;
    rows: readonly string[];
    anchor: string | null;
    lead: string | null;
  }>({ target: null, rows: [], anchor: null, lead: null });
  const [treeFocused, setTreeFocused] = useState(false);
  const liveTreeSelection = treeSelection.target === commit.selectionKey ? treeSelection : null;
  const selectedRows = useMemo(() => {
    const visible = new Set(rowPaths);
    const rows = (liveTreeSelection?.rows ?? []).filter((path) => visible.has(path));
    if (rows.length > 0) return rows;
    return selectedPath && visible.has(selectedPath) ? [selectedPath] : [];
  }, [liveTreeSelection, rowPaths, selectedPath]);
  const selectedRowSet = useMemo(() => new Set(selectedRows), [selectedRows]);
  const leadPath = liveTreeSelection?.lead && rowPaths.includes(liveTreeSelection.lead)
    ? liveTreeSelection.lead
    : selectedRows[0] ?? null;
  const leadIndex = leadPath ? rowPaths.indexOf(leadPath) : -1;
  const [scrollIndex, setScrollIndex] = useState<number | null>(null);

  function selectTreeRow(path: string, mode: "replace" | "range" | "toggle") {
    const anchor = liveTreeSelection?.anchor && rowPaths.includes(liveTreeSelection.anchor)
      ? liveTreeSelection.anchor
      : leadPath;
    let rows: readonly string[];
    let nextAnchor = path;
    if (mode === "range" && anchor) {
      rows = resolveCommitSelectionRange(rowPaths, anchor, path, true).paths;
      nextAnchor = anchor;
    } else if (mode === "toggle") {
      rows = selectedRowSet.has(path)
        ? selectedRows.filter((row) => row !== path)
        : [...selectedRows, path];
    } else {
      rows = [path];
    }
    setTreeSelection({ target: commit.selectionKey, rows, anchor: nextAnchor, lead: path });
    const row = fileRows.find((candidate) => candidate.path === path);
    if (row?.kind === "file") setSelectedPath(path);
  }

  function clickSelectionMode(event: React.MouseEvent): "replace" | "range" | "toggle" {
    if (event.shiftKey) return "range";
    return event.metaKey || event.ctrlKey ? "toggle" : "replace";
  }

  function toggleSelectedInclusion() {
    if (primary.pendingVerb !== null) return;
    const files = expandCommitSelectionItems(selectionItems, selectedRows);
    if (files.length === 0) return;
    commit.onSetSelected(files, nextCommitInclusion(files, commit.isSelected));
  }

  function handleTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey) return;
    // A clicked checkbox or row button keeps focus; hand it back to the tree so
    // the lead ring, not a stray control ring, shows where the keys go.
    // Row actions (open diff, copy path) stay ordinary tab stops with their own keys.
    if (event.target !== event.currentTarget) {
      if ((event.target as HTMLElement).tabIndex !== -1 || event.key === "Tab") return;
      event.currentTarget.focus({ preventScroll: true });
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (event.key === " " && !modifier) {
      event.preventDefault();
      toggleSelectedInclusion();
      return;
    }
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (rowPaths.length === 0) return;
      setTreeSelection({ target: commit.selectionKey, rows: rowPaths, anchor: rowPaths[0], lead: leadPath ?? rowPaths[0] });
      return;
    }
    if (event.key === "Escape" && selectedRows.length > 1 && leadPath) {
      event.preventDefault();
      setTreeSelection({ target: commit.selectionKey, rows: [leadPath], anchor: leadPath, lead: leadPath });
      return;
    }
    if (event.key === "Enter" && leadIndex >= 0) {
      event.preventDefault();
      const row = fileRows[leadIndex];
      if (row.kind === "folder") toggleFolder(row.path);
      else onOpenDiffFile(row.file);
      return;
    }
    if (modifier) return;
    const target = resolveCommitTreeKeyTarget(fileRows, leadIndex, event.key, isFolderExpanded);
    if (!target) return;
    event.preventDefault();
    if (target.kind === "toggle") {
      toggleFolder(target.path);
      return;
    }
    const extend = event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End");
    selectTreeRow(rowPaths[target.index], extend ? "range" : "replace");
    setScrollIndex(target.index);
  }

  // Space on a focused button or checkbox would otherwise activate it on keyup.
  function handleTreeKeyUp(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === " " && (event.target as HTMLElement).tabIndex === -1) event.preventDefault();
  }

  const leadRingClassName = "outline outline-1 -outline-offset-1 outline-(--accent)";

  const contentBody = (
    <>
      {!hasTarget && !loading ? (
        <EmptyPanelMessage
          title={t("gitPanel.empty.noWorktreeTitle")}
          body={t("gitPanel.empty.noWorktreeBody")}
        />
      ) : null}

      {!hasTarget ? null : (
        <div className={cn("flex flex-col gap-2", !phoneScrollableContent && "h-full")}>
          {/*
            The primary action renders on every rung, including the ones where
            the panel below it has nothing to show — a clean tree still has a
            push to offer, and a session whose state has not arrived holds a
            disabled Commit rather than a gap (ADR 0007).
          */}
          {phoneScrollableContent ? null : actionArea}

          {/*
            Directly under the button that raised it, and outside the gate
            below: a failure has to be readable on a rung with nothing else to
            show — a clean tree whose push Git refused (#248).
          */}
          {failure.report ? (
            <GitActionFailureBanner
              report={failure.report}
              onDismiss={failure.onDismiss}
            />
          ) : null}

          {loading || error || !data ? null : recovery ? (
            <GitConflictRecoverySection
              data={data}
              conflictHandoff={conflictHandoff}
              onOpenDiffFile={onOpenDiffFile}
              setSelectedPath={setSelectedPath}
            />
          ) : (
            changedFileCount === 0 ? (
              <EmptyPanelMessage
                title={t("gitPanel.empty.cleanTitle")}
                body={t("gitPanel.empty.cleanBody")}
                icon="clean"
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 pl-1.5 pr-1">
                  <label className="flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap text-[11px] font-medium text-(--text-secondary)">
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      disabled={primary.pendingVerb !== null}
                      checked={allCommitFilesSelected}
                      onChange={() => commit.onSetAllSelected(!allCommitFilesSelected)}
                      {...telemetryClickAttributes("git.commit_file.toggle_all", "git_panel")}
                      aria-label={t(allCommitFilesSelected
                        ? "gitPanel.commit.deselectAll"
                        : "gitPanel.commit.selectAll")}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-(--accent) disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="truncate">{t("gitPanel.commit.changedFiles")}</span>
                  </label>
                  <span className="shrink-0 font-mono text-[11px] text-(--text-muted) tabular-nums">
                    {commit.totals.files}/{data.changedFilesTruncated
                      ? (data.changedFilesTotal ?? `${changedFileCount}+`)
                      : changedFileCount}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {filesView === "tree" ? (
                      <WorkspaceTreeExpansionControls
                        disabled={!data.changedFiles.some((file) => file.path.includes("/"))}
                        onExpandAll={() => setFolderState({ target: commit.selectionKey, collapsed: new Set() })}
                        onCollapseAll={() => setFolderState({ target: commit.selectionKey, collapsed: new Set(buildChangedFileRows(data.changedFiles, new Set()).filter((row) => row.kind === "folder").map((row) => row.path)) })}
                      />
                    ) : null}
                    <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-(--text-muted)"
                      title={t(filesView === "tree" ? "gitPanel.commit.showList" : "gitPanel.commit.showTree")}
                      aria-label={t(filesView === "tree" ? "gitPanel.commit.showList" : "gitPanel.commit.showTree")}
                      data-testid="git-files-view-toggle"
                      onClick={() => setFilesView(filesView === "tree" ? "list" : "tree")}>
                      {filesView === "tree" ? <List className="h-3.5 w-3.5" /> : <ListTree className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={
                      revertableSelectedFiles.length === 0
                      || primary.pendingVerb !== null
                      || revert.pending
                    }
                    onClick={() => setRevertPendingFiles(revertableSelectedFiles)}
                    {...telemetryClickAttributes("git.revert_selected.open", "git_panel")}
                    title={t(revertableSelectedFiles.length === 0
                      ? "gitPanel.revert.nothingSelected"
                      : "gitPanel.revert.selectAction")}
                    data-testid="git-revert-selected"
                    aria-label={revert.pending
                      ? t("gitPanel.revert.selectActionPending")
                      : t("gitPanel.revert.selectAction")}
                    className="h-6 w-6 shrink-0 p-0 text-(--text-muted) hover:text-(--text-primary) disabled:opacity-50"
                  >
                    {revert.pending
                      ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      : <Undo2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <GitChangedFileList
                  rows={fileRows}
                  scrollable={!phoneScrollableContent}
                  activeIndex={scrollIndex}
                  treeProps={{
                    role: "tree",
                    "aria-multiselectable": true,
                    "aria-label": t("gitPanel.commit.changedFiles"),
                    tabIndex: 0,
                    onKeyDown: handleTreeKeyDown,
                    onKeyUp: handleTreeKeyUp,
                    onFocus: () => setTreeFocused(true),
                    onBlur: (event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTreeFocused(false);
                    },
                    "data-testid": "git-changed-file-tree",
                  }}
                >
                    {(row) => {
                      if (row.kind === "folder") {
                        const expanded = !(folderState.target === commit.selectionKey && folderState.collapsed.has(row.path));
                        const selectedCount = row.filePaths.reduce((count, path) => count + (commit.isSelected(path) ? 1 : 0), 0);
                        const allSelected = selectedCount === row.filePaths.length;
                        const padding = workspaceTreePadding(row.depth);
                        const FolderIcon = expanded ? FolderOpen : Folder;
                        const rowSelected = selectedRowSet.has(row.path);
                        return (
                          <div
                            key={`folder:${row.path}`}
                            role="treeitem"
                            aria-level={row.depth + 1}
                            aria-expanded={expanded}
                            aria-selected={rowSelected}
                            className={cn(
                              "group relative flex h-7 min-w-0 items-center border-l-2",
                              rowSelected ? "border-l-(--accent) bg-(--accent)/10" : "border-l-transparent hover:bg-(--sidebar-hover)",
                              treeFocused && row.path === leadPath && leadRingClassName,
                            )}
                          >
                            {Array.from({ length: row.depth }, (_, depth) => <WorkspaceTreeBranchGuide key={depth} depth={depth} />)}
                            <CommitFolderCheckbox
                              checked={allSelected}
                              mixed={selectedCount > 0 && !allSelected}
                              disabled={primary.pendingVerb !== null}
                              tabIndex={-1}
                              onChange={(event) => setFileSelected(
                                row.path,
                                !allSelected,
                                event.nativeEvent,
                                rowSelected ? selectedRows : undefined,
                              )}
                              {...telemetryClickAttributes("git.commit_folder.toggle", "git_panel")}
                              aria-label={t("gitPanel.commit.includeFolder", { path: row.path })}
                              data-testid={`git-commit-folder-checkbox-${row.path}`}
                              className={commitCheckboxClassName}
                              style={{ left: padding + COMMIT_TREE_CHECKBOX_OFFSET }}
                            />
                            <button
                              type="button"
                              aria-expanded={expanded}
                              title={row.path}
                              data-testid={`git-panel-folder-${row.path}`}
                              draggable={Boolean(data.worktreePath)}
                              onDragStart={(event) => {
                                const absolutePath = toAbsoluteWorkspacePath(data.agentWorktreePath ?? data.worktreePath, row.path);
                                if (absolutePath) setPathInsertDragData(event.dataTransfer, [absolutePath]);
                              }}
                              onDragEnd={clearPathInsertDragData}
                              tabIndex={-1}
                              onClick={(event) => {
                                const mode = clickSelectionMode(event);
                                selectTreeRow(row.path, mode);
                                if (mode === "replace") toggleFolder(row.path);
                              }}
                              className="relative flex h-7 min-w-0 flex-1 items-center gap-1.5 pr-2 text-left text-(--text-primary) focus-visible:outline-1 focus-visible:outline-(--accent) focus-visible:-outline-offset-1"
                              style={{ paddingLeft: padding + COMMIT_TREE_CONTENT_OFFSET }}
                            >
                              <ChevronRight
                                aria-hidden="true"
                                className={cn("absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--text-muted) transition-transform", expanded && "rotate-90")}
                                style={{ left: padding }}
                              />
                              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-(--text-secondary)" />
                              <span className="min-w-0 flex-1 truncate text-[13px] leading-5">{row.name}</span>
                              <span className="shrink-0 font-mono text-[10px] tabular-nums text-(--text-muted)">
                                {selectedCount > 0 && !allSelected ? `${selectedCount}/${row.filePaths.length}` : row.filePaths.length}
                              </span>
                            </button>
                          </div>
                        );
                      }
                      const file = row.file;
                      const isSelected = selectedRowSet.has(file.path);
                      const canOpenReadOnly = file.state !== "deleted";
                      const absolutePath = toAbsoluteWorkspacePath(data.worktreePath, file.path);
                      const agentPath = toAbsoluteWorkspacePath(data.agentWorktreePath ?? data.worktreePath, file.path);
                      return (
                        <div
                          key={file.path}
                          role="treeitem"
                          aria-level={row.depth + 1}
                          aria-selected={isSelected}
                          className={cn("relative", treeFocused && file.path === leadPath && leadRingClassName)}
                        >
                          {Array.from({ length: row.depth }, (_, depth) => <WorkspaceTreeBranchGuide key={depth} depth={depth} />)}
                          <div
                            draggable={Boolean(absolutePath)}
                            onDragStart={(event) => {
                              setSelectedPath(file.path);
                              const target = workspaceTarget ?? (sessionId ? { kind: "session" as const, id: sessionId } : null);
                              if (target) setWorkspaceTargetFileDragData(event.dataTransfer, target, "diff", file.path, absolutePath);
                              if (agentPath) setPathInsertDragData(event.dataTransfer, [agentPath]);
                            }}
                            onDragEnd={clearPathInsertDragData}
                            className={cn(workspaceTreeFileRowClassName(isSelected), "group/git-file-row")}
                            data-testid={`git-panel-file-row-${file.path}`}
                            onContextMenu={(event) => {
                              if (!absolutePath) return;
                              event.preventDefault();
                              event.stopPropagation();
                              setSelectedPath(file.path);
                              setContextMenu({
                                absolutePath,
                                canOpenFile: canOpenReadOnly,
                                position: { x: event.clientX, y: event.clientY },
                              });
                            }}
                          >
                            <div className="flex w-full min-w-0 items-center">
                              <input
                                type="checkbox"
                                checked={commit.isSelected(file.path)}
                                // The selection is an input to the commit, so it
                                // locks with the rest of the form (§7) rather
                                // than only while a commit is what is running.
                                disabled={primary.pendingVerb !== null}
                                tabIndex={-1}
                                onChange={(event) => {
                                  setFileSelected(
                                    file.path,
                                    event.currentTarget.checked,
                                    event.nativeEvent,
                                    isSelected ? selectedRows : undefined,
                                  );
                                }}
                                {...telemetryClickAttributes("git.commit_file.toggle", "git_panel")}
                                aria-label={t("gitPanel.commit.includeFile", {
                                  path: file.path,
                                })}
                                data-testid={`git-commit-file-checkbox-${file.path}`}
                                className={commitCheckboxClassName}
                                style={{ left: workspaceTreePadding(row.depth) + (filesView === "tree" ? COMMIT_TREE_CHECKBOX_OFFSET : 0) }}
                              />
                              <button
                                type="button"
                                className="flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left transition-colors focus-visible:outline-1 focus-visible:outline-(--accent) focus-visible:-outline-offset-1"
                                style={{ paddingLeft: workspaceTreePadding(row.depth) + (filesView === "tree" ? COMMIT_TREE_CONTENT_OFFSET : 20) }}
                                title={file.path}
                                tabIndex={-1}
                                onClick={(event) => {
                                  const mode = clickSelectionMode(event);
                                  selectTreeRow(file.path, mode);
                                  if (mode !== "replace") return;
                                  // A mouse click only selects; double-click (below) opens the diff.
                                  if (shouldOpenOnRowClick(event.detail, clickPointerType(event))) onOpenDiffFile(file);
                                }}
                                {...telemetryClickAttributes("git.file.diff_open", "git_panel")}
                                onDoubleClick={() => {
                                  setSelectedPath(file.path);
                                  onPinDiffFile(file);
                                }}
                              >
                                <WorkspaceFileIcon name={row.name} />
                                {filesView === "tree" ? <WorkspaceFileName name={row.name} /> : (
                                  <span className="min-w-0 flex-1"><FilePath path={file.path} /></span>
                                )}
                                <FileBadge file={file} />
                                {/* The inversion of the rule below: the diff stats give way
                                    to the action overlay. Below the Phone viewport step that
                                    overlay is always up, so these always give way (#250). */}
                                <span className="opacity-0 sm:opacity-100 transition-opacity group-hover/git-file-row:opacity-0">
                                  <FileDiffStats stats={file.diffStats} />
                                </span>
                              </button>
                            </div>
                            {/* Below the Phone viewport step the actions are simply present:
                                `hover:` compiles to `@media (hover: hover)`, so on a phone no
                                rule exists to reveal them. Kept hover-revealed from `sm` up. */}
                            <div data-testid={`git-file-actions-${file.path}`} className="pointer-events-auto absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-(--sidebar-hover)/95 opacity-100 sm:pointer-events-none sm:opacity-0 shadow-sm transition-opacity sm:group-hover/git-file-row:pointer-events-auto sm:group-hover/git-file-row:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
                              <Tooltip content="Open diff">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedPath(file.path);
                                    onOpenDiffFile(file);
                                  }}
                                  {...telemetryClickAttributes("git.file.diff_open", "git_panel")}
                                  className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                                  aria-label={`Open diff for ${file.path}`}
                                >
                                  <GitCompare className="h-3.5 w-3.5" />
                                </button>
                              </Tooltip>
                              <Tooltip
                                content={
                                  canOpenReadOnly
                                    ? "Open file"
                                    : "Deleted file has no working copy"
                                }
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedPath(file.path);
                                    onOpenReadOnlyFile(file);
                                  }}
                                  {...telemetryClickAttributes("git.file.open", "git_panel")}
                                  onDragStart={(event) => {
                                    event.stopPropagation();
                                    if (!absolutePath || !canOpenReadOnly) {
                                      event.preventDefault();
                                      return;
                                    }
                                    setSelectedPath(file.path);
                                    const target = workspaceTarget ?? (sessionId ? { kind: "session" as const, id: sessionId } : null);
                                    if (target) setWorkspaceTargetFileDragData(event.dataTransfer, target, "file", file.path, absolutePath);
                                    if (agentPath) setPathInsertDragData(event.dataTransfer, [agentPath]);
                                  }}
                                  onDragEnd={clearPathInsertDragData}
                                  draggable={Boolean(absolutePath && canOpenReadOnly)}
                                  disabled={!canOpenReadOnly}
                                  className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35"
                                  aria-label={`Open file ${file.path}`}
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                </button>
                              </Tooltip>
                              <Tooltip content="Copy absolute path">
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onCopyFilePath(file.path);
                                  }}
                                  {...telemetryClickAttributes("git.file.copy_path", "git_panel")}
                                  className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                                  aria-label={`Copy absolute path for ${file.path}`}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                </GitChangedFileList>
                {data.changedFilesTruncated ? (
                  <div className="px-2 pb-1 text-[10px] leading-snug text-(--text-muted)">
                    {data.changedFilesTotal != null
                      ? `Showing ${changedFileCount} of ${data.changedFilesTotal} changed files. `
                      : `Showing the first ${changedFileCount} changed files; the repository has many more. `}
                    Add large or generated folders (e.g. .venv, node_modules) to
                    .gitignore to see the rest.
                  </div>
                ) : null}
              </>
            )
          )}
        </div>
      )}
    </>
  );

  return (
    <>
    {phoneScrollableContent ? (
      <>
        {hasTarget ? (
          <div
            className="z-20 shrink-0 border-b border-(--chat-header-border) bg-(--sidebar-bg) px-3 py-3"
            data-testid="git-panel-fixed-action"
          >
            {actionArea}
          </div>
        ) : null}
        <ScrollArea
          className="min-h-0 flex-1 overscroll-contain"
          data-testid="git-panel-phone-scroll"
        >
          {phoneScrollableContent.summary}
          <div className="p-3">{contentBody}</div>
          {phoneScrollableContent.commits}
          <div aria-hidden style={{ height: "env(safe-area-inset-bottom)" }} />
        </ScrollArea>
      </>
    ) : (
      <div className="flex-1 overflow-hidden p-3">{contentBody}</div>
    )}
    {contextMenu ? (
      <WorkspaceFileContextMenu
        absolutePath={contextMenu.absolutePath}
        canOpenFile={contextMenu.canOpenFile}
        onClose={() => setContextMenu(null)}
        position={contextMenu.position}
      />
    ) : null}
    <GitRevertConfirmDialog
      files={revertPendingFiles}
      onCancel={() => setRevertPendingFiles(null)}
      onConfirm={() => {
        setRevertPendingFiles(null);
        revert.onConfirm();
      }}
    />
    </>
  );
}

const CONFLICT_OPERATION_LABEL_KEY: Record<
  GitConflictOperation,
  | "gitPanel.conflict.mergeOperation"
  | "gitPanel.conflict.rebaseOperation"
  | "gitPanel.conflict.cherryPickOperation"
> = {
  merge: "gitPanel.conflict.mergeOperation",
  rebase: "gitPanel.conflict.rebaseOperation",
  cherry_pick: "gitPanel.conflict.cherryPickOperation",
};

export function GitConflictRecoverySection({
  data,
  conflictHandoff,
  onOpenDiffFile,
  setSelectedPath,
}: {
  data: GitPanelData;
  conflictHandoff: {
    available: boolean;
    pending: boolean;
    onPrepare: () => void;
  };
  onOpenDiffFile: (file: GitChangedFile) => void;
  setSelectedPath: (path: string | null) => void;
}) {
  const { t } = useI18n();
  const recovery = deriveGitConflictRecovery(data);
  const focusRequest = useGitStore((state) => state.conflictRecoveryFocusRequest);
  const recoveryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusRequest > 0) recoveryRef.current?.focus();
  }, [focusRequest]);

  if (!recovery) return null;

  const operation = t(CONFLICT_OPERATION_LABEL_KEY[recovery.operation]);

  return (
    <section
      ref={recoveryRef}
      tabIndex={-1}
      aria-labelledby="git-conflict-recovery-title"
      data-testid="git-conflict-recovery"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-(--status-warning-border) bg-(--status-warning-bg) outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
    >
      <div className="border-b border-(--status-warning-border) px-3 py-2.5">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--status-warning-text)" />
          <div className="min-w-0">
            <h2
              id="git-conflict-recovery-title"
              className="text-xs font-semibold text-(--text-primary)"
            >
              {t("gitPanel.conflict.recoveryTitle")}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-(--text-secondary)">
              {t("gitPanel.conflict.operationInProgress", { operation })}
            </p>
          </div>
        </div>
      </div>

      {conflictHandoff.available ? (
        <GitConflictResolveWithAiButton
          label={t("gitPanel.conflict.resolveWithAi")}
          pendingLabel={t("gitPanel.conflict.aiPreparing")}
          description={t("gitPanel.conflict.aiReviewBoundary")}
          pending={conflictHandoff.pending}
          onPrepare={conflictHandoff.onPrepare}
        />
      ) : null}

      <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-(--text-muted)">
        <span>{t("gitPanel.conflict.unresolvedFiles")}</span>
        <span className="font-mono tabular-nums">
          {recovery.unresolvedFiles.length}{recovery.unresolvedFilesTruncated ? '+' : ''}
        </span>
      </div>

      {recovery.unresolvedFilesTruncated ? (
        <p
          data-testid="git-conflict-files-truncated"
          className="px-3 pb-2 text-[11px] leading-4 text-(--status-warning-text)"
        >
          {t("gitPanel.conflict.unresolvedFilesTruncated")}
        </p>
      ) : null}

      {recovery.unresolvedFiles.length === 0 && !recovery.unresolvedFilesTruncated ? (
        <p className="px-3 pb-3 text-[11px] leading-4 text-(--text-muted)">
          {t("gitPanel.conflict.noUnresolvedFiles")}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col pb-2">
            {recovery.unresolvedFiles.map((file) => (
              <button
                {...telemetryClickAttributes('git.file.diff_open', 'git_panel')}
                key={file.path}
                type="button"
                onClick={() => {
                  setSelectedPath(file.path);
                  onOpenDiffFile(file);
                }}
                data-testid={`git-conflict-file-${file.path}`}
                className="group flex min-w-0 items-center gap-2 border-l-2 border-l-transparent px-3 py-2 text-left text-(--text-secondary) transition-colors hover:border-l-(--accent) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              >
                <FileBadge file={file} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                  {file.path}
                </span>
                <span className="shrink-0 text-[10px] text-(--text-muted) group-hover:text-(--text-primary)">
                  {t("gitPanel.conflict.openDiff")}
                </span>
                <GitCompare className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
