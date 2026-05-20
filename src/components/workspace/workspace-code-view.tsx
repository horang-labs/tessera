"use client";

import { AlertCircle, Binary, Copy, FileCode2, FileText, GitCompare, LoaderCircle, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type { Highlighter, ThemedToken } from "shiki";
import { PreviewMarkdown } from "@/components/chat/preview-markdown";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { useIsDark } from "@/hooks/use-is-dark";
import {
  getHighlighterInstance,
  highlightCodeToTokens,
} from "@/lib/code-highlighting";
import {
  copyText,
  toAbsoluteWorkspacePath,
} from "@/lib/workspace-tabs/file-path-actions";
import { cn } from "@/lib/utils";
import type { GitDiffData } from "@/types/git";
import type { WorkspaceFileData } from "@/types/workspace-file";

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
  highlightedLines,
  mode,
}: {
  content: string;
  highlightedLines?: ThemedToken[][] | null;
  mode: "file" | "diff";
}) {
  if (mode === "file" && highlightedLines) {
    return <HighlightedCodeLines lines={highlightedLines} />;
  }

  const lines = content.split("\n");
  return (
    <div className="workspace-code-lines">
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.slice(0, 16)}`}
          className={cn(
            "workspace-code-line",
            mode === "diff" ? getDiffLineClassName(line) : "text-(--text-secondary)",
          )}
        >
          <span className="workspace-code-line-number">{index + 1}</span>
          <code className="workspace-code-line-content">{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

function getTokenStyle(token: ThemedToken): CSSProperties | undefined {
  if (token.htmlStyle) {
    return token.htmlStyle;
  }

  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.bgColor) style.backgroundColor = token.bgColor;

  const fontStyle = token.fontStyle ?? 0;
  if ((fontStyle & 1) !== 0) style.fontStyle = "italic";
  if ((fontStyle & 2) !== 0) style.fontWeight = 700;
  if ((fontStyle & 4) !== 0) style.textDecoration = "underline";

  return Object.keys(style).length > 0 ? style : undefined;
}

function HighlightedCodeLines({ lines }: { lines: ThemedToken[][] }) {
  return (
    <div className="workspace-code-lines">
      {lines.map((tokens, lineIndex) => (
        <div className="workspace-code-line" key={lineIndex}>
          <span className="workspace-code-line-number">{lineIndex + 1}</span>
          <code className="workspace-code-line-content">
            {tokens.length > 0
              ? tokens.map((token, tokenIndex) => (
                <span
                  key={`${token.offset}-${tokenIndex}`}
                  style={getTokenStyle(token)}
                >
                  {token.content}
                </span>
              ))
              : " "}
          </code>
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
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const isDark = useIsDark();
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
  const isMarkdownFile = mode === "file" && fileData?.language === "markdown";
  const shikiTheme = isDark ? "github-dark" : "github-light";
  const resolveMarkdownImageSrc = useCallback((src: string): string | null => {
    if (!sourceSessionId || isBrowserImageSrc(src)) return src;
    const assetPath = normalizeWorkspaceAssetPath(path, src);
    if (!assetPath) return null;
    return buildWorkspaceRawFileUrl(sourceSessionId, assetPath);
  }, [path, sourceSessionId]);
  useEffect(() => {
    if (mode !== "file" || isMarkdownFile || fileData?.binary) return undefined;

    let cancelled = false;
    getHighlighterInstance().then((h) => {
      if (!cancelled && h) setHighlighter(h);
    });

    return () => {
      cancelled = true;
    };
  }, [fileData?.binary, isMarkdownFile, mode]);

  const highlightedLines = useMemo(() => {
    if (mode !== "file" || isMarkdownFile || !highlighter) return null;

    try {
      return highlightCodeToTokens(highlighter, content, fileData?.language, shikiTheme);
    } catch {
      return null;
    }
  }, [content, fileData?.language, highlighter, isMarkdownFile, mode, shikiTheme]);

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
      <div className="min-h-0 flex-1 overflow-auto">
        {isMarkdownFile ? (
          <div className="mx-auto w-full max-w-4xl px-6 py-5 text-sm">
            <PreviewMarkdown content={content} resolveImageSrc={resolveMarkdownImageSrc} />
          </div>
        ) : (
          <CodeLines
            content={content}
            highlightedLines={highlightedLines}
            mode={mode}
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
