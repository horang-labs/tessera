"use client";

import type React from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudOff,
  Combine,
  Copy,
  ExternalLink,
  FileText,
  GitCompare,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { setWorkspaceFileDragData } from "@/lib/dnd/panel-session-drag";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { GitChangedFile, GitDiffData, GitPanelData } from "@/types/git";
import {
  type ActiveGitAction,
  computeGitFooterButtonStates,
  FILE_STATE_META,
  getGitHubActionBlockReason,
} from "./git-panel-shared";

function GitActionForm({
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-xl border border-(--accent)/30 bg-(--chat-bg) p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-(--text-muted)">
          {title}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-0.5 text-(--text-muted) hover:text-(--text-primary)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={disabled}
          className="flex-1"
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function formatShortCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(value / 1000)}k`;
}

function formatDiffMetric(
  data: GitPanelData,
  changedFileCount: number,
): string {
  if (!data.diffStats) return String(changedFileCount);
  return `+${formatShortCount(data.diffStats.added)} -${formatShortCount(data.diffStats.removed)} / ${data.diffStats.changedFiles}`;
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

function GitSummaryCopyButton({
  ariaLabel,
  disabled,
  onClick,
  tooltip,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <Tooltip content={tooltip} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="pointer-events-none h-6 w-6 shrink-0 rounded text-(--text-muted) opacity-0 transition-opacity hover:text-(--text-primary) group-hover/summary-copy:pointer-events-auto group-hover/summary-copy:opacity-100 group-focus-within/summary-copy:pointer-events-auto group-focus-within/summary-copy:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </Tooltip>
  );
}

function FileBadge({ file }: { file: GitChangedFile }) {
  const meta = FILE_STATE_META[file.state];
  const display =
    file.state === "untracked" ? "U" : file.displayStatus;

  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center font-mono text-[11px] font-semibold leading-none",
        meta.statusClassName,
      )}
      aria-label={meta.label}
    >
      {display}
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
}: {
  diffData: GitDiffData | null;
  diffError: string | null;
  diffLoading: boolean;
  selectedFile: GitChangedFile | null;
  hideFileHeader?: boolean;
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
          <FileBadge file={selectedFile} />
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
  const projectName = data ? getGitPanelProjectName(data) : "Repository";
  const worktreeName = data ? getGitPanelWorktreeName(data) : "worktree";
  const branchName = data?.branch ?? "branch";
  const worktreeTooltip = data?.worktreePath ?? "Worktree path unavailable";
  const prUrl = data?.prStatus?.url ?? data?.github.pullRequest?.url;
  const prLabel = data?.prStatus
    ? data.github.pullRequest?.title
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
                  <GitSummaryCopyButton
                    ariaLabel="Copy full worktree path"
                    onClick={onCopyWorktreePath}
                    tooltip="Copy full worktree path"
                  />
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
                    tooltip="Copy branch name"
                  />
                ) : null}
              </div>
            </div>
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
                      className="min-w-0 cursor-pointer truncate text-left text-xs font-semibold text-(--text-primary) hover:text-(--accent)"
                      onClick={() => onOpenExternal(prUrl)}
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
  data,
  error,
  loading,
  selectedPath,
  sessionId,
  setSelectedPath,
  onOpenDiffFile,
  onPinDiffFile,
  onOpenReadOnlyFile,
}: {
  changedFileCount: number;
  data: GitPanelData | null;
  error: string | null;
  loading: boolean;
  selectedPath: string | null;
  sessionId: string | null;
  setSelectedPath: (path: string | null) => void;
  onOpenDiffFile: (file: GitChangedFile) => void;
  onPinDiffFile: (file: GitChangedFile) => void;
  onOpenReadOnlyFile: (file: GitChangedFile) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex-1 overflow-hidden p-3">
      {!sessionId && !loading ? (
        <EmptyPanelMessage
          title={t("gitPanel.empty.noWorktreeTitle")}
          body={t("gitPanel.empty.noWorktreeBody")}
        />
      ) : null}

      {loading || error || !data ? null : (
        changedFileCount === 0 ? (
          <EmptyPanelMessage
            title={t("gitPanel.empty.cleanTitle")}
            body={t("gitPanel.empty.cleanBody")}
            icon="clean"
          />
        ) : (
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-(--text-muted)">
                Changed files
              </span>
              <span className="font-mono text-[11px] text-(--text-muted) tabular-nums">
                {changedFileCount}
              </span>
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col">
                {data.changedFiles.map((file) => {
                  const isSelected = file.path === selectedPath;
                  const canOpenReadOnly = file.state !== "deleted";
                  return (
                    <div
                      key={file.path}
                      draggable={Boolean(sessionId)}
                      onDragStart={(event) => {
                        if (!sessionId) return;
                        setSelectedPath(file.path);
                        setWorkspaceFileDragData(event.dataTransfer, sessionId, "diff", file.path);
                      }}
                      className={cn(
                        "group relative border-l-2 transition-colors",
                        isSelected
                          ? "border-l-(--accent) bg-(--accent)/10 text-(--text-primary)"
                          : "border-l-transparent text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
                      )}
                      data-testid={`git-panel-file-row-${file.path}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPath(file.path);
                          onOpenDiffFile(file);
                        }}
                        onDoubleClick={() => {
                          setSelectedPath(file.path);
                          onPinDiffFile(file);
                        }}
                        className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
                      >
                        <FileBadge file={file} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                          {file.path}
                        </span>
                        <span className="transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                          <FileDiffStats stats={file.diffStats} />
                        </span>
                      </button>
                      <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-(--sidebar-hover)/95 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                        <Tooltip content="Open diff">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedPath(file.path);
                              onOpenDiffFile(file);
                            }}
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
                            onDragStart={(event) => {
                              event.stopPropagation();
                              if (!sessionId || !canOpenReadOnly) {
                                event.preventDefault();
                                return;
                              }
                              setSelectedPath(file.path);
                              setWorkspaceFileDragData(event.dataTransfer, sessionId, "file", file.path);
                            }}
                            draggable={Boolean(sessionId && canOpenReadOnly)}
                            disabled={!canOpenReadOnly}
                            className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35"
                            aria-label={`Open file ${file.path}`}
                          >
                            <FileText className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )
      )}
    </div>
  );
}

export function GitPanelFooterSection({
  actionInput,
  activeAction,
  checksUrl,
  data,
  isSessionBusy,
  mergePrPromptDraft,
  mergePrPromptPreview,
  mergeSource,
  fetching,
  onActionInputChange,
  onCreatePr,
  onFetch,
  onMerge,
  onMergePr,
  onMergePrPromptChange,
  onOpenAction,
  onOpenExternal,
  onPull,
  onPush,
  onResetMergePrPrompt,
  onSetMergeSource,
  onSetPrBaseBranch,
  onCloseAction,
  onCommit,
  prBaseBranch,
}: {
  actionInput: string;
  activeAction: ActiveGitAction;
  checksUrl: string | null;
  data: GitPanelData;
  isSessionBusy: boolean;
  mergePrPromptDraft: string;
  mergePrPromptPreview: string;
  mergeSource: string;
  fetching: boolean;
  onActionInputChange: (value: string) => void;
  onCloseAction: () => void;
  onCommit: () => void;
  onCreatePr: () => void;
  onFetch: () => void;
  onMerge: () => void;
  onMergePr: () => void;
  onMergePrPromptChange: (value: string) => void;
  onOpenAction: (action: Exclude<ActiveGitAction, null>) => void;
  onOpenExternal: (url: string | null | undefined) => void;
  onPull: () => void;
  onPush: () => void;
  onResetMergePrPrompt: () => void;
  onSetMergeSource: (value: string) => void;
  onSetPrBaseBranch: (value: string) => void;
  prBaseBranch: string;
}) {
  const availableBranches = (data.branches ?? []).filter((branch) => branch !== data.branch);
  const mergePrPromptIsDirty = mergePrPromptDraft !== mergePrPromptPreview;
  const githubActionBlockReason = getGitHubActionBlockReason(data.github);
  const isGithubActionBlocked = Boolean(githubActionBlockReason);
  const {
    showMergePr,
    commitDisabled,
    pushDisabled,
    pullDisabled,
    syncDisabled,
    createPrDisabled,
    mergePrDisabled,
  } = computeGitFooterButtonStates(data, isSessionBusy, activeAction);
  const fetchDisabled = isSessionBusy || activeAction !== null || fetching;

  return (
    <div className="border-t border-(--chat-header-border) px-3 py-3 space-y-2">
      {activeAction === "commit" ? (
        <GitActionForm
          title="Commit"
          confirmLabel="Commit"
          onConfirm={onCommit}
          onCancel={onCloseAction}
        >
          <textarea
            value={actionInput}
            onChange={(event) => onActionInputChange(event.target.value)}
            placeholder="Optional: hint for the AI commit message…"
            rows={2}
            className="w-full resize-none rounded-lg border border-(--divider) bg-(--sidebar-bg) px-3 py-2 text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent)"
          />
        </GitActionForm>
      ) : null}

      {activeAction === "merge" ? (
        <GitActionForm
          title="Sync (merge into current branch)"
          confirmLabel="Merge"
          disabled={!mergeSource || mergeSource === data.branch}
          onConfirm={onMerge}
          onCancel={onCloseAction}
        >
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
                Source
              </label>
              <select
                value={mergeSource}
                onChange={(event) => onSetMergeSource(event.target.value)}
                className="w-full rounded-lg border border-(--divider) bg-(--sidebar-bg) px-3 py-2 text-xs text-(--text-primary) outline-none focus:border-(--accent)"
              >
                {availableBranches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-(--text-muted)">↓ into</span>
              <span className="truncate rounded-md bg-(--sidebar-hover) px-2 py-0.5 font-mono text-[10px] text-(--text-primary)">
                {data.branch}
              </span>
            </div>
          </div>
        </GitActionForm>
      ) : null}

      {activeAction === "create-pr" ? (
        <GitActionForm
          title="Create Pull Request"
          confirmLabel="Create PR"
          onConfirm={onCreatePr}
          onCancel={onCloseAction}
          disabled={isGithubActionBlocked}
        >
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
                Base branch
              </label>
              <select
                value={prBaseBranch}
                onChange={(event) => onSetPrBaseBranch(event.target.value)}
                className="w-full rounded-lg border border-(--divider) bg-(--sidebar-bg) px-3 py-2 text-xs text-(--text-primary) outline-none focus:border-(--accent)"
              >
                {availableBranches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={actionInput}
              onChange={(event) => onActionInputChange(event.target.value)}
              placeholder="Optional: context for the PR description…"
              rows={2}
              className="w-full resize-none rounded-lg border border-(--divider) bg-(--sidebar-bg) px-3 py-2 text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent)"
            />
          </div>
        </GitActionForm>
      ) : null}

      {activeAction === "merge-pr" ? (
        <GitActionForm
          title="Merge Pull Request"
          confirmLabel="Merge PR"
          onConfirm={onMergePr}
          onCancel={onCloseAction}
          disabled={isGithubActionBlocked || !mergePrPromptDraft.trim()}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <label
                  htmlFor="git-merge-pr-prompt-draft"
                  className="block text-[10px] font-medium uppercase tracking-[0.14em] text-(--text-muted)"
                >
                  Prompt
                </label>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full border border-(--divider) px-2 py-0.5 text-[10px] font-medium text-(--text-muted)">
                    This run only
                  </span>
                  {mergePrPromptIsDirty ? (
                    <span className="rounded-full border border-(--accent)/30 bg-(--accent)/10 px-2 py-0.5 text-[10px] font-medium text-(--accent)">
                      Edited
                    </span>
                  ) : null}
                </div>
              </div>
              <Tooltip content="Reset to configured prompt" side="top">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={onResetMergePrPrompt}
                  disabled={!mergePrPromptIsDirty}
                  aria-label="Reset Merge PR prompt"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </div>
            <textarea
              id="git-merge-pr-prompt-draft"
              value={mergePrPromptDraft}
              onChange={(event) => onMergePrPromptChange(event.target.value)}
              rows={5}
              className="max-h-44 min-h-28 w-full resize-y rounded-lg border border-(--divider) bg-(--sidebar-bg) px-3 py-2 font-mono text-[11px] leading-5 text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent)"
            />
          </div>
        </GitActionForm>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <Tooltip content="Commit" side="top">
          <Button
            variant="outline"
            size="icon"
            onClick={() => onOpenAction("commit")}
            disabled={commitDisabled}
            aria-label="Commit"
          >
            <GitCommitHorizontal className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Push" side="top">
          <Button
            variant="outline"
            size="icon"
            onClick={onPush}
            disabled={pushDisabled}
            aria-label="Push"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Fetch" side="top">
          <Button
            variant="outline"
            size="icon"
            onClick={onFetch}
            disabled={fetchDisabled}
            aria-label="Fetch"
          >
            <RefreshCw className={cn("h-4 w-4", fetching && "animate-spin")} />
          </Button>
        </Tooltip>
        {showMergePr ? (
          <Tooltip content={githubActionBlockReason ?? "Merge Pull Request"} side="top">
            <Button
              variant="outline"
              size="icon"
              onClick={() => onOpenAction("merge-pr")}
              disabled={mergePrDisabled || isGithubActionBlocked}
              aria-label="Merge Pull Request"
            >
              <GitMerge className="h-4 w-4" />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={githubActionBlockReason ?? "Create Pull Request"} side="top">
            <Button
              variant="outline"
              size="icon"
              onClick={() => onOpenAction("create-pr")}
              disabled={createPrDisabled}
              aria-label="Create Pull Request"
            >
              <GitPullRequest className="h-4 w-4" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Sync (merge into current branch)" side="top">
          <Button
            variant="outline"
            size="icon"
            onClick={() => onOpenAction("merge")}
            disabled={syncDisabled}
            aria-label="Sync"
          >
            <Combine className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Pull" side="top">
          <Button
            variant="outline"
            size="icon"
            onClick={onPull}
            disabled={pullDisabled}
            aria-label="Pull"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </Tooltip>

        {checksUrl ? (
          <>
            <div className="mx-1 h-5 w-px bg-(--divider)" aria-hidden />
            <Tooltip content="Open CI checks" side="top">
              <Button
                variant="outline"
                size="icon"
                onClick={() => onOpenExternal(checksUrl)}
                aria-label="Open CI checks"
              >
                <CheckCircle2 className="h-4 w-4" />
              </Button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
}
