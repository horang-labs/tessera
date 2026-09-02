"use client";

import { AlertCircle, Binary, ChevronDown, ChevronUp, Code2, Copy, ExternalLink, Eye, FileCode2, FileText, GitCompare, Image as ImageIcon, LoaderCircle, RefreshCw, Save, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PreviewMarkdown } from "@/components/chat/preview-markdown";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { WorkspaceImageViewer } from '@/components/workspace/workspace-image-viewer';
import { WorkspaceMonacoEditor } from "@/components/workspace/workspace-monaco-editor";
import {
  canUseElectronFileActions,
  copyText,
  openFilePathOnHost,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";
import type { WorkspaceTarget } from '@/types/worktree';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import { formatBytes } from '@/lib/format-bytes';
import {
  buildWorkspaceRawFileUrl,
  isWorkspaceImageMimeType,
} from '@/lib/workspace-files/workspace-file-preview';

type MarkdownViewMode = "preview" | "source";

const subscribeToStaticClientValue = () => () => {};
const getNoElectronFileActions = () => false;

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

function useCanUseElectronFileActions(): boolean {
  return useSyncExternalStore(
    subscribeToStaticClientValue,
    canUseElectronFileActions,
    getNoElectronFileActions,
  );
}

function WorkspaceFileFind({
  contentRef,
  onClose,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<Range[]>([]);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [matchCount, setMatchCount] = useState(0);

  const selectMatch = useCallback((index: number) => {
    const match = matchesRef.current[index];
    if (!match) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(match);
    const element = match.startContainer.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    setMatchIndex(index);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    const container = contentRef.current;
    const normalizedQuery = nextQuery.toLocaleLowerCase();
    if (!container || !normalizedQuery) {
      matchesRef.current = [];
      setMatchCount(0);
      setMatchIndex(-1);
      return;
    }

    const matches: Range[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      const normalizedText = text.toLocaleLowerCase();
      let offset = normalizedText.indexOf(normalizedQuery);
      while (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + nextQuery.length);
        matches.push(range);
        offset = normalizedText.indexOf(normalizedQuery, offset + normalizedQuery.length);
      }
      node = walker.nextNode();
    }
    matchesRef.current = matches;
    setMatchCount(matches.length);
    if (matches.length > 0) selectMatch(0);
    else setMatchIndex(-1);
  }, [contentRef, selectMatch]);

  const move = useCallback((direction: 1 | -1) => {
    const count = matchesRef.current.length;
    if (count === 0) return;
    selectMatch((matchIndex + direction + count) % count);
  }, [matchIndex, selectMatch]);

  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-md border border-(--divider) bg-(--chat-bg) p-1 shadow-lg">
      <Search className="ml-1 h-3.5 w-3.5 text-(--text-muted)" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => updateQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter") {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          }
        }}
        className="h-7 w-44 bg-transparent px-1 text-xs text-(--text-primary) outline-none"
        placeholder="Find in file"
        aria-label="Find in file"
      />
      <span className="min-w-12 text-center text-[11px] text-(--text-muted)">
        {query ? `${matchCount ? matchIndex + 1 : 0}/${matchCount}` : ""}
      </span>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => move(-1)} disabled={!matchCount} aria-label="Previous match">
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => move(1)} disabled={!matchCount} aria-label="Next match">
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close find">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
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
        {...telemetryClickAttributes('workspace_editor.preview', 'workspace_editor')}
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
        {...telemetryClickAttributes('workspace_editor.source', 'workspace_editor')}
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
  action,
}: {
  title: string;
  body: string;
  icon?: "file" | "error" | "binary";
  action?: ReactNode;
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
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

function PendingStateHeader({
  mode,
  path,
  onClose,
}: {
  mode: "file" | "diff";
  path: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-(--chat-header-border) px-4">
      <div className="flex min-w-0 items-center gap-2">
        {mode === "diff" ? (
          <GitCompare className="h-4 w-4 shrink-0 text-(--text-muted)" />
        ) : (
          <FileCode2 className="h-4 w-4 shrink-0 text-(--text-muted)" />
        )}
        <p className="truncate font-mono text-sm text-(--text-primary)">{path}</p>
      </div>
      {onClose ? (
        <Tooltip content="Close">
          <Button
            {...telemetryClickAttributes('workspace_editor.close', 'workspace_editor')}
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
  );
}

export function WorkspaceCodeView({
  conflict = false,
  data,
  dirty = false,
  draft = null,
  editable = false,
  editorModelKey,
  error,
  loading,
  mode,
  onCancelConflict,
  onClose,
  onDraftChange,
  onOverwrite,
  onReload,
  onRetry,
  onSave,
  path,
  saving = false,
  sourceTarget,
}: {
  /** The file changed on disk under an unsaved draft; the banner is showing. */
  conflict?: boolean;
  data: WorkspaceFileData | GitDiffData | null;
  dirty?: boolean;
  /** Unsaved buffer, shown instead of the loaded content when present. */
  draft?: string | null;
  editable?: boolean;
  /** Stable per-tab identity so duplicate file tabs never share a Monaco model. */
  editorModelKey?: string;
  error: string | null;
  loading: boolean;
  mode: "file" | "diff";
  onCancelConflict?: () => void;
  onClose?: () => void;
  onDraftChange?: (value: string) => void;
  onOverwrite?: () => void;
  onReload?: () => void;
  onRetry?: () => void;
  onSave?: () => void;
  path: string;
  saving?: boolean;
  sourceTarget?: WorkspaceTarget;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [markdownModeState, setMarkdownModeState] = useState<{ mode: MarkdownViewMode; path: string }>({
    mode: "preview",
    path: "",
  });
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [monacoFindRequest, setMonacoFindRequest] = useState(0);
  const markdownContentRef = useRef<HTMLDivElement>(null);
  const loadedContent =
    mode === "diff"
      ? (data as GitDiffData | null)?.diff ?? ""
      : (data as WorkspaceFileData | null)?.content ?? "";
  const content = draft ?? loadedContent;
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
  const isImageFile = mode === 'file'
    && Boolean(sourceTarget)
    && isWorkspaceImageMimeType(fileData?.mimeType);
  const imageRawUrl = isImageFile && sourceTarget && fileData
    ? buildWorkspaceRawFileUrl(sourceTarget, path, `${fileData.mtimeMs}-${fileData.size}`)
    : null;
  const markdownViewMode = isMarkdownFile && markdownModeState.path === path ? markdownModeState.mode : "preview";
  const shouldRenderMarkdownPreview = isMarkdownFile && markdownViewMode === "preview";
  const showOpenButton = canOpenOnHost && Boolean(absolutePath);
  const resolveMarkdownImageSrc = useCallback((src: string): string | null => {
    if (!sourceTarget || isBrowserImageSrc(src)) return src;
    const assetPath = normalizeWorkspaceAssetPath(path, src);
    if (!assetPath) return null;
    return buildWorkspaceRawFileUrl(sourceTarget, assetPath);
  }, [path, sourceTarget]);
  const handleMarkdownViewModeChange = useCallback((nextMode: MarkdownViewMode) => {
    setMarkdownModeState({ mode: nextMode, path });
    setIsFindOpen(false);
  }, [path]);
  const handleMonacoFind = useCallback(() => {
    // Monaco owns source/diff searching, including its match navigation UI.
    setMonacoFindRequest((request) => request + 1);
  }, []);
  const handleFindShortcut = useCallback((event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    if (shouldRenderMarkdownPreview) {
      setIsFindOpen(true);
      return;
    }
    handleMonacoFind();
  }, [handleMonacoFind, shouldRenderMarkdownPreview]);
  // Bound to this view's root rather than window: with two split panels open,
  // only the panel the keystroke happened in must save.
  const handleSaveShortcut = useCallback((event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    if (!editable) return;
    event.preventDefault();
    if (dirty && !saving) {
      void captureTelemetryEvent('keyboard_shortcut_used', { shortcut: 'save-workspace-file' });
      onSave?.();
    }
  }, [dirty, editable, onSave, saving]);
  const handleViewKeyDown = useCallback((event: React.KeyboardEvent) => {
    handleSaveShortcut(event);
    handleFindShortcut(event);
  }, [handleFindShortcut, handleSaveShortcut]);
  const handleViewMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Monaco focuses its hidden textarea during this same event. Taking focus
    // back on the parent after it bubbles makes a file look read-only.
    const target = event.target;
    if (target instanceof Element && target.closest(".monaco-editor")) return;
    event.currentTarget.focus({ preventScroll: true });
  }, []);

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
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        <PendingStateHeader mode={mode} path={path} onClose={onClose} />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        <PendingStateHeader mode={mode} path={path} onClose={onClose} />
        <div className="min-h-0 flex-1">
          <EmptyState
            title="Unable to open file"
            body={error}
            icon="error"
            action={onRetry ? (
              <Button
                {...telemetryClickAttributes('workspace_editor.retry', 'workspace_editor')}
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
                aria-label={`Retry loading ${path}`}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry</span>
              </Button>
            ) : null}
          />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        <PendingStateHeader mode={mode} path={path} onClose={onClose} />
        <div className="min-h-0 flex-1">
          <EmptyState title="No file loaded" body="Select a file to preview it." />
        </div>
      </div>
    );
  }

  if (fileData?.binary && !isImageFile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        <PendingStateHeader mode={mode} path={path} onClose={onClose} />
        <div className="min-h-0 flex-1">
          <EmptyState title="Binary file" body="Preview is unavailable for binary content." icon="binary" />
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)" tabIndex={-1} onMouseDown={handleViewMouseDown} onKeyDown={handleViewKeyDown}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-(--chat-header-border) px-4">
        <div className="flex min-w-0 items-center gap-2">
          {mode === "diff" ? (
            <GitCompare className="h-4 w-4 shrink-0 text-(--text-muted)" />
          ) : isImageFile ? (
            <ImageIcon className="h-4 w-4 shrink-0 text-(--text-muted)" />
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
            <p className="truncate font-mono text-sm text-(--text-primary)">
              {path}
              {dirty ? (
                <span
                  className="ml-1.5 text-(--accent)"
                  aria-label="Unsaved changes"
                  data-testid="workspace-file-dirty"
                >
                  ●
                </span>
              ) : null}
            </p>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
              {mode === "diff" ? "Diff" : isImageFile ? fileData?.mimeType : fileData?.language || "text"}
              {fileData ? ` · ${formatBytes(fileData.size)}` : ""}
              {(!isImageFile && fileData?.truncated) || diffData?.truncated ? " · truncated" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isMarkdownFile ? (
            <MarkdownModeToggle mode={markdownViewMode} onChange={handleMarkdownViewModeChange} />
          ) : null}
          {editable ? (
            <Tooltip content={dirty ? "Save (Ctrl/Cmd+S)" : "No unsaved changes"}>
              <Button
                {...telemetryClickAttributes('workspace_editor.save', 'workspace_editor')}
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2.5"
                onClick={onSave}
                disabled={!dirty || saving}
                aria-label="Save file"
                data-testid="workspace-file-save"
              >
                {saving
                  ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  : <Save className="h-3.5 w-3.5" />}
                <span>Save</span>
              </Button>
            </Tooltip>
          ) : null}
          {showOpenButton ? (
            <Tooltip content="Open">
              <Button
                {...telemetryClickAttributes('workspace_editor.open_host', 'workspace_editor')}
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
          {!isImageFile ? <Tooltip content={copied ? "Copied" : "Copy"}>
            <Button
              {...telemetryClickAttributes('workspace_editor.copy_content', 'workspace_editor')}
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
          </Tooltip> : null}
          <Tooltip content="Copy absolute path">
            <Button
              {...telemetryClickAttributes('workspace_editor.copy_path', 'workspace_editor')}
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
                {...telemetryClickAttributes('workspace_editor.close', 'workspace_editor')}
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
      {conflict ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-(--status-warning-border) bg-(--status-warning-bg) px-4 py-2"
          data-testid="workspace-conflict-banner"
        >
          <p className="text-xs text-(--status-warning-text)">
            This file changed on disk since you opened it. Saving now would overwrite those changes.
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              {...telemetryClickAttributes('workspace_editor.reload', 'workspace_editor')}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onReload}
              data-testid="workspace-conflict-reload"
            >
              Reload and discard
            </Button>
            <Button
              {...telemetryClickAttributes('workspace_editor.overwrite', 'workspace_editor')}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onOverwrite}
              disabled={saving}
              data-testid="workspace-conflict-overwrite"
            >
              Overwrite
            </Button>
            <Button
              {...telemetryClickAttributes('workspace_editor.cancel', 'workspace_editor')}
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onCancelConflict}
              data-testid="workspace-conflict-cancel"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div className={shouldRenderMarkdownPreview ? "relative min-h-0 flex-1 overflow-auto" : "min-h-0 flex-1 overflow-hidden"}>
        {imageRawUrl && fileData ? (
          <WorkspaceImageViewer
            key={imageRawUrl}
            path={path}
            rawUrl={imageRawUrl}
            size={fileData.size}
          />
        ) : shouldRenderMarkdownPreview ? (
          <div ref={markdownContentRef} className="mx-auto w-full max-w-5xl px-6 py-8 text-base">
            <PreviewMarkdown content={content} resolveImageSrc={resolveMarkdownImageSrc} variant="document" />
          </div>
        ) : (
          <WorkspaceMonacoEditor
            content={content}
            language={mode === "diff" ? "git-diff" : fileData?.language}
            mode={mode}
            modelKey={editorModelKey}
            path={path}
            readOnly={!editable}
            onChange={editable ? onDraftChange : undefined}
            findRequest={monacoFindRequest}
          />
        )}
        {shouldRenderMarkdownPreview && isFindOpen ? (
          <WorkspaceFileFind contentRef={markdownContentRef} onClose={() => setIsFindOpen(false)} />
        ) : null}
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
