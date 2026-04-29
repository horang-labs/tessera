"use client";

import { AlertCircle, Binary, Copy, FileCode2, GitCompare, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

function getDiffLineClassName(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-[#2f8753]/8 text-[#2f8753]";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-[#c94c4c]/8 text-[#c94c4c]";
  }
  if (line.startsWith("@@")) {
    return "bg-[#4a8cd6]/10 text-[#4a8cd6]";
  }
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    return "text-(--text-primary)";
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return "text-[#9b7f35]";
  }
  return "text-(--text-secondary)";
}

function CodeLines({
  content,
  mode,
}: {
  content: string;
  mode: "file" | "diff";
}) {
  const lines = content.split("\n");
  return (
    <div className="min-w-max py-3">
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.slice(0, 16)}`}
          className={cn(
            "grid grid-cols-[4rem_minmax(0,1fr)] font-mono text-xs leading-5",
            mode === "diff" ? getDiffLineClassName(line) : "text-(--text-secondary)",
          )}
        >
          <span className="select-none border-r border-(--divider) px-3 text-right text-(--text-muted) opacity-70">
            {index + 1}
          </span>
          <code className="whitespace-pre px-4">{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  body,
  icon = "file",
}: {
  title: string;
  body: string;
  icon?: "file" | "error" | "binary";
}) {
  const Icon = icon === "error" ? AlertCircle : icon === "binary" ? Binary : FileCode2;
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-(--divider) bg-(--sidebar-hover)">
          <Icon className="h-5 w-5 text-(--text-muted)" />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">{title}</p>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">{body}</p>
      </div>
    </div>
  );
}

export function WorkspaceCodeView({
  data,
  error,
  loading,
  mode,
  onClose,
  path,
}: {
  data: WorkspaceFileData | GitDiffData | null;
  error: string | null;
  loading: boolean;
  mode: "file" | "diff";
  onClose?: () => void;
  path: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const content =
    mode === "diff"
      ? (data as GitDiffData | null)?.diff ?? ""
      : (data as WorkspaceFileData | null)?.content ?? "";
  const fileData = mode === "file" ? (data as WorkspaceFileData | null) : null;
  const diffData = mode === "diff" ? (data as GitDiffData | null) : null;
  const copied = copiedKey === `${mode}:${path}`;

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
      const key = `${mode}:${path}`;
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      setCopiedKey(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
      </div>
    );
  }

  if (error) {
    return <EmptyState title="Unable to open file" body={error} icon="error" />;
  }

  if (!data) {
    return <EmptyState title="No file loaded" body="Select a file to preview it." />;
  }

  if (fileData?.binary) {
    return <EmptyState title="Binary file" body="Preview is unavailable for binary content." icon="binary" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-(--chat-header-border) px-4">
        <div className="flex min-w-0 items-center gap-2">
          {mode === "diff" ? (
            <GitCompare className="h-4 w-4 shrink-0 text-(--text-muted)" />
          ) : (
            <FileCode2 className="h-4 w-4 shrink-0 text-(--text-muted)" />
          )}
          <div className="min-w-0">
            <p className="truncate font-mono text-sm text-(--text-primary)">{path}</p>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
              {mode === "diff" ? "Diff" : fileData?.language || "text"}
              {fileData ? ` · ${formatBytes(fileData.size)}` : ""}
              {fileData?.truncated || diffData?.truncated ? " · truncated" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={copied ? "Copied" : "Copy"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={copyContent}
              disabled={!content}
              aria-label="Copy file content"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </Tooltip>
          {onClose ? (
            <Tooltip content="Close">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={onClose}
                aria-label="Close file panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeLines content={content} mode={mode} />
      </div>
    </div>
  );
}
