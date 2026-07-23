"use client";

import {
  AlertCircle,
  BookText,
  Brain,
  Code2,
  Copy,
  Eye,
  LoaderCircle,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PreviewMarkdown } from "@/components/chat/preview-markdown";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceMonacoEditor } from "@/components/workspace/workspace-monaco-editor";
import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { useI18n } from "@/lib/i18n";
import { wsClient } from "@/lib/ws/client";
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { toast } from "@/stores/notification-store";
import {
  buildMemoryFileSessionId,
  type MemoryFileSessionRef,
} from "@/lib/workspace-tabs/special-session";
import type { MemoryFileData, MemoryRootKey } from "@/types/memory";
import type { ServerTransportMessage } from "@/lib/ws/message-types";
import { cn } from "@/lib/utils";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type MemoryViewMode = "preview" | "edit";

interface MemoryFileTabState {
  loading: boolean;
  error: string | null;
  data: MemoryFileData | null;
}

const MEMORY_LOAD_TIMEOUT_MS = 3_000;

function getMemoryFileUrl(ref: MemoryFileSessionRef, root: MemoryRootKey | null): string {
  const sessionId = encodeURIComponent(ref.sourceSessionId);
  const params = new URLSearchParams({ kind: ref.memoryKind });
  params.set("name", ref.fileName);
  if (root) params.set("root", root);
  return `/api/sessions/${sessionId}/memory/file?${params.toString()}`;
}

function shouldRefreshForSession(msg: ServerTransportMessage, sessionId: string): boolean {
  return msg.type === "replay_events"
    && msg.sessionId === sessionId
    && msg.events.some((event) =>
      event.type === "tool_call"
      && event.status === "completed"
      && (event.toolKind === "file_edit" || event.toolKind === "file_write")
    );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

function displayFileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function MemoryViewModeToggle({
  mode,
  t,
  onChange,
}: {
  mode: MemoryViewMode;
  t: Translate;
  onChange: (mode: MemoryViewMode) => void;
}) {
  const buttonClassName = (value: MemoryViewMode) =>
    cn(
      "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors",
      mode === value
        ? "bg-(--chat-bg) text-(--text-primary) shadow-sm"
        : "text-(--text-muted) hover:text-(--text-primary)",
    );

  return (
    <div
      className="flex shrink-0 items-center rounded-md border border-(--divider) bg-(--sidebar-hover) p-0.5"
      role="tablist"
      aria-label={t("memoryPanel.fileTab.viewModeAria")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "preview"}
        className={buttonClassName("preview")}
        onClick={() => onChange("preview")}
        data-testid="memory-mode-preview"
      >
        <Eye className="h-3.5 w-3.5" />
        <span>{t("memoryPanel.fileTab.preview")}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "edit"}
        className={buttonClassName("edit")}
        onClick={() => onChange("edit")}
        data-testid="memory-mode-edit"
      >
        <Code2 className="h-3.5 w-3.5" />
        <span>{t("memoryPanel.fileTab.edit")}</span>
      </button>
    </div>
  );
}

export function MemoryFileTab({
  memoryRef,
  panelId,
  onClose,
  onDirtyChange,
}: {
  memoryRef: MemoryFileSessionRef;
  panelId: string;
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const { fileName, sourceSessionId, memoryKind } = memoryRef;
  const isGuideline = memoryKind !== "memory";
  const panelCount = usePanelStore(
    (state) => Object.keys(selectActiveTab(state)?.panels ?? EMPTY_PANELS).length,
  );
  const closePanel = usePanelStore((state) => state.closePanel);
  const assignSession = usePanelStore((state) => state.assignSession);

  const [state, setState] = useState<MemoryFileTabState>({
    loading: true,
    error: null,
    data: null,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MemoryViewMode>("preview");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const requestSeqRef = useRef(0);
  const activeLoadsRef = useRef(0);
  const dirtyRef = useRef(false);
  // Pin reads and writes to the directory the first load resolved, so a
  // memory folder appearing for the other slug candidate mid-edit cannot
  // silently redirect them (see resolveSessionMemoryDir).
  const rootRef = useRef<MemoryRootKey | null>(null);

  const content = draft ?? state.data?.content ?? "";
  const dirty = state.data !== null && draft !== null && draft !== state.data.content;
  const readOnly = state.data?.readOnly ?? false;
  const visibleFileName = state.data?.fileName ?? displayFileName(fileName);
  dirtyRef.current = dirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (readOnly && viewMode === "edit") setViewMode("preview");
  }, [readOnly, viewMode]);

  // A preview tab gets replaced by the next previewed file without warning;
  // pin it as soon as there are unsaved edits, matching editor conventions.
  useEffect(() => {
    if (!dirty) return;
    const tabStore = useTabStore.getState();
    const location = tabStore.findSessionLocation(
      buildMemoryFileSessionId(sourceSessionId, memoryKind, fileName),
    );
    if (location) tabStore.pinTab(location.tabId);
  }, [dirty, fileName, memoryKind, sourceSessionId]);

  const loadFile = useCallback(async (options?: {
    signal?: AbortSignal;
    silent?: boolean;
  }) => {
    // Never let a background refresh wipe unsaved edits.
    if (options?.silent && (dirtyRef.current || activeLoadsRef.current > 0)) return;

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    if (!options?.silent) {
      setState({ loading: true, error: null, data: null });
      setDraft(null);
      setConflict(false);
    }

    activeLoadsRef.current += 1;
    try {
      const response = await fetchWithTimeout(
        getMemoryFileUrl({ type: "memory-file", sourceSessionId, memoryKind, fileName }, rootRef.current),
        { signal: options?.signal, timeoutMs: MEMORY_LOAD_TIMEOUT_MS, retries: 1 },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null) {
        throw new Error(extractGitPanelErrorMessage(payload, t("memoryPanel.fileTab.loadFallback")));
      }

      if (requestSeqRef.current !== requestSeq) return;
      if (options?.silent && dirtyRef.current) return;
      const data = payload as MemoryFileData;
      rootRef.current = data.root;
      setState({ loading: false, error: null, data });
      setDraft(null);
      setConflict(false);
    } catch (error) {
      if (options?.signal?.aborted || requestSeqRef.current !== requestSeq) return;
      const message = isTimeoutError(error)
        ? t("memoryPanel.fileTab.loadTimedOut")
        : error instanceof Error ? error.message : t("memoryPanel.fileTab.loadFallback");
      if (options?.silent) {
        setState((current) => (
          current.data ? current : { loading: false, error: message, data: null }
        ));
      } else {
        setState({ loading: false, error: message, data: null });
      }
    } finally {
      activeLoadsRef.current -= 1;
    }
  }, [fileName, memoryKind, sourceSessionId, t]);

  useEffect(() => {
    const abortController = new AbortController();
    void loadFile({ signal: abortController.signal });
    return () => abortController.abort();
  }, [loadFile]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const abortController = new AbortController();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        void loadFile({ signal: abortController.signal, silent: true });
      }
    };

    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    return () => {
      abortController.abort();
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
    };
  }, [loadFile]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const abortController = new AbortController();
    const unsubscribe = wsClient.subscribeServerMessages((msg) => {
      if (!shouldRefreshForSession(msg, sourceSessionId)) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadFile({ signal: abortController.signal, silent: true });
      }, 250);
    });

    return () => {
      unsubscribe();
      abortController.abort();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [loadFile, sourceSessionId]);

  const saveFile = useCallback(async (options?: { overwrite?: boolean }) => {
    const data = state.data;
    if (!data || data.readOnly || draft === null || saving) return;

    setSaving(true);
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sourceSessionId)}/memory/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: memoryKind,
            name: fileName,
            content: draft,
            ...(rootRef.current ? { root: rootRef.current } : {}),
            ...(options?.overwrite ? {} : { baseMtimeMs: data.mtimeMs }),
          }),
          timeoutMs: MEMORY_LOAD_TIMEOUT_MS,
        },
      );
      const payload = await response.json().catch(() => null) as
        | { mtimeMs?: number; size?: number; error?: { code?: string; message?: string } }
        | null;
      if (response.status === 409) {
        setConflict(true);
        return;
      }
      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, t("memoryPanel.fileTab.saveFailed")));
      }

      // Invalidate loads started before the save so a stale response cannot
      // overwrite the freshly saved state.
      requestSeqRef.current += 1;
      setState({
        loading: false,
        error: null,
        data: {
          ...data,
          content: draft,
          mtimeMs: payload?.mtimeMs ?? data.mtimeMs,
          size: payload?.size ?? data.size,
        },
      });
      // Only clear the draft when it still equals what was saved — the user
      // may have kept typing while the PUT was in flight.
      setDraft((current) => (current === draft ? null : current));
      setConflict(false);
      toast.success(t("memoryPanel.fileTab.saved", { fileName: data.fileName }));
    } catch (error) {
      const message = isTimeoutError(error)
        ? t("memoryPanel.fileTab.saveTimedOut")
        : error instanceof Error ? error.message : t("memoryPanel.fileTab.saveFailed");
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [draft, fileName, memoryKind, saving, sourceSessionId, state.data, t]);

  // Attached to the tab root (not window) so hidden LRU tabs and split
  // panels without focus never react to another panel's Cmd+S.
  const handleSaveShortcut = useCallback((event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    if (viewMode !== "edit") return;
    event.preventDefault();
    if (dirtyRef.current) void saveFile();
  }, [saveFile, viewMode]);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    if (panelCount >= 2) {
      closePanel(panelId);
    } else {
      assignSession(panelId, null);
    }
  }, [assignSession, closePanel, onClose, panelCount, panelId]);

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t("memoryPanel.fileTab.copied"));
    } catch {
      toast.error(t("memoryPanel.fileTab.copyFailed"));
    }
  }

  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-(--chat-header-border) px-4">
      <div className="flex min-w-0 items-center gap-2">
        {isGuideline ? (
          <BookText className="h-4 w-4 shrink-0 text-(--text-muted)" />
        ) : (
          <Brain className="h-4 w-4 shrink-0 text-(--text-muted)" />
        )}
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-(--text-primary)">
            {visibleFileName}
            {dirty ? <span className="ml-1.5 text-(--accent)" aria-label={t("memoryPanel.fileTab.unsavedChanges")}>●</span> : null}
          </p>
          <p className="truncate text-[10px] uppercase tracking-[0.14em] text-(--text-muted)">
            {memoryKind === "global-guideline"
              ? t("memoryPanel.fileTab.globalGuideline")
              : memoryKind === "project-guideline"
                ? t("memoryPanel.fileTab.projectGuideline")
                : t("memoryPanel.fileTab.memory")}
            {state.data ? ` · ${formatBytes(state.data.size)}` : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {state.data && !readOnly ? (
          <MemoryViewModeToggle mode={viewMode} t={t} onChange={setViewMode} />
        ) : null}
        {viewMode === "edit" && state.data && !readOnly ? (
          <Tooltip content={dirty ? t("memoryPanel.fileTab.saveShortcut") : t("memoryPanel.fileTab.noUnsavedChanges")}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2.5"
              onClick={() => void saveFile()}
              disabled={!dirty || saving}
              aria-label={t("memoryPanel.fileTab.save")}
              data-testid="memory-save-btn"
            >
              {saving
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : <Save className="h-3.5 w-3.5" />}
              <span>{t("memoryPanel.fileTab.save")}</span>
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip content={t("memoryPanel.fileTab.copyContent")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void copyContent()}
            disabled={!content}
            aria-label={t("memoryPanel.fileTab.copyContent")}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("common.close")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleClose}
            aria-label={t("memoryPanel.fileTab.closeMemoryPanel")}
            data-testid="memory-file-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );

  if (state.loading) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      </div>
    );
  }

  if (state.error || !state.data) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-(--divider) bg-(--sidebar-hover)">
              <AlertCircle className="h-5 w-5 text-(--text-muted)" />
            </div>
            <p className="text-sm font-medium text-(--text-primary)">{t("memoryPanel.fileTab.unableToOpenTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              {state.error ?? t("memoryPanel.fileTab.loadFallback")}
            </p>
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadFile()}
                aria-label={t("memoryPanel.fileTab.retryLoading", { fileName: visibleFileName })}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{t("memoryPanel.actions.retry")}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--chat-bg)" onKeyDown={handleSaveShortcut}>
      {header}
      {conflict ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-(--status-warning-border) bg-(--status-warning-bg) px-4 py-2"
          data-testid="memory-conflict-banner"
        >
          <p className="text-xs text-(--status-warning-text)">
            {t("memoryPanel.fileTab.conflictMessage")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void loadFile()}
            >
              {t("memoryPanel.fileTab.reloadDiscard")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void saveFile({ overwrite: true })}
              disabled={saving || readOnly}
            >
              {t("memoryPanel.fileTab.overwrite")}
            </Button>
          </div>
        </div>
      ) : null}
      <div className={viewMode === "preview" ? "min-h-0 flex-1 overflow-auto" : "min-h-0 flex-1 overflow-hidden"}>
        {viewMode === "preview" ? (
          <div className="mx-auto w-full max-w-5xl px-6 py-8 text-base">
            <PreviewMarkdown content={content} variant="document" />
          </div>
        ) : (
          <WorkspaceMonacoEditor
            content={content}
            language="markdown"
            mode="file"
            path={`memory/${sourceSessionId}/${fileName}`}
            readOnly={readOnly}
            onChange={setDraft}
          />
        )}
      </div>
    </div>
  );
}
