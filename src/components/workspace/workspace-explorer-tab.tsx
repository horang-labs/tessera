"use client";

import { AlertCircle, FileText, FolderTree, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { openWorkspaceFileTab } from "@/lib/workspace-tabs/open-workspace-tab";
import type { WorkspaceExplorerSessionRef } from "@/lib/workspace-tabs/special-session";
import { cn } from "@/lib/utils";

interface WorkspaceFilesResponse {
  files?: string[];
  truncated?: boolean;
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function dirname(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(0, slash) : ".";
}

function EmptyState({
  title,
  body,
  icon = "file",
}: {
  title: string;
  body: string;
  icon?: "file" | "error";
}) {
  const Icon = icon === "error" ? AlertCircle : FolderTree;
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

export function WorkspaceExplorerTab({
  explorerRef,
}: {
  explorerRef: WorkspaceExplorerSessionRef;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    const loadFiles = async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(explorerRef.sourceSessionId)}/files`,
          { signal: abortController.signal },
        );
        const payload = (await response.json().catch(() => null)) as WorkspaceFilesResponse | null;
        if (!response.ok) throw new Error("Failed to load files.");
        setFiles(Array.isArray(payload?.files) ? payload.files : []);
        setTruncated(Boolean(payload?.truncated));
      } catch (error) {
        if (abortController.signal.aborted) return;
        setError(error instanceof Error ? error.message : "Failed to load files.");
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    };

    void loadFiles();
    return () => abortController.abort();
  }, [explorerRef.sourceSessionId]);

  const visibleFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files.slice(0, 500);
    return files
      .filter((filePath) => filePath.toLowerCase().includes(trimmed))
      .slice(0, 500);
  }, [files, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <div className="shrink-0 border-b border-(--chat-header-border) px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-(--text-muted)" />
              <h2 className="text-sm font-semibold text-(--text-primary)">Files</h2>
            </div>
            <p className="mt-1 text-xs text-(--text-muted)">
              {files.length.toLocaleString()} files
              {truncated ? " · truncated" : ""}
            </p>
          </div>
          <label className="flex h-9 w-[min(24rem,45vw)] items-center gap-2 rounded-md border border-(--input-border) bg-(--sidebar-bg) px-3 focus-within:border-(--accent)">
            <Search className="h-4 w-4 shrink-0 text-(--text-muted)" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="min-w-0 flex-1 bg-transparent text-sm text-(--text-primary) outline-none placeholder:text-(--text-muted)"
            />
          </label>
        </div>
      </div>

      {loading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : error ? (
        <EmptyState title="Files unavailable" body={error} icon="error" />
      ) : visibleFiles.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No matches" : "No files"}
          body={query.trim() ? "Try another search." : "This workspace has no readable files."}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-5xl py-3">
            {visibleFiles.map((filePath) => (
              <button
                key={filePath}
                type="button"
                onClick={() => openWorkspaceFileTab(explorerRef.sourceSessionId, "file", filePath)}
                className={cn(
                  "grid h-10 w-full grid-cols-[1.5rem_minmax(12rem,1fr)_minmax(12rem,1.5fr)] items-center gap-3 rounded-md px-3 text-left transition-colors",
                  "text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)",
                )}
                title={filePath}
              >
                <FileText className="h-4 w-4 text-(--text-muted)" />
                <span className="truncate font-mono text-xs">{basename(filePath)}</span>
                <span className="truncate text-xs text-(--text-muted)">{dirname(filePath)}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
