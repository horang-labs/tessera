"use client";

import { AlertCircle, Binary, Code2, Copy, ExternalLink, Eye, FileCode2, FileText, GitCompare, LoaderCircle, X } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { PreviewMarkdown } from "@/components/chat/preview-markdown";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { WorkspaceMonacoEditor } from "@/components/workspace/workspace-monaco-editor";
import {
  canUseElectronFileActions,
  copyText,
  openFilePathOnHost,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";

type MarkdownViewMode = "preview" | "source";

const subscribeToStaticClientValue = () => () => {};
const getNoElectronFileActions = () => false;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

function dirname(filePath: string): string {
  const slashIndex = filePath.lastIndexOf("/");
  return slashIndex >= 0 ? filePath.slice(0, slashIndex) : "";
}

function normalizeWorkspaceAssetPath(markdownPath: string, src: string): string | null {
  const trimmedSrc = src.trim();
  if (!trimmedSrc || trimmedSrc.startsWith("#")) return null;

  if (trimmedSrc.startsWith("//")) return trimmedSrc;

  const protocolMatch = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(trimmedSrc);
  if (protocolMatch) {
    const protocol = protocolMatch[0].toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "blob:") return trimmedSrc;
    if (protocol === "data:" && trimmedSrc.toLowerCase().startsWith("data:image/")) return trimmedSrc;
    return null;
  }

  const withoutHash = trimmedSrc.split("#", 1)[0] ?? "";
  const withoutQuery = withoutHash.split("?", 1)[0] ?? "";
  const rawParts = withoutQuery.startsWith("/")
    ? withoutQuery.split("/")
    : [...dirname(markdownPath).split("/"), ...withoutQuery.split("/")];
  const normalizedParts: string[] = [];

  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalizedParts.length === 0) return null;
      normalizedParts.pop();
      continue;
    }
    normalizedParts.push(part);
  }

  return normalizedParts.length > 0 ? normalizedParts.join("/") : null;
}

function isBrowserImageSrc(src: string): boolean {
  const trimmedSrc = src.trim();
  if (trimmedSrc.startsWith("//")) return true;

  const protocolMatch = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(trimmedSrc);
  if (!protocolMatch) return false;

  const protocol = protocolMatch[0].toLowerCase();
  return (
    protocol === "http:"
    || protocol === "https:"
    || protocol === "blob:"
    || (protocol === "data:" && trimmedSrc.toLowerCase().startsWith("data:image/"))
  );
}

function buildWorkspaceRawFileUrl(sessionId: string, filePath: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}&raw=1`;
}

function useCanUseElectronFileActions(): boolean {
  return useSyncExternalStore(
    subscribeToStaticClientValue,
    canUseElectronFileActions,
    getNoElectronFileActions,
  );
}

function MarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: MarkdownViewMode;
  onChange: (mode: MarkdownViewMode) => void;
}) {
  const buttonClassName = (value: MarkdownViewMode) =>
    [
      "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors",
      mode === value
        ? "bg-(--chat-bg) text-(--text-primary) shadow-sm"
        : "text-(--text-muted) hover:text-(--text-primary)",
    ].join(" ");

  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-(--divider) bg-(--sidebar-hover) p-0.5"
      role="tablist"
      aria-label="Markdown view mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "preview"}
        className={buttonClassName("preview")}
        onClick={() => onChange("preview")}
      >
        <Eye className="h-3.5 w-3.5" />
        <span>Preview</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "source"}
        className={buttonClassName("source")}
        onClick={() => onChange("source")}
      >
        <Code2 className="h-3.5 w-3.5" />
        <span>Source</span>
      </button>
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
  sourceSessionId,
}: {
  data: WorkspaceFileData | GitDiffData | null;
  error: string | null;
  loading: boolean;
  mode: "file" | "diff";
  onClose?: () => void;
  path: string;
  sourceSessionId?: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [markdownModeState, setMarkdownModeState] = useState<{ mode: MarkdownViewMode; path: string }>({
    mode: "preview",
    path: "",
  });
  const content =
    mode === "diff"
      ? (data as GitDiffData | null)?.diff ?? ""
      : (data as WorkspaceFileData | null)?.content ?? "";
  const fileData = mode === "file" ? (data as WorkspaceFileData | null) : null;
  const diffData = mode === "diff" ? (data as GitDiffData | null) : null;
  const absolutePath = toAbsoluteWorkspacePath(
    mode === "diff" ? diffData?.workDir : fileData?.workDir,
    path,
  );
  const copied = copiedKey === `${mode}:${path}`;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const canOpenOnHost = useCanUseElectronFileActions();
  const isMarkdownFile = mode === "file" && fileData?.language === "markdown";
  const markdownViewMode = isMarkdownFile && markdownModeState.path === path ? markdownModeState.mode : "preview";
  const shouldRenderMarkdownPreview = isMarkdownFile && markdownViewMode === "preview";
  const showOpenButton = canOpenOnHost && Boolean(absolutePath);
  const resolveMarkdownImageSrc = useCallback((src: string): string | null => {
    if (!sourceSessionId || isBrowserImageSrc(src)) return src;
    const assetPath = normalizeWorkspaceAssetPath(path, src);
    if (!assetPath) return null;
    return buildWorkspaceRawFileUrl(sourceSessionId, assetPath);
  }, [path, sourceSessionId]);
  const handleMarkdownViewModeChange = useCallback((nextMode: MarkdownViewMode) => {
    setMarkdownModeState({ mode: nextMode, path });
  }, [path]);

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
    <>
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-(--chat-header-border) px-4">
        <div className="flex min-w-0 items-center gap-2">
          {mode === "diff" ? (
            <GitCompare className="h-4 w-4 shrink-0 text-(--text-muted)" />
          ) : isMarkdownFile ? (
            <FileText className="h-4 w-4 shrink-0 text-(--text-muted)" />
          ) : (
            <FileCode2 className="h-4 w-4 shrink-0 text-(--text-muted)" />
          )}
          <div
            className="min-w-0"
            onContextMenu={(event) => {
              if (!absolutePath) return;
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <p className="truncate font-mono text-sm text-(--text-primary)">{path}</p>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
              {mode === "diff" ? "Diff" : fileData?.language || "text"}
              {fileData ? ` · ${formatBytes(fileData.size)}` : ""}
              {fileData?.truncated || diffData?.truncated ? " · truncated" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isMarkdownFile ? (
            <MarkdownModeToggle mode={markdownViewMode} onChange={handleMarkdownViewModeChange} />
          ) : null}
          {showOpenButton ? (
            <Tooltip content="Open">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2.5"
                onClick={() => openFilePathOnHost(absolutePath)}
                aria-label={`Open ${path}`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Open</span>
              </Button>
            </Tooltip>
          ) : null}
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
          <Tooltip content="Copy absolute path">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => copyText(absolutePath)}
              disabled={!absolutePath}
              aria-label={`Copy absolute path for ${path}`}
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
      <div className={shouldRenderMarkdownPreview ? "min-h-0 flex-1 overflow-auto" : "min-h-0 flex-1 overflow-hidden"}>
        {shouldRenderMarkdownPreview ? (
          <div className="mx-auto w-full max-w-4xl px-6 py-5 text-sm">
            <PreviewMarkdown content={content} resolveImageSrc={resolveMarkdownImageSrc} />
          </div>
        ) : (
          <WorkspaceMonacoEditor
            content={content}
            language={mode === "diff" ? "git-diff" : fileData?.language}
            mode={mode}
            path={path}
            readOnly
          />
        )}
      </div>
    </div>
    {contextMenu && absolutePath ? (
      <WorkspaceFileContextMenu
        absolutePath={absolutePath}
        onClose={() => setContextMenu(null)}
        position={contextMenu}
      />
    ) : null}
    </>
  );
}
