"use client";

import type React from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  FileText,
  GitCompare,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { setWorkspaceFileDragData } from "@/lib/dnd/panel-session-drag";
import { useI18n } from "@/lib/i18n";
import { toAbsoluteWorkspacePath } from "@/lib/workspace-tabs/file-path-actions";
import { cn } from "@/lib/utils";
import type { GitChangedFile, GitDiffData, GitPanelData } from "@/types/git";
import {
  FILE_STATE_META,
} from "./git-panel-shared";

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
  onCopyFilePath,
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
  onCopyFilePath: (relativePath: string) => void;
  onOpenDiffFile: (file: GitChangedFile) => void;
  onPinDiffFile: (file: GitChangedFile) => void;
  onOpenReadOnlyFile: (file: GitChangedFile) => void;
}) {
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState<{
    absolutePath: string;
    canOpenFile: boolean;
    position: { x: number; y: number };
  } | null>(null);

  return (
    <>
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
                {data.changedFilesTruncated
                  ? (data.changedFilesTotal ?? `${changedFileCount}+`)
                  : changedFileCount}
              </span>
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col">
                {data.changedFiles.map((file) => {
                  const isSelected = file.path === selectedPath;
                  const canOpenReadOnly = file.state !== "deleted";
                  const absolutePath = toAbsoluteWorkspacePath(data.worktreePath, file.path);
                  return (
                    <div
                      key={file.path}
                      draggable={Boolean(sessionId)}
                      onDragStart={(event) => {
                        if (!sessionId) return;
                        setSelectedPath(file.path);
                        setWorkspaceFileDragData(event.dataTransfer, sessionId, "diff", file.path, absolutePath);
                      }}
                      className={cn(
                        "group relative border-l-2 transition-colors",
                        isSelected
                          ? "border-l-(--accent) bg-(--accent)/10 text-(--text-primary)"
                          : "border-l-transparent text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
                      )}
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
                              setWorkspaceFileDragData(event.dataTransfer, sessionId, "file", file.path, absolutePath);
                            }}
                            draggable={Boolean(sessionId && canOpenReadOnly)}
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
                            className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--text-primary)"
                            aria-label={`Copy absolute path for ${file.path}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            {data.changedFilesTruncated ? (
              <div className="px-2 pb-1 text-[10px] leading-snug text-(--text-muted)">
                {data.changedFilesTotal != null
                  ? `Showing ${changedFileCount} of ${data.changedFilesTotal} changed files. `
                  : `Showing the first ${changedFileCount} changed files; the repository has many more. `}
                Add large or generated folders (e.g. .venv, node_modules) to
                .gitignore to see the rest.
              </div>
            ) : null}
          </div>
        )
      )}
    </div>
    {contextMenu ? (
      <WorkspaceFileContextMenu
        absolutePath={contextMenu.absolutePath}
        canOpenFile={contextMenu.canOpenFile}
        onClose={() => setContextMenu(null)}
        position={contextMenu.position}
      />
    ) : null}
    </>
  );
}
